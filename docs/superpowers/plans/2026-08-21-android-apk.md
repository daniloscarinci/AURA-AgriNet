# Android APK Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a sideloadable `app-debug.apk` that carries the AURA-AgriNet web app inside it and runs it offline from the first launch.

**Architecture:** A Gradle project in `android/` with one Java Activity. A `Sync` task copies the repository root into the module's generated assets at build time, so the web files are never committed twice. `WebViewAssetLoader` serves those files from `https://appassets.androidplatform.net/` — a real secure origin, which is what keeps `sw.js` registering and the existing offline caching intact.

**Tech Stack:** Gradle 8.9, Android Gradle Plugin 8.7.3, JDK 17, Java 17 source level, `androidx.webkit` 1.12.1, `androidx.activity` 1.9.3, `androidx.core` 1.13.1. `compileSdk`/`targetSdk` 35, `minSdk` 24. No Kotlin, no npm, no AppCompat.

**Spec:** `docs/superpowers/specs/2026-08-21-android-apk-packaging-design.md`

---

## Conventions used by every task below

**Environment prefix.** Shell state does not persist between commands. Every Gradle or SDK
command in this plan begins with this exact prefix, which is self-healing — it uses the
persistent variables if the shell inherited them and rediscovers them if it did not:

```bash
export JAVA_HOME="${JAVA_HOME:-$(ls -d '/c/Program Files/Eclipse Adoptium/jdk-17'* | head -1)}"
export ANDROID_HOME="${ANDROID_HOME:-/c/Users/danil/AppData/Local/Android/Sdk}"
```

**Branch.** All work happens on `android-apk`, which already exists and already holds the
spec commit. Do not create another branch.

**Test command.** `node tests/run.js` from the repository root. It takes no arguments, needs
no network, and must pass in full before every commit that touches `tests/`.

---

## Task 1: Install the toolchain

**Files:**
- Create: `android/local.properties` (untracked — Task 9 adds it to `.gitignore`)

There is no test-first step here: this task installs software on the machine and its only
assertion is that the tools answer when called.

- [ ] **Step 1: Install JDK 17**

```bash
winget install --id EclipseAdoptium.Temurin.17.JDK -e --accept-package-agreements --accept-source-agreements
```

Expected: `Successfully installed`. If winget reports it is already installed, continue.

- [ ] **Step 2: Confirm the JDK answers and record its path**

```bash
export JAVA_HOME="$(ls -d '/c/Program Files/Eclipse Adoptium/jdk-17'* | head -1)"
echo "JAVA_HOME=$JAVA_HOME"
"$JAVA_HOME/bin/java" -version
```

Expected: a path ending in `-hotspot`, then `openjdk version "17.0.x"` on stderr. If the
`ls` finds nothing, the install went elsewhere — locate it with
`ls -d '/c/Program Files/'*/*jdk*` before continuing.

- [ ] **Step 3: Persist JAVA_HOME for future shells**

```bash
cmd //c "setx JAVA_HOME \"$(cygpath -w "$JAVA_HOME")\""
```

Expected: `SUCCESS: Specified value was saved.`

- [ ] **Step 4: Download and unpack the Android command-line tools**

```bash
SDK=/c/Users/danil/AppData/Local/Android/Sdk
mkdir -p "$SDK/cmdline-tools"
curl -L -o /tmp/cmdline-tools.zip https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip
unzip -q -o /tmp/cmdline-tools.zip -d "$SDK/cmdline-tools"
mv "$SDK/cmdline-tools/cmdline-tools" "$SDK/cmdline-tools/latest"
ls "$SDK/cmdline-tools/latest/bin"
```

Expected: the listing shows `sdkmanager.bat` and `avdmanager.bat`. The download is about
130 MB. If `mv` fails because `latest` already exists, the tools are already unpacked —
continue.

- [ ] **Step 5: Persist ANDROID_HOME**

```bash
cmd //c "setx ANDROID_HOME \"C:\\Users\\danil\\AppData\\Local\\Android\\Sdk\""
```

Expected: `SUCCESS: Specified value was saved.`

- [ ] **Step 6: Accept the SDK licences**

```bash
export JAVA_HOME="${JAVA_HOME:-$(ls -d '/c/Program Files/Eclipse Adoptium/jdk-17'* | head -1)}"
export ANDROID_HOME="/c/Users/danil/AppData/Local/Android/Sdk"
yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager.bat" --licenses
```

Expected: several `Accept? (y/N):` prompts answered, ending in
`All SDK package licenses accepted.`

- [ ] **Step 7: Install the platform and build tools**

```bash
export JAVA_HOME="${JAVA_HOME:-$(ls -d '/c/Program Files/Eclipse Adoptium/jdk-17'* | head -1)}"
export ANDROID_HOME="/c/Users/danil/AppData/Local/Android/Sdk"
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager.bat" "platform-tools" "platforms;android-35" "build-tools;35.0.0"
```

Expected: `done` after the downloads. Roughly 700 MB.

- [ ] **Step 8: Verify the platform landed**

```bash
ls /c/Users/danil/AppData/Local/Android/Sdk/platforms/android-35/android.jar
ls /c/Users/danil/AppData/Local/Android/Sdk/build-tools/35.0.0/aapt2.exe
```

Expected: both paths print. If either is missing, re-run Step 7 before continuing.

