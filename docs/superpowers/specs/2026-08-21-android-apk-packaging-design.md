# Packaging AURA-AgriNet as an installable Android app

**Date:** 2026-08-21 · **Status:** approved, ready for planning

## Goal

Produce a sideloadable `.apk` that installs AURA-AgriNet on an Android phone and runs it
exactly as the browser does — including offline from the first launch, before the device
has ever reached a network.

## Decisions already taken

| Question | Answer | Consequence |
|---|---|---|
| How it reaches a device | Sideload an APK | No Play Console, no AAB, no store assets, no review. A debug signing key suffices. |
| Where it is built | Locally | Install a JDK and the Android SDK on this machine. No CI, no remote, no account. |
| Wrapper | An Activity we own, driven by Gradle | No npm, no Capacitor, no hosted origin. |
| Runtime verification | Unavailable | No device and no emulator. The build is verified; the running app is not. |

Two approaches lost, and why they lost:

**Capacitor** would add `package.json` and several hundred npm packages to a repository
whose entire argument is that it has no dependencies and no build step. It also serves the
app from its own `https://localhost` scheme, where service-worker support has been
unreliable — and the service worker *is* the offline story this app is about.

**A Trusted Web Activity** produces the smallest APK and updates without a reinstall, but
it needs the app served from an HTTPS origin with `assetlinks.json` published on it.
Nothing here is hosted. Worse, a TWA's first launch requires a network, so a tool built for
growers would fail in exactly the field where it is needed.

## Non-goals

Play Store distribution, release signing, an iOS build, push notifications, and any change
to the behaviour, layout or copy of the web app itself. The web app ships as it stands;
this work wraps it.

## Architecture

### Repository layout

A single new directory. Nothing at the repository root moves.

```
android/
  settings.gradle.kts
  build.gradle.kts
  gradle.properties
  gradle/libs.versions.toml
  gradle/wrapper/...          gradlew, gradlew.bat
  app/
    build.gradle.kts
    src/main/AndroidManifest.xml
    src/main/java/earth/aura/agrinet/MainActivity.java
    src/main/res/...          icons, theme, strings
```

Identity: package `earth.aura.agrinet`, label `AURA-AgriNet`, `versionCode 1`,
`versionName "1.0"`. `minSdk 24`, `targetSdk 35`, `compileSdk 35`. Java 17 source and
target.

Dependencies stay to three AndroidX artifacts — `webkit` (the asset loader and the
service-worker client), `activity` (the back dispatcher) and `core` (window insets). No
AppCompat, no Material, and no Kotlin: this is roughly two hundred lines of glue, and
writing it in Java removes the whole Kotlin compiler plugin from the build for no
functional loss. Every version is pinned in `gradle/libs.versions.toml`, resolved to the
newest stable release at implementation time.

### How the web app enters the APK

A Gradle `Copy` task reads the repository root and writes it into the module's generated
assets directory, which is registered as an assets source. The web files are therefore
never committed twice: the root remains the single source of truth and `android/` holds no
copy of them.

The task works by **exclusion** — `.git`, `.github`, `.gitignore`, `android`, `docs`,
`tests`, `serve.cmd`, `README.md`, `LICENSE` — rather than by listing what to include. The
direction matters. A new web asset is then bundled by default, so forgetting to update the
build produces a marginally larger APK instead of a file that 404s on a farm.

### Why the service worker keeps working

`WebViewAssetLoader` serves the bundled files from
`https://appassets.androidplatform.net/`. That is a real secure origin rather than
`file://`, so `sw.js` registers, `localStorage` persists, and the cross-origin fetches to
Open-Meteo and NASA GIBS carry an origin those hosts will answer. Every caching strategy
the app already ships — network-first for observations, cache-first for imagery — survives
untouched.

One trap gets wired explicitly. Service-worker requests **bypass**
`WebViewClient.shouldInterceptRequest`. Hand the asset loader only to the `WebViewClient`
and the worker registers and then fails every fetch it makes — a break that appears only
once the device loses signal. The same loader therefore also goes to
`ServiceWorkerControllerCompat`, guarded by a
`WebViewFeature.isFeatureSupported(SERVICE_WORKER_BASIC_USAGE)` check for the oldest
supported devices.

## What the browser supplied, and the wrapper must now replace

