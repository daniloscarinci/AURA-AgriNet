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