- [ ] **Step 9: Write `android/local.properties`**

```bash
mkdir -p "C:/Users/danil/Desktop/AURA-AgriNet 1.0/android"
printf 'sdk.dir=C\\:\\\\Users\\\\danil\\\\AppData\\\\Local\\\\Android\\\\Sdk\n' \
  > "C:/Users/danil/Desktop/AURA-AgriNet 1.0/android/local.properties"
cat "C:/Users/danil/Desktop/AURA-AgriNet 1.0/android/local.properties"
```

Expected: `sdk.dir=C\:\\Users\\danil\\AppData\\Local\\Android\\Sdk`

Nothing is committed in this task — `local.properties` names a path that belongs to this
machine alone, and Task 9 tells git to ignore it.

---

## Task 2: A Gradle project that assembles

**Files:**
- Create: `android/settings.gradle.kts`
- Create: `android/build.gradle.kts`
- Create: `android/gradle.properties`
- Create: `android/gradle/libs.versions.toml`
- Create: `android/app/build.gradle.kts`
- Create: `android/app/src/main/AndroidManifest.xml`
- Create: `android/app/src/main/res/values/strings.xml`
- Create: `android/gradle/wrapper/gradle-wrapper.properties`, `android/gradle/wrapper/gradle-wrapper.jar`, `android/gradlew`, `android/gradlew.bat` (generated, Step 7)

This task produces an APK with no Activity in it. That is deliberate: it proves the
toolchain, the plugin versions and the SDK path all agree before any of our own code can
be blamed for a failure.

- [ ] **Step 1: Write `android/settings.gradle.kts`**

```kotlin
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "aura-agrinet"
include(":app")
```

- [ ] **Step 2: Write `android/gradle/libs.versions.toml`**

```toml
# Pinned deliberately. This repository's whole argument is that you can say where
# something came from, and a floating version cannot answer that question.
[versions]
agp = "8.7.3"
webkit = "1.12.1"
activity = "1.9.3"
core = "1.13.1"

[libraries]
androidx-webkit = { module = "androidx.webkit:webkit", version.ref = "webkit" }
androidx-activity = { module = "androidx.activity:activity", version.ref = "activity" }
androidx-core = { module = "androidx.core:core", version.ref = "core" }

[plugins]
android-application = { id = "com.android.application", version.ref = "agp" }
```

- [ ] **Step 3: Write `android/build.gradle.kts`**

```kotlin
plugins {
    alias(libs.plugins.android.application) apply false
}
```

- [ ] **Step 4: Write `android/gradle.properties`**

```properties
org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8
org.gradle.caching=true
android.useAndroidX=true
android.nonTransitiveRClass=true
```

- [ ] **Step 5: Write `android/app/build.gradle.kts`**

```kotlin
plugins {
    alias(libs.plugins.android.application)
}

android {
    namespace = "earth.aura.agrinet"
    compileSdk = 35

    defaultConfig {
        applicationId = "earth.aura.agrinet"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
    }

    // BuildConfig.DEBUG gates remote debugging in MainActivity. Off by default in AGP 8.
    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation(libs.androidx.webkit)
    implementation(libs.androidx.activity)
    implementation(libs.androidx.core)
}
```

- [ ] **Step 6: Write `android/app/src/main/AndroidManifest.xml` and `strings.xml`**

`android/app/src/main/AndroidManifest.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <uses-permission android:name="android.permission.INTERNET" />

    <application
        android:allowBackup="true"
        android:hardwareAccelerated="true"
        android:label="@string/app_name"
        android:usesCleartextTraffic="false" />

</manifest>
```

`android/app/src/main/res/values/strings.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name">AURA-AgriNet</string>
</resources>
```

- [ ] **Step 7: Generate the Gradle wrapper**

There is no Gradle on this machine yet, so download one distribution and use it once to
write the wrapper into the project.

```bash
export JAVA_HOME="${JAVA_HOME:-$(ls -d '/c/Program Files/Eclipse Adoptium/jdk-17'* | head -1)}"
curl -L -o /tmp/gradle-8.9-bin.zip https://services.gradle.org/distributions/gradle-8.9-bin.zip
unzip -q -o /tmp/gradle-8.9-bin.zip -d /c/Users/danil/AppData/Local/gradle-dist
cd "C:/Users/danil/Desktop/AURA-AgriNet 1.0/android"
/c/Users/danil/AppData/Local/gradle-dist/gradle-8.9/bin/gradle.bat wrapper --gradle-version 8.9 --distribution-type bin
ls gradle/wrapper gradlew gradlew.bat
```

Expected: `BUILD SUCCESSFUL`, then a listing showing `gradle-wrapper.jar`,
`gradle-wrapper.properties`, `gradlew` and `gradlew.bat`.

- [ ] **Step 8: Assemble**

```bash
export JAVA_HOME="${JAVA_HOME:-$(ls -d '/c/Program Files/Eclipse Adoptium/jdk-17'* | head -1)}"
export ANDROID_HOME="${ANDROID_HOME:-/c/Users/danil/AppData/Local/Android/Sdk}"
cd "C:/Users/danil/Desktop/AURA-AgriNet 1.0/android" && ./gradlew assembleDebug
```

Expected: `BUILD SUCCESSFUL`. The first run downloads Gradle 8.9, AGP and the AndroidX
artifacts, so it takes a few minutes.