| Concern | Implementation | Why it matters here |
|---|---|---|
| Geolocation | `onGeolocationPermissionsShowPrompt` bridged to a runtime `ACCESS_FINE_LOCATION` request, then `callback.invoke(origin, granted, false)` | The ◎ button is the fastest way to reach a location, and silently fails without this. |
| `navigator.onLine` | `ACCESS_NETWORK_STATE` permission | WebView reports "online" permanently without it, so the *Offline · cached* chip would never appear and stale numbers would read as current — the one thing the app promises never to do. |
| Back button | Probe `#manualLayer` and `#simSheet` for the `hidden` attribute; if either is open, dispatch `Escape` to `document` and consume the press; otherwise finish the Activity | The app uses no History API at all, so `canGoBack()` is always false and back would otherwise kill the app with the manual open. The page's own `keydown` handler already resolves innermost-layer-first. |
| Rotation | `android:configChanges` covering orientation, screenSize, smallestScreenSize, screenLayout, keyboardHidden and uiMode | An Activity recreate reloads the app and destroys the driver's map — a bug the README records as already found and fixed once. |
| Dark theme | `WebSettingsCompat.setAlgorithmicDarkeningAllowed(true)` | Makes `prefers-color-scheme` report the system theme. The page declares `color-scheme: light dark`, so Android honours its warm dark palette instead of force-inverting it. |
| Status bar | System-bar insets applied as padding, window painted `#f4efe6` light and `#15120e` dark | `targetSdk 35` forces edge-to-edge, and the colours match the manifest's `theme_color`. |
| External links | `shouldOverrideUrlLoading` sends anything off `appassets.androidplatform.net` to `ACTION_VIEW` | Attribution links belong in a real browser, not inside the console. |

`usesCleartextTraffic` stays `false`; all four data hosts are HTTPS. Storage permissions
are unnecessary.

### Icons

The adaptive launcher icon draws its foreground from the existing
`icons/icon-maskable-512.png` over a solid `#f4efe6` background. A maskable icon already
reserves its safe-zone padding, which is precisely what an adaptive foreground layer
wants, so no image tooling is required. `icons/icon-192.png` serves as the legacy launcher
icon below API 26.

## Tests

Two checks join `tests/assets.test.js`, in the style already established there.

1. **Every `PRECACHE` entry survives the exclude list.** The service worker's precache list
   defines what the app needs offline. A file excluded from the APK but precached by the
   worker would fail `cache.addAll`, which is atomic, and break the install outright.
2. **The two element ids the back handler probes exist.** `#manualLayer` and `#simSheet`
   are named in Java, where no existing test reaches. Rename either in `index.html` and the
   back button silently starts closing the app instead of the dialog.

Both guard the drift the README already documents as this project's characteristic
failure: a claim in one file quietly disagreeing with the code in another.

## Documentation

`.gitignore` today reads `# nothing to ignore — this is a zero-dependency static app`. It
gains `android/build`, `android/app/build`, `android/.gradle` and `local.properties`, and
its comment gains a sentence explaining the change rather than losing the boast silently.

The README gains an **Android** section stating plainly: the web app still has no build
step and no dependencies, the APK has both, Gradle downloads three AndroidX artifacts, and
the offline behaviour survives because the assets are served from a secure origin rather
than `file://`. Same standard the rest of that file holds itself to.

## Verification, and its limits

`gradlew assembleDebug` must succeed and produce `app-debug.apk`. Unpacking the APK must
show every precached file present under `assets/`. `node tests/run.js` must still pass in
full, with the two new checks included.

That proves the project builds and packages correctly. **It does not prove the app runs.**
Service-worker registration, the geolocation prompt, insets, dark mode and the back button
all need a real Android runtime, and no device or emulator is available. The completion
report will say so in these terms rather than implying a working app.

## Risks

The largest risk is the **installed Android System WebView version**, not `minSdk`. WebView
updates independently of the OS, so an API 24 device kept current runs this app well while
a neglected one may not. `minSdk 24` describes what will install, not what will render.

Beyond that: the SDK install is a 1.5–2 GB download; `WebViewAssetLoader` serves nothing if
the copy task and the manifest disagree about the assets path; and the Gradle exclude list
is the one place where a mistake ships a broken offline app rather than a loud build
failure — which is why a test guards it.
