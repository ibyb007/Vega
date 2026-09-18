const fs = require('fs');
const path = require('path');
const {withDangerousMod} = require('expo/config-plugins');

/**
 * Marks video extensions (mp4 in particular -- see assets/bootsplash/
 * splash.mp4, played by AnimatedBootSplash.tsx via a local require()) as
 * "store, don't compress" when Android packages them into the APK.
 *
 * Without this, aapt compresses bundled asset files by default. Images
 * happen to survive that fine, but react-native-video's Android player
 * (ExoPlayer) opens local/bundled sources via a raw file descriptor +
 * byte offset into the APK's assets zip -- which only works for entries
 * stored uncompressed. A compressed entry fails to open, so the player
 * fires its error callback almost immediately. This is *only* visible in
 * an installed/release-style build: the Metro dev server instead serves
 * the asset over HTTP, which sidesteps APK packaging entirely and hides
 * the bug there.
 */
module.exports = function withAndroidVideoNoCompress(config) {
  return withDangerousMod(config, [
    'android',
    async cfg => {
      const projectRoot = cfg.modRequest.projectRoot;
      const appDir = path.join(projectRoot, 'android', 'app');
      const buildGradle = path.join(appDir, 'build.gradle');
      const helperGradle = path.join(appDir, 'with-video-nocompress.gradle');

      const helperContent = `// Auto-applied by with-android-video-nocompress config plugin
if (project.android) {
  project.android {
    aaptOptions {
      noCompress += ['mp4', 'mov', 'webm']
    }
  }
}
`;
      fs.writeFileSync(helperGradle, helperContent, 'utf8');

      let gradleText = fs.readFileSync(buildGradle, 'utf8');
      if (!gradleText.includes("apply from: 'with-video-nocompress.gradle'")) {
        gradleText += `\napply from: 'with-video-nocompress.gradle'\n`;
        fs.writeFileSync(buildGradle, gradleText, 'utf8');
      }

      return cfg;
    },
  ]);
};