- [ ] **Step 9: Confirm an APK exists**

```bash
ls -la "C:/Users/danil/Desktop/AURA-AgriNet 1.0/android/app/build/outputs/apk/debug/app-debug.apk"
```

Expected: a file of roughly 1–2 MB.

- [ ] **Step 10: Commit**

```bash
cd "C:/Users/danil/Desktop/AURA-AgriNet 1.0"
git add android/settings.gradle.kts android/build.gradle.kts android/gradle.properties \
        android/gradle/libs.versions.toml android/gradlew android/gradlew.bat \
        android/gradle/wrapper android/app/build.gradle.kts android/app/src
git commit -m "A Gradle project that assembles nothing yet, but assembles"
```

`local.properties` and `build/` are not staged. Task 9 makes that automatic; until then,
stage by explicit path as above rather than with `git add -A`.

---

## Task 3: Carry the web app inside the APK

**Files:**
- Modify: `tests/assets.test.js` — append a new suite before the closing `};`
- Modify: `android/app/build.gradle.kts` — append the sync task

The test comes first, and it is the one that matters: it is the only thing standing between
a mistaken exclude pattern and an app that installs, launches, and then fails on a farm with
no signal.

- [ ] **Step 1: Write the failing test**

Open `tests/assets.test.js`. Directly above the final `};` on the last line, insert:

```js
  /* ------------------------------------------------------------------------ */
  /* The APK carries a copy of this directory. The copy is defined by exclusion,
     so the danger is not a forgotten include -- it is an exclude pattern that
     quietly swallows something sw.js precaches. cache.addAll is atomic, so that
     ships an app which installs, launches, and then dies the first time the
     phone loses signal. Cheapest possible guard against the worst failure. */
  suite('assets · android package', () => {
    const GRADLE = 'android/app/build.gradle.kts';

    test('the Android build file exists', () =>
      assert.ok(exists(GRADLE), `${GRADLE} missing — the APK asset copy is undefined`));

    const gradle = exists(GRADLE) ? read(GRADLE) : '';
    const block = gradle.match(/exclude\(([\s\S]*?)\)/);

    test('the Android build declares an asset exclude list', () =>
      assert.ok(block, `no exclude(...) call in ${GRADLE} — what the APK carries is unstated`));

    const excluded = block ? [...block[1].matchAll(/"([^"]+)"/g)].map(m => m[1]) : [];

    test('the exclude list is non-empty', () =>
      assert.greater(excluded.length, 0, 'exclude(...) parsed to nothing'));

    // Gradle uses Ant patterns: ** spans directories, * stops at one.
    const matches = (pattern, file) => {
      const re = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\//g, '\u0000')
        .replace(/\*\*/g, '\u0001')
        .replace(/\*/g, '[^/]*')
        .replace(/\u0000/g, '(?:.*/)?')
        .replace(/\u0001/g, '.*');
      return new RegExp('^' + re + '$').test(file);
    };

    const swSrc = read('sw.js');
    const swList = swSrc.match(/const PRECACHE = \[([\s\S]*?)\]/);
    const precached = swList ? [...swList[1].matchAll(/'([^']+)'/g)].map(m => m[1]) : [];

    precached.forEach(entry => {
      // './' is the navigation root, which the service worker serves from index.html.
      const file = entry === './' ? 'index.html' : entry.replace(/^\.\//, '');
      test(`the APK ships precached ${entry}`, () => {
        const hit = excluded.find(pattern => matches(pattern, file));
        assert.notOk(hit,
          `sw.js precaches ${entry}, but the Android build excludes it via "${hit}" — ` +
          `cache.addAll is atomic, so the installed app would fail offline entirely`);
      });
    });

    test('the build excludes its own output', () =>
      assert.ok(excluded.some(p => matches(p, 'android/app/build/outputs/apk/debug/app-debug.apk')),
        'android/ is not excluded, so the copy task would recurse into its own build directory'));

    test('the build excludes the test suite', () =>
      assert.ok(excluded.some(p => matches(p, 'tests/run.js')),
        'tests/ would ship inside the APK for no reason'));
  });
```

- [ ] **Step 2: Run the tests to verify the new suite fails**

```bash
cd "C:/Users/danil/Desktop/AURA-AgriNet 1.0" && node tests/run.js assets
```

Expected: FAIL. The first failure reads
`no exclude(...) call in android/app/build.gradle.kts — what the APK carries is unstated`,
followed by one failure per precached entry.

- [ ] **Step 3: Add the sync task**

Append to the end of `android/app/build.gradle.kts`:

```kotlin
/* The web app is the repository root, and the APK carries a copy of it. The copy
   is never committed: the root stays the single source of truth.

   Note the direction. This excludes what must not ship rather than listing what
   must, so a web asset added next year is bundled by default. The failure mode is
   then a marginally larger APK -- never a file that 404s on a farm with no signal. */
val webAssets = layout.buildDirectory.dir("generated/webassets")

val syncWebAssets = tasks.register<Sync>("syncWebAssets") {
    from(rootProject.layout.projectDirectory.dir("..")) {
        exclude(
            ".git/**", ".github/**", ".gitignore", ".claude/**",
            "android/**", "docs/**", "tests/**",
            "serve.cmd", "README.md", "LICENSE"
        )
    }
    into(webAssets)
    includeEmptyDirs = false
}

android.sourceSets["main"].assets.srcDir(webAssets)
tasks.named("preBuild") { dependsOn(syncWebAssets) }
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd "C:/Users/danil/Desktop/AURA-AgriNet 1.0" && node tests/run.js
```

