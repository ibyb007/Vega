const fs = require('fs');
const path = require('path');
const {withDangerousMod, withGradleProperties} = require('expo/config-plugins');

/**
 * Size trimming that has no runtime effect:
 *  - never build/package x86 / x86_64 native libs (TV boxes are ARM; the
 *    libtorrent4j x86_64 AAR and RN's x86 builds only add dead weight)
 *  - drop non-English library resource tables (app UI is English-only)
 *  - drop duplicated license/metadata files and Kotlin/coroutines debug
 *    leftovers from the APK
 * extractNativeLibs stays true elsewhere on purpose (libusque / libciadpi
 * must be exec()'d from nativeLibraryDir).
 *
 * DO NOT exclude "kotlin/**", "**\/*.kotlin_builtins", "**\/*.kotlin_metadata"
 * or "META-INF/*.kotlin_module": kotlin-reflect (pulled in by
 * expo-modules-core) reads those at runtime. Stripping them makes the app
 * throw "Built-in class kotlin.* is not found" while native modules are
 * registered, so JS never starts and the app hangs on the launch logo. They
 * only save a few hundred KB.
 */
const GRADLE = `// Auto-applied by with-apk-size config plugin
android {
  androidResources {
    localeFilters += ["en"]
  }
  packaging {
    jniLibs {
      excludes += ["**/x86/**", "**/x86_64/**", "**/mips/**", "**/mips64/**"]
    }
    resources {
      excludes += [
        "META-INF/LICENSE*", "META-INF/NOTICE*", "META-INF/DEPENDENCIES",
        "META-INF/AL2.0", "META-INF/LGPL2.1",
        "META-INF/versions/**", "META-INF/proguard/**",
        "DebugProbesKt.bin", "kotlin-tooling-metadata.json"
      ]
    }
  }
}
`;

module.exports = function withApkSize(config) {
  config = withGradleProperties(config, cfg => {
    const set = (key, value) => {
      const e = cfg.modResults.find(i => i.type === 'property' && i.key === key);
      if (e) e.value = value;
      else cfg.modResults.push({type: 'property', key, value});
    };
    set('reactNativeArchitectures', 'armeabi-v7a,arm64-v8a');
    set('android.enableShrinkResourcesInReleaseBuilds', 'true');
    return cfg;
  });

  return withDangerousMod(config, [
    'android',
    async cfg => {
      const appDir = path.join(cfg.modRequest.projectRoot, 'android', 'app');
      fs.writeFileSync(path.join(appDir, 'with-apk-size.gradle'), GRADLE, 'utf8');
      const file = path.join(appDir, 'build.gradle');
      let text = fs.readFileSync(file, 'utf8');
      if (!text.includes("apply from: 'with-apk-size.gradle'")) {
        text = text.trimEnd() + "\n\napply from: 'with-apk-size.gradle'\n";
        fs.writeFileSync(file, text, 'utf8');
      }
      return cfg;
    },
  ]);
};
