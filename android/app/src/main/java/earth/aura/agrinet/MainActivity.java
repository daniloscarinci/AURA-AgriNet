package earth.aura.agrinet;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.net.Uri;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.GeolocationPermissions;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import android.graphics.Color;
import android.webkit.JavascriptInterface;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.splashscreen.SplashScreen;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.webkit.ServiceWorkerClientCompat;
import androidx.webkit.ServiceWorkerControllerCompat;
import androidx.webkit.WebSettingsCompat;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewFeature;

/* AURA-AgriNet, wrapped for Android.

   This is a wrapper, not a port. The same index.html, app.css and sw.js that
   serve the web app are copied into the package by syncWebAssets and served from
   https://appassets.androidplatform.net/ -- a real secure origin, not file://.
   That distinction is the whole reason this class has the shape it does. Over
   file:// the service worker refuses to register, localStorage is partitioned,
   and cross-origin fetches carry a null origin that Open-Meteo will not answer.
   Over the asset-loader origin every caching strategy the web app already ships
   works unchanged, and the first launch needs no network at all. */
public class MainActivity extends ComponentActivity {

    private static final String APP_HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + APP_HOST + "/index.html";

    /* The shell registers no history entries at all, so canGoBack() is always
       false and a plain back press would close the app with the manual open over
       it. Ask the page instead: if either dismissible layer is showing, hand it an
       Escape and let its own keydown handler resolve the innermost one first.
       Dispatching rather than closing directly keeps that ordering in one place.
       tests/assets.test.js checks both ids still exist in index.html. */
    private static final String DISMISS_TOP_LAYER =
            "(function(){var ids=['manualLayer','simSheet','detailSheet'];"
            + "var open=ids.some(function(id){var n=document.getElementById(id);return n&&!n.hidden;});"
            + "if(!open)return false;"
            + "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));"
            + "return true;})()";

    /* Android can freeze or kill this process the moment the screen goes off, and
       the page's own visibilitychange is not guaranteed to run first. Its periodic
       snapshot is twenty seconds wide, so without this a grower can lose the farm
       they just searched for. State is a top-level binding in the shipped script,
       which a global eval can reach; the fallback dispatches the same pagehide the
       web app already saves on, so neither path depends on the other holding.
       tests/assets.test.js runs this exact string against the real script. */
    private static final String SAVE_ON_PAUSE =
            "try{State.save()}catch(e){"
            + "try{window.dispatchEvent(new Event('pagehide'))}catch(e2){}}";

    /** A load that never commits must not leave the user staring at a splash. */
    private static final long SPLASH_TIMEOUT_MS = 4000L;

    /* Which theme the PAGE resolved to, as opposed to what the phone is set to.
       null until the page has said. See applyBarAppearance(). */
    private Boolean pageDark = null;

    /* The two grounds, kept in step with --plane by tests/assets.test.js. */
    private static final int GROUND_LIGHT = 0xFFFBF9F5;
    private static final int GROUND_DARK  = 0xFF15120E;

    private WebView webView;
    private boolean firstPaint;

    private GeolocationPermissions.Callback pendingGeoCallback;
    private String pendingGeoOrigin;

    /* Registered as a field initializer, which runs during construction -- the
       last moment at which ActivityResultRegistry still accepts a registration. */
    private final ActivityResultLauncher<String> locationPermission =
            registerForActivityResult(new ActivityResultContracts.RequestPermission(), granted -> {
                if (pendingGeoCallback != null) {
                    pendingGeoCallback.invoke(pendingGeoOrigin, granted, false);
                    pendingGeoCallback = null;
                    pendingGeoOrigin = null;
                }
            });

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        /* Installed before super.onCreate, which is the only point the system
           accepts it, and held until the shell paints. Otherwise tapping the icon
           shows a blank window while a 320 KB document is parsed -- on a modest
           phone that is long enough to look broken. */
        SplashScreen splash = SplashScreen.installSplashScreen(this);
        splash.setKeepOnScreenCondition(() -> !firstPaint);

        super.onCreate(savedInstanceState);

        // targetSdk 35 draws edge to edge whether asked to or not, so ask, and then
        // keep the content out from under the bars deliberately.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

        final WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .setDomain(APP_HOST)
                .addPathHandler("/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        webView = new WebView(this);
        webView.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(webView);

        /* The IME inset is included on purpose. The chat composer sits at the
           bottom of the shell, and without it the keyboard covers the field you
           are typing into. */
        ViewCompat.setOnApplyWindowInsetsListener(webView, (view, windowInsets) -> {
            Insets bars = windowInsets.getInsets(
                    WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.ime());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsetsCompat.CONSUMED;
        });

        /* The page tells us which theme it actually painted. Without this the bars
           were dressed from the phone's night mode, so choosing Light on a dark
           phone drew white status-bar icons over a white header -- the app and
           the phone disagreeing about the same strip of screen.

           A one-way channel carrying one boolean, from a page served out of this
           APK's own assets. */
        webView.addJavascriptInterface(new Object() {
            @JavascriptInterface
            public void themeResolved(final boolean dark) {
                runOnUiThread(() -> {
                    pageDark = dark;
                    applyBarAppearance();
                });
            }
        }, "AuraHost");

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);          // localStorage: the app's own data cache
        settings.setGeolocationEnabled(true);         // the locate button, bridged below
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setSupportZoom(false);               // the page sets its own viewport
        settings.setBuiltInZoomControls(false);