Expected: PASS, with a total higher than the previous 597 checks.

- [ ] **Step 5: Rebuild and confirm the assets are inside the APK**

```bash
export JAVA_HOME="${JAVA_HOME:-$(ls -d '/c/Program Files/Eclipse Adoptium/jdk-17'* | head -1)}"
export ANDROID_HOME="${ANDROID_HOME:-/c/Users/danil/AppData/Local/Android/Sdk}"
cd "C:/Users/danil/Desktop/AURA-AgriNet 1.0/android" && ./gradlew assembleDebug
unzip -l app/build/outputs/apk/debug/app-debug.apk | grep 'assets/' | sort -k4
```

Expected: `BUILD SUCCESSFUL`, then a listing containing `assets/index.html`,
`assets/app.css`, `assets/sw.js`, `assets/manifest.webmanifest`, `assets/cities.json`,
`assets/icons/icon-192.png`, `assets/icons/icon-512.png`,
`assets/icons/icon-maskable-512.png`, `assets/icons/apple-touch-icon-180.png`,
`assets/i18n/es.json`, `assets/i18n/fr.json`, `assets/i18n/pt.json`, and the
`assets/i18n/prose/` files. There must be no `assets/tests/`, `assets/docs/` or
`assets/README.md`.

- [ ] **Step 6: Commit**

```bash
cd "C:/Users/danil/Desktop/AURA-AgriNet 1.0"
git add tests/assets.test.js android/app/build.gradle.kts
git commit -m "The APK carries the web app, and a test guards what it leaves out"
```

---

## Task 4: The Activity, the asset loader, and the service worker

**Files:**
- Create: `android/app/src/main/java/earth/aura/agrinet/MainActivity.java`
- Modify: `android/app/src/main/AndroidManifest.xml`

- [ ] **Step 1: Write `MainActivity.java`**

```java
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
   That distinction is the whole reason this class exists in this shape: over
   file:// the service worker refuses to register, localStorage is partitioned,
   and cross-origin fetches carry a null origin that Open-Meteo will not answer.
   Over the asset-loader origin, every caching strategy the web app already ships
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
        settings.setGeolocationEnabled(true);         // the ◎ button; bridged in onCreate below
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
```

- [ ] **Step 2: Register the Activity in the manifest**

Replace the self-closing `<application ... />` element in
`android/app/src/main/AndroidManifest.xml` with:

```xml
    <application
        android:allowBackup="true"
        android:hardwareAccelerated="true"
        android:label="@string/app_name"
        android:usesCleartextTraffic="false">

        <!-- configChanges keeps this Activity alive across rotation. A recreate
             reloads the whole app and destroys the driver's map, which is a bug
             this project already found and fixed once. -->
        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:launchMode="singleTask"
            android:configChanges="orientation|screenSize|smallestScreenSize|screenLayout|keyboardHidden|uiMode|density|fontScale|navigation|keyboard|layoutDirection"
            android:windowSoftInputMode="adjustResize">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>

    </application>
```

- [ ] **Step 3: Build**

```bash
export JAVA_HOME="${JAVA_HOME:-$(ls -d '/c/Program Files/Eclipse Adoptium/jdk-17'* | head -1)}"
export ANDROID_HOME="${ANDROID_HOME:-/c/Users/danil/AppData/Local/Android/Sdk}"
cd "C:/Users/danil/Desktop/AURA-AgriNet 1.0/android" && ./gradlew assembleDebug
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 4: Confirm the Activity is in the package**

```bash
export ANDROID_HOME="${ANDROID_HOME:-/c/Users/danil/AppData/Local/Android/Sdk}"
"$ANDROID_HOME/build-tools/35.0.0/aapt2.exe" dump badging \
  "C:/Users/danil/Desktop/AURA-AgriNet 1.0/android/app/build/outputs/apk/debug/app-debug.apk" \
  | grep -E "package:|launchable-activity:"
```

Expected: `package: name='earth.aura.agrinet' versionCode='1' versionName='1.0'` and
`launchable-activity: name='earth.aura.agrinet.MainActivity'`.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/danil/Desktop/AURA-AgriNet 1.0"
git add android/app/src
git commit -m "A secure origin inside the package, so the service worker still registers"
```

---

## Task 5: Bridge geolocation to a runtime permission

**Files:**
- Modify: `android/app/src/main/java/earth/aura/agrinet/MainActivity.java`
- Modify: `android/app/src/main/AndroidManifest.xml`

- [ ] **Step 1: Add the permissions to the manifest**

In `android/app/src/main/AndroidManifest.xml`, below the existing
`<uses-permission android:name="android.permission.INTERNET" />` line, add:

```xml
    <!-- Without ACCESS_NETWORK_STATE, WebView reports navigator.onLine as true
         forever. The header's "Offline · cached" chip would then never appear and
         a stale reading would present itself as current -- the one thing this app
         promises never to do. -->
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />

    <!-- The ◎ button. Asked for on an explicit tap, never on load. -->
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
```

