package earth.aura.agrinet;

import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.activity.ComponentActivity;
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

    private WebView webView;

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
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }
}