        /* Never let the WebView darken the page. Allowing it was meant to make
           prefers-color-scheme report the system setting, on the assumption that
           a page declaring color-scheme: light dark would be left to paint its
           own dark theme. On a phone in night mode it instead darkened whatever
           the page painted -- including the light theme a reader had just chosen
           on purpose. Dark mode looked fine because darkening something already
           dark changes little; light mode came out dark, which is exactly the
           bug that was reported.

           The cost is that prefers-color-scheme inside this WebView now reports
           light whatever the phone is set to, so "match system" cannot read it.
           pushSystemTheme() hands the real setting to the page instead. */
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
            WebSettingsCompat.setAlgorithmicDarkeningAllowed(settings, false);
        }

        // No device was available to test this on, so leave the door open: with a
        // debug build installed, chrome://inspect reaches the running page.
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            /* The first pixels of the shell are on screen. Not onPageFinished:
               that waits for every subresource, long after there is something
               worth looking at. */
            @Override
            public void onPageCommitVisible(WebView view, String url) {
                firstPaint = true;
                pushSystemTheme();
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (APP_HOST.equals(uri.getHost())) {
                    return false;
                }
                // Attribution links belong in a browser, not inside the console.
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                } catch (Exception ignored) {
                    // No browser installed. Refusing to navigate is still correct.
                }
                return true;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin,
                                                           GeolocationPermissions.Callback callback) {
                boolean granted = ContextCompat.checkSelfPermission(
                        MainActivity.this, Manifest.permission.ACCESS_FINE_LOCATION)
                        == PackageManager.PERMISSION_GRANTED;
                if (granted) {
                    callback.invoke(origin, true, false);
                    return;
                }
                // Hold the callback until Android answers. The page is waiting on it.
                pendingGeoOrigin = origin;
                pendingGeoCallback = callback;
                locationPermission.launch(Manifest.permission.ACCESS_FINE_LOCATION);
            }
        });

        /* Service-worker requests bypass WebViewClient.shouldInterceptRequest
           entirely. Hand the loader only to the WebViewClient and sw.js registers
           and then fails every fetch it makes -- a break that shows up nowhere
           except on a phone that has lost signal, which is the one place this app
           is supposed to work. So the same loader goes here too. */
        if (WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_BASIC_USAGE)) {
            ServiceWorkerControllerCompat.getInstance().setServiceWorkerClient(
                    new ServiceWorkerClientCompat() {
                        @Override
                        public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                            return assetLoader.shouldInterceptRequest(request.getUrl());
                        }
                    });
        }

        if (savedInstanceState == null) {
            webView.loadUrl(START_URL);
        } else {
            webView.restoreState(savedInstanceState);
        }

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                webView.evaluateJavascript(DISMISS_TOP_LAYER, value -> {
                    if (!"true".equals(value)) {
                        // Nothing was open, so let the press mean what it usually means.
                        setEnabled(false);
                        getOnBackPressedDispatcher().onBackPressed();
                    }
                });
            }
        });

        applyBarAppearance();

        // Belt and braces: release the splash even if the load never commits.
        webView.postDelayed(() -> firstPaint = true, SPLASH_TIMEOUT_MS);
    }

    /* Save before pausing, not after: onPause() stops the page's JavaScript, and a
       snippet handed to a stopped engine never runs. */
    @Override
    protected void onPause() {
        webView.evaluateJavascript(SAVE_ON_PAUSE, null);
        webView.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.onResume();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    /* uiMode is in configChanges, so the system hands us the switch rather than
       recreating the Activity -- which is what keeps the driver's map alive. */
    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        applyBarAppearance();
        pushSystemTheme();
    }

    /* Tell the page what the system is set to. Theme is a top-level binding in
       the shipped script, which a global eval reaches -- the same route
       SAVE_ON_PAUSE takes, and tests/assets.test.js runs this exact string
       against the real script for the same reason: it is a Java string that no
       compiler checks. Wrapped in try/catch because it also runs on a
       configuration change that arrives before the page exists. */
    private void pushSystemTheme() {
        boolean night = (getResources().getConfiguration().uiMode
                & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        webView.evaluateJavascript(
                "try{Theme.systemIsDark(" + night + ")}catch(e){}", null);
    }

    /** Dark icons on the paper background, light icons on the bark one.

        Driven by the theme the PAGE resolved to whenever it has told us, and only
        by the phone's night mode before that -- during the splash, and on any
        build of the shell too old to have the channel. The reader can hold a
        light theme on a dark phone, and these bars belong to what they are
        looking at rather than to what the phone is set to. */
    private void applyBarAppearance() {
        boolean dark = (pageDark != null) ? pageDark
                : (getResources().getConfiguration().uiMode
                   & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(getWindow(), webView);
        controller.setAppearanceLightStatusBars(!dark);
        controller.setAppearanceLightNavigationBars(!dark);

        /* The window is edge to edge and the WebView is padded away from the
           bars, so the strip behind each one shows the WINDOW, not the page. Left
           at the theme default it was a dark band above and below a light app.
           Painting it the page's own ground closes the seam. */
        int ground = dark ? GROUND_DARK : GROUND_LIGHT;
        getWindow().getDecorView().setBackgroundColor(ground);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
    }
}