- [ ] **Step 2: Add the imports to `MainActivity.java`**

Add to the import block, keeping it alphabetical within each group:

```java
import android.Manifest;
import android.content.pm.PackageManager;
import android.webkit.GeolocationPermissions;
import android.webkit.WebChromeClient;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.ContextCompat;
```

- [ ] **Step 3: Add the fields and the permission launcher**

Immediately below the `private WebView webView;` declaration, add:

```java
    private GeolocationPermissions.Callback pendingGeoCallback;
    private String pendingGeoOrigin;

    /* Registered as a field initializer, which runs before onCreate -- the only
       point at which ActivityResultRegistry accepts a registration. */
    private final ActivityResultLauncher<String> locationPermission =
            registerForActivityResult(new ActivityResultContracts.RequestPermission(), granted -> {
                if (pendingGeoCallback != null) {
                    pendingGeoCallback.invoke(pendingGeoOrigin, granted, false);
                    pendingGeoCallback = null;
                    pendingGeoOrigin = null;
                }
            });
```

- [ ] **Step 4: Add the WebChromeClient**

In `onCreate`, immediately after the `webView.setWebViewClient(...)` block and before the
service-worker block, add:

```java
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
                // Hold the callback until Android answers; the page is waiting on it.
                pendingGeoOrigin = origin;
                pendingGeoCallback = callback;
                locationPermission.launch(Manifest.permission.ACCESS_FINE_LOCATION);
            }
        });
```

- [ ] **Step 5: Build**

```bash
export JAVA_HOME="${JAVA_HOME:-$(ls -d '/c/Program Files/Eclipse Adoptium/jdk-17'* | head -1)}"
export ANDROID_HOME="${ANDROID_HOME:-/c/Users/danil/AppData/Local/Android/Sdk}"
cd "C:/Users/danil/Desktop/AURA-AgriNet 1.0/android" && ./gradlew assembleDebug
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 6: Confirm the permissions are declared in the package**

```bash
export ANDROID_HOME="${ANDROID_HOME:-/c/Users/danil/AppData/Local/Android/Sdk}"
"$ANDROID_HOME/build-tools/35.0.0/aapt2.exe" dump permissions \
  "C:/Users/danil/Desktop/AURA-AgriNet 1.0/android/app/build/outputs/apk/debug/app-debug.apk"
```

Expected: all four of `INTERNET`, `ACCESS_NETWORK_STATE`, `ACCESS_FINE_LOCATION` and
`ACCESS_COARSE_LOCATION`.

- [ ] **Step 7: Commit**

```bash
cd "C:/Users/danil/Desktop/AURA-AgriNet 1.0"
git add android/app/src
git commit -m "The locate button reaches Android, and navigator.onLine tells the truth"
```

---

## Task 6: Make the back button close the dialog, not the app

**Files:**
- Modify: `tests/assets.test.js` — append a suite before the closing `};`
- Modify: `android/app/src/main/java/earth/aura/agrinet/MainActivity.java`

The app uses no History API at all — zero calls to `pushState` — so `canGoBack()` is always
false and a plain back press kills the app with the manual open over it. Two element ids
solve that, and those ids live in Java where no existing test reaches. Test first.

- [ ] **Step 1: Write the failing test**

Directly above the final `};` on the last line of `tests/assets.test.js`, insert:

```js
  /* ------------------------------------------------------------------------ */
  /* The Android back button names two element ids in Java, which no other test
     in this suite can see. Rename either one in index.html and back silently
     stops closing the manual and starts closing the app instead. */
  suite('assets · android back button', () => {
    const JAVA = 'android/app/src/main/java/earth/aura/agrinet/MainActivity.java';

    test('MainActivity.java exists', () =>
      assert.ok(exists(JAVA), `${JAVA} missing`));

    const java = exists(JAVA) ? read(JAVA) : '';
    const decl = java.match(/var ids\s*=\s*\[([^\]]*)\]/);

    test('the back handler declares the layer ids it dismisses', () =>
      assert.ok(decl, 'no "var ids=[...]" in MainActivity.java — the back button probes nothing'));

    const ids = decl ? [...decl[1].matchAll(/'([^']+)'/g)].map(m => m[1]) : [];

    test('it probes at least one layer', () =>
      assert.greater(ids.length, 0, 'the id list parsed to nothing'));

    const { markup } = readSource();
    ids.forEach(id => {
      test(`#${id} exists in index.html`, () =>
        assert.includes(markup, `id="${id}"`,
          `MainActivity dismisses #${id} on back, but no such element is in the shell — ` +
          `back would close the app with that layer still open`));
    });

    test('the manual is one of them', () =>
      assert.includes(ids, 'manualLayer', 'back would close the app with the manual open'));

    test('the simulation sheet is one of them', () =>
      assert.includes(ids, 'simSheet', 'back would close the app with the sheet open'));
  });
