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
    // Aligns the Kotlin artifacts AndroidX pulls in transitively. See the note in
    // libs.versions.toml: without this, kotlin-stdlib 1.8.22 and kotlin-stdlib-jdk8
    // 1.6.21 both define the same classes and dexing fails.
    implementation(platform(libs.kotlin.bom))

    implementation(libs.androidx.webkit)
    implementation(libs.androidx.activity)
    implementation(libs.androidx.core)
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
            "serve.cmd", "README.md", "LICENSE"
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

   It lands in dist/ rather than the repository root, and that is not tidiness.
   Gradle fingerprints a copy task's whole destination directory, so the root as a
   destination means hashing .git -- which fails outright on the files git holds
   open. Worse, declaring the root as an output makes every other task's output sit
   nominally inside this one, and Gradle rejects the overlap. A directory that
   contains nothing else avoids both.

   The name is resolved at configuration time rather than inside rename {}, which
   would reach back into the project while the task runs. */
val distApkName = "AURA-AgriNet-${android.defaultConfig.versionName}-debug.apk"

val copyApkToDist = tasks.register<Copy>("copyApkToDist") {
    from(layout.buildDirectory.file("outputs/apk/debug/app-debug.apk"))
    into(rootProject.layout.projectDirectory.dir("../dist"))
    rename { distApkName }
}

/* matching{}.configureEach{} rather than named(): AGP creates the per-variant
   assemble tasks after this script body runs, so named("assembleDebug") fails at
   configuration time with "task not found". This collection is live and catches
   the task whenever it appears. (preBuild above is safe because AGP creates that
   one eagerly.) */
tasks.matching { it.name == "assembleDebug" }.configureEach { finalizedBy(copyApkToDist) }
