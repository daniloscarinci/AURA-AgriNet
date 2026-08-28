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
        versionCode = 2
        versionName = "1.1"
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
    // Aligns the Kotlin artifacts AndroidX pulls in transitively. See the note in
    // libs.versions.toml: without this, kotlin-stdlib 1.8.22 and kotlin-stdlib-jdk8
    // 1.6.21 both define the same classes and dexing fails.
    implementation(platform(libs.kotlin.bom))

    implementation(libs.androidx.webkit)
    implementation(libs.androidx.activity)
    implementation(libs.androidx.core)
    implementation(libs.androidx.splashscreen)
}

/* The web app is the repository root, and the APK carries a copy of it. That copy
   is never committed: the root stays the single source of truth.

   Note the direction. This excludes what must not ship rather than listing what
   must, so a web asset added next year is bundled by default. The failure mode is
   then a marginally larger APK -- never a file that 404s on a farm with no signal.
   tests/assets.test.js fails if anything sw.js precaches appears below. */
val webAssets = layout.buildDirectory.dir("generated/webassets")

val syncWebAssets = tasks.register<Sync>("syncWebAssets") {
    from(rootProject.layout.projectDirectory.dir("..")) {
        exclude(
            ".git/**", ".github/**", ".gitignore", ".claude/**",
            "android/**", "docs/**", "tests/**",
            // Brainstorming mockups and their server state: gitignored,
            // machine-local, nothing to do with the app. The copy is defined by
            // exclusion, so without this line the only thing keeping them out of
            // the package is aapt discarding dot-prefixed names -- a tool default
            // this project never asked for. Rename it without the dot and it ships.
            ".superpowers/**",
            "serve.cmd", "README.md", "LICENSE",
            // Generates the icons at author time; the app never loads it.
            "icons/build-icons.js"
        )
    }
    into(webAssets)
    includeEmptyDirs = false
}

android.sourceSets["main"].assets.srcDir(webAssets)
tasks.named("preBuild") { dependsOn(syncWebAssets) }

/* The package is otherwise five directories down, inside a gitignored build tree,
   under a name that says neither which app nor which version. Copied out on every
   assemble rather than once by hand: a stale binary that looks current is worse
   than a buried one that is honest.

   It lands beside this build file, in android/, which a Copy task cannot do.
   Gradle fingerprints a copy task's destination directory, and android/ contains
   app/build -- so declaring it as an output puts every AGP output nominally inside
   this task's output, which Gradle rejects as an overlap. A hand-written copy that
   declares no outputs sidesteps the check entirely, which is honest here: the
   input is one file that was just rebuilt, and the work is a single stream copy.

   Paths resolve at configuration time so the action holds no project reference. */
val apkName = "AURA-AgriNet-${android.defaultConfig.versionName}-debug.apk"
val apkSource = layout.buildDirectory.file("outputs/apk/debug/app-debug.apk")
val apkTarget = rootProject.layout.projectDirectory.file(apkName)

val copyApkToAndroidDir = tasks.register("copyApkToAndroidDir") {
    doNotTrackState("writes into the android/ project directory, which holds the build tree")
    doLast {
        apkSource.get().asFile.copyTo(apkTarget.asFile, overwrite = true)
        logger.lifecycle("APK: ${apkTarget.asFile.path}")
    }
}

/* matching{}.configureEach{} rather than named(): AGP creates the per-variant
   assemble tasks after this script body runs, so named("assembleDebug") fails at
   configuration time with "task not found". This collection is live and catches
   the task whenever it appears. (preBuild above is safe because AGP creates that
   one eagerly.) */
tasks.matching { it.name == "assembleDebug" }.configureEach { finalizedBy(copyApkToAndroidDir) }