```

- [ ] **Step 2: Run the tests to verify the new suite fails**

```bash
cd "C:/Users/danil/Desktop/AURA-AgriNet 1.0" && node tests/run.js assets
```

Expected: FAIL with
`no "var ids=[...]" in MainActivity.java — the back button probes nothing`.

- [ ] **Step 3: Add the imports**

Add to the import block of `MainActivity.java`:

```java
import androidx.activity.OnBackPressedCallback;
```

- [ ] **Step 4: Add the dismissal script constant**

Below the `START_URL` constant, add:

```java
    /* The shell registers no history entries, so canGoBack() is always false and
       a plain back press would close the app with the manual open over it. Ask
       the page instead: if either dismissible layer is showing, hand it an Escape
       and let its own keydown handler resolve the innermost one first. */
    private static final String DISMISS_TOP_LAYER =
            "(function(){var ids=['manualLayer','simSheet'];" +
            "var open=ids.some(function(id){var n=document.getElementById(id);return n&&!n.hidden;});" +
            "if(!open)return false;" +
            "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));" +
            "return true;})()";
```

- [ ] **Step 5: Register the back callback**

At the end of `onCreate`, after the `loadUrl` / `restoreState` block, add:

```java
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                webView.evaluateJavascript(DISMISS_TOP_LAYER, value -> {
                    if (!"true".equals(value)) {
                        setEnabled(false);
                        getOnBackPressedDispatcher().onBackPressed();
                    }
                });
            }
        });
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd "C:/Users/danil/Desktop/AURA-AgriNet 1.0" && node tests/run.js
```

Expected: PASS in full.

- [ ] **Step 7: Build**

```bash
export JAVA_HOME="${JAVA_HOME:-$(ls -d '/c/Program Files/Eclipse Adoptium/jdk-17'* | head -1)}"
export ANDROID_HOME="${ANDROID_HOME:-/c/Users/danil/AppData/Local/Android/Sdk}"
cd "C:/Users/danil/Desktop/AURA-AgriNet 1.0/android" && ./gradlew assembleDebug
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 8: Commit**

```bash
cd "C:/Users/danil/Desktop/AURA-AgriNet 1.0"
git add tests/assets.test.js android/app/src
git commit -m "Back closes the manual before it closes the app, and a test holds the two ids together"
```

---

## Task 7: Insets, dark mode, and external links

**Files:**
- Modify: `android/app/src/main/java/earth/aura/agrinet/MainActivity.java`

- [ ] **Step 1: Add the imports**

```java
import android.content.Intent;
import android.content.res.Configuration;
import android.net.Uri;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.WebSettingsCompat;
```

- [ ] **Step 2: Go edge-to-edge and pad for the system bars**

In `onCreate`, immediately after `super.onCreate(savedInstanceState);`, add:

```java
        // targetSdk 35 draws edge-to-edge whether asked to or not, so ask, and
        // then keep the content out from under the bars deliberately.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
```

Then immediately after the `setContentView(webView);` line, add:

```java
        ViewCompat.setOnApplyWindowInsetsListener(webView, (view, windowInsets) -> {
            Insets bars = windowInsets.getInsets(
                    WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.ime());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsetsCompat.CONSUMED;
        });
```

The IME inset is included on purpose: the chat composer sits at the bottom of the shell, and
without it the keyboard would cover the field you are typing into.

- [ ] **Step 3: Let the page decide its own dark theme**

In `onCreate`, immediately after `settings.setBuiltInZoomControls(false);`, add:

```java
        /* Makes prefers-color-scheme report the system setting. The page declares
           color-scheme: light dark and ships its own warm dark palette, so Android
           honours that instead of force-inverting a stylesheet built by hand. */
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
            WebSettingsCompat.setAlgorithmicDarkeningAllowed(settings, true);
        }
```

- [ ] **Step 4: Send external links to a real browser**

Inside the anonymous `WebViewClient` in `onCreate`, below the existing
`shouldInterceptRequest` method, add:

```java
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
```

- [ ] **Step 5: Match the status-bar icons to the theme**

At the end of `onCreate`, after the back-callback registration, add:

```java
        applyBarAppearance();
```

Then add these two methods to the class, below `onSaveInstanceState`:

```java
    /* uiMode is in configChanges, so the system hands us the switch rather than
       recreating the Activity -- which is what keeps the driver's map alive. */
    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        applyBarAppearance();
    }

    /** Dark icons on the oat background, light icons on the bark one. */
    private void applyBarAppearance() {
        boolean night = (getResources().getConfiguration().uiMode
                & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        androidx.core.view.WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(getWindow(), webView);
        controller.setAppearanceLightStatusBars(!night);
        controller.setAppearanceLightNavigationBars(!night);
    }
```

- [ ] **Step 6: Build**

