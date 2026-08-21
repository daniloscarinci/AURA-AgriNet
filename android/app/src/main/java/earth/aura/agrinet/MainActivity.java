package earth.aura.agrinet;

import android.Manifest;
import android.content.pm.PackageManager;
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
import androidx.webkit.ServiceWorkerClientCompat;
import androidx.webkit.ServiceWorkerControllerCompat;
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
            "(function(){var ids=['manualLayer','simSheet'];"
            + "var open=ids.some(function(id){var n=document.getElementById(id);return n&&!n.hidden;});"
            + "if(!open)return false;"
            + "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));"
            + "return true;})()";

    private WebView webView;

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
        super.onCreate(savedInstanceState);

        final WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .setDomain(APP_HOST)
                .addPathHandler("/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        webView = new WebView(this);
        webView.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);          // localStorage: the app's own data cache
        settings.setGeolocationEnabled(true);         // the locate button, bridged below
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setSupportZoom(false);               // the page sets its own viewport
        settings.setBuiltInZoomControls(false);

        // No device was available to test this on, so leave the door open: with a
        // debug build installed, chrome://inspect reaches the running page.
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
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
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }
}