```bash
export JAVA_HOME="${JAVA_HOME:-$(ls -d '/c/Program Files/Eclipse Adoptium/jdk-17'* | head -1)}"
export ANDROID_HOME="${ANDROID_HOME:-/c/Users/danil/AppData/Local/Android/Sdk}"
cd "C:/Users/danil/Desktop/AURA-AgriNet 1.0/android" && ./gradlew assembleDebug
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 7: Commit**

```bash
cd "C:/Users/danil/Desktop/AURA-AgriNet 1.0"
git add android/app/src
git commit -m "Nothing under the status bar, the page's own dark theme, links to a real browser"
```

---

## Task 8: The launcher icon and the window background

**Files:**
- Create: `android/app/src/main/res/drawable-nodpi/ic_launcher_source.png` (copy)
- Create: `android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png` (copy)
- Create: `android/app/src/main/res/drawable/ic_launcher_foreground.xml`
- Create: `android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml`
- Create: `android/app/src/main/res/values/colors.xml`
- Create: `android/app/src/main/res/values-night/colors.xml`
- Create: `android/app/src/main/res/values/themes.xml`
- Modify: `android/app/src/main/AndroidManifest.xml`

- [ ] **Step 1: Copy the existing icons in**

No image tooling is needed. A maskable web icon already reserves its safe-zone padding,
which is exactly what an adaptive foreground layer wants.

```bash
cd "C:/Users/danil/Desktop/AURA-AgriNet 1.0"
mkdir -p android/app/src/main/res/drawable-nodpi android/app/src/main/res/mipmap-xxxhdpi
cp icons/icon-maskable-512.png android/app/src/main/res/drawable-nodpi/ic_launcher_source.png
cp icons/icon-512.png android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png
ls -la android/app/src/main/res/drawable-nodpi android/app/src/main/res/mipmap-xxxhdpi
```

Expected: both files present and non-empty.

- [ ] **Step 2: Write the adaptive foreground**

`android/app/src/main/res/drawable/ic_launcher_foreground.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<!-- An adaptive foreground layer is 108dp, of which only the middle 72dp is
     guaranteed visible under a circular mask. A maskable icon fills 80% of its
     own canvas, so drawing it at 86dp puts its content at roughly 64dp -- inside
     the safe zone, with nothing clipped on a round launcher. -->
<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
    <item>
        <bitmap
            android:src="@drawable/ic_launcher_source"
            android:gravity="center"
            android:width="86dp"
            android:height="86dp" />
    </item>
</layer-list>
```

`android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/aura_icon_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
</adaptive-icon>
```

- [ ] **Step 3: Write the colours and the theme**

`android/app/src/main/res/values/colors.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<!-- The manifest's theme_color and background_color, so the window behind the
     page is the same oat the page paints itself. -->
<resources>
    <color name="aura_background">#f4efe6</color>
    <color name="aura_icon_background">#f4efe6</color>
</resources>
```

`android/app/src/main/res/values-night/colors.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<!-- The dark theme_color. The launcher icon background stays light in both, so
     the mark reads the same on every home screen. -->
<resources>
    <color name="aura_background">#15120e</color>
</resources>
```

`android/app/src/main/res/values/themes.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="Theme.Aura" parent="@android:style/Theme.Material.NoActionBar">
        <item name="android:windowBackground">@color/aura_background</item>
        <item name="android:statusBarColor">@android:color/transparent</item>
        <item name="android:navigationBarColor">@android:color/transparent</item>
    </style>
</resources>
```

- [ ] **Step 4: Point the manifest at both**

In `android/app/src/main/AndroidManifest.xml`, add these two attributes to the
`<application>` element, keeping the existing ones:

```xml
        android:icon="@mipmap/ic_launcher"
        android:theme="@style/Theme.Aura"
```

- [ ] **Step 5: Build**

```bash
export JAVA_HOME="${JAVA_HOME:-$(ls -d '/c/Program Files/Eclipse Adoptium/jdk-17'* | head -1)}"
export ANDROID_HOME="${ANDROID_HOME:-/c/Users/danil/AppData/Local/Android/Sdk}"
cd "C:/Users/danil/Desktop/AURA-AgriNet 1.0/android" && ./gradlew assembleDebug
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 6: Confirm the launcher icon resolved**

```bash
export ANDROID_HOME="${ANDROID_HOME:-/c/Users/danil/AppData/Local/Android/Sdk}"
"$ANDROID_HOME/build-tools/35.0.0/aapt2.exe" dump badging \
  "C:/Users/danil/Desktop/AURA-AgriNet 1.0/android/app/build/outputs/apk/debug/app-debug.apk" \
  | grep -E "application:|icon"
```

Expected: an `application:` line naming `label='AURA-AgriNet'` and an icon path pointing
into `res/`.

- [ ] **Step 7: Commit**

```bash
cd "C:/Users/danil/Desktop/AURA-AgriNet 1.0"
git add android/app/src
git commit -m "The same mark on the home screen, and the same oat behind the page"
```

---

## Task 9: Tell git and the reader what changed

**Files:**
- Modify: `.gitignore`
- Modify: `README.md`

- [ ] **Step 1: Rewrite `.gitignore`**

The file currently reads `# nothing to ignore — this is a zero-dependency static app`.
Replace its entire contents with:

```gitignore
# The web app still has nothing to ignore. The Android wrapper in android/ does:
# Gradle writes build output, and local.properties names an SDK path that belongs
# to one machine and no other.
android/.gradle/
android/build/
android/app/build/
android/local.properties
```

- [ ] **Step 2: Confirm git now ignores the right things**

```bash
cd "C:/Users/danil/Desktop/AURA-AgriNet 1.0" && git status --short
```

Expected: `.gitignore` modified, and **no** untracked `android/build`, `android/app/build`,
`android/.gradle` or `android/local.properties`. `README.md` is still untouched at this
point; Step 3 edits it.

- [ ] **Step 3: Add the README section**

Insert this immediately above the existing `## Licence` heading in `README.md`. The outer
fence below is four backticks so the nested three-backtick block survives; write only what
is inside it.

````markdown
## Android

An installable APK lives in `android/`. It is a wrapper, not a port: the same
`index.html`, `app.css` and `sw.js` that serve the web app are copied into the package and
served from `https://appassets.androidplatform.net/` by `WebViewAssetLoader`. That is a
real secure origin rather than `file://`, so the service worker registers and every caching
strategy described above works unchanged — including a first launch with no network, which
a wrapper around a hosted URL could not manage.

```
cd android
./gradlew assembleDebug        # app/build/outputs/apk/debug/app-debug.apk
```

Install it with `adb install -r app-debug.apk`. It carries the debug signing key, so it is
for testing and sideloading, not for the Play Store.

**This adds a build step and dependencies — to the APK, not to the web app.** The root of
this repository still has neither. `android/` wants JDK 17 and the Android SDK, and Gradle
downloads three AndroidX artifacts: `webkit` for the asset loader, `activity` for the back
dispatcher, `core` for window insets. Every version is pinned in
`android/gradle/libs.versions.toml`.

The wrapper replaces what a browser supplied for free. Geolocation is bridged to a runtime
permission, asked for on a tap as before. `ACCESS_NETWORK_STATE` is granted, without which
WebView reports `navigator.onLine` as true forever and the *Offline · cached* chip would
never appear. Back closes the manual or the simulation sheet before it closes the app,
because the shell registers no history entries and would otherwise exit under an open
dialog. The asset copy is defined by exclusion, so a web file added later ships by default,
and a test fails if anything `sw.js` precaches has been excluded.

**Not yet run on hardware.** It builds, and the package contains what it should. No device
was available, so service-worker registration, the geolocation prompt, the back button and
the insets have not been exercised on a real Android runtime. `chrome://inspect` reaches a
debug build once installed, which is the fastest way to check the first of those.
````

- [ ] **Step 4: Run the full suite**

```bash
cd "C:/Users/danil/Desktop/AURA-AgriNet 1.0" && node tests/run.js
```

Expected: PASS in full. The README is read by `tests/assets.test.js`, so a malformed edit
shows up here.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/danil/Desktop/AURA-AgriNet 1.0"
git add .gitignore README.md
git commit -m "Say what the APK costs, and what has not been tested"
```

---

## Task 10: Final verification

**Files:** none — this task only reads.

- [ ] **Step 1: Build clean from nothing**

```bash
export JAVA_HOME="${JAVA_HOME:-$(ls -d '/c/Program Files/Eclipse Adoptium/jdk-17'* | head -1)}"
export ANDROID_HOME="${ANDROID_HOME:-/c/Users/danil/AppData/Local/Android/Sdk}"
cd "C:/Users/danil/Desktop/AURA-AgriNet 1.0/android" && ./gradlew clean assembleDebug
```

Expected: `BUILD SUCCESSFUL`. A clean build proves the sync task runs from scratch rather
than relying on assets left behind by an earlier run.

- [ ] **Step 2: Confirm every precached file is inside the APK**

```bash
cd "C:/Users/danil/Desktop/AURA-AgriNet 1.0"
APK=android/app/build/outputs/apk/debug/app-debug.apk
unzip -l "$APK" | awk '{print $4}' | grep '^assets/' | sed 's|^assets/||' \
  | LC_ALL=C sort -u > /tmp/in-apk.txt
# './' is the navigation root rather than a file, so it drops out here.
sed -n '/const PRECACHE = \[/,/\]/p' sw.js | grep -oE "'[^']+'" | tr -d "'" \
  | sed 's|^\./||' | grep -v '^$' | LC_ALL=C sort -u > /tmp/precached.txt
comm -23 /tmp/precached.txt /tmp/in-apk.txt
```

Expected: **no output.** Any line printed is a file the service worker precaches that the
APK does not carry, which would fail `cache.addAll` and break offline entirely.

- [ ] **Step 3: Run the full test suite**

```bash
cd "C:/Users/danil/Desktop/AURA-AgriNet 1.0" && node tests/run.js
```

Expected: PASS in full, with a check count above the 597 this repository had before.

- [ ] **Step 4: Confirm the working tree is clean**

```bash
cd "C:/Users/danil/Desktop/AURA-AgriNet 1.0" && git status --short && git log --oneline master..HEAD
```

Expected: no output from `git status`, and a list of the commits made by this plan.

- [ ] **Step 5: Record the APK's size and identity**

```bash
cd "C:/Users/danil/Desktop/AURA-AgriNet 1.0"
ls -la android/app/build/outputs/apk/debug/app-debug.apk
export ANDROID_HOME="${ANDROID_HOME:-/c/Users/danil/AppData/Local/Android/Sdk}"
"$ANDROID_HOME/build-tools/35.0.0/aapt2.exe" dump badging \
  android/app/build/outputs/apk/debug/app-debug.apk | head -5
```

Expected: a file of roughly 2–3 MB, `package: name='earth.aura.agrinet'`,
`versionName='1.0'`.

- [ ] **Step 6: Report honestly**

The completion report must state, in these terms: the APK builds and packages correctly;
service-worker registration, geolocation, insets, dark mode and the back button are
**unverified** because no Android device or emulator was available; and the way to verify
them is `adb install -r app-debug.apk` followed by `chrome://inspect`.

Do not describe the app as working on Android. Describe it as built.

---

## What this plan does not do

Release signing, an app bundle, Play Store metadata, Android app shortcuts mirroring the
manifest's three role shortcuts, and any change to the web app's behaviour or copy. All are
out of scope by the spec, and none is needed to sideload an APK.
