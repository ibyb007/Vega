const {
  withAndroidManifest,
  withAndroidStyles,
} = require('expo/config-plugins');

const withAndroidNativeConfig = config => {
  config = withAndroidManifest(config, manifestConfig => {
    const application = manifestConfig.modResults.manifest.application?.[0];
    if (application?.$) {
      application.$['android:usesCleartextTraffic'] = 'true';
      // Force native libraries to be physically extracted to a real,
      // executable-permitted directory (applicationInfo.nativeLibraryDir)
      // at install time, instead of the modern default of storing them
      // uncompressed inside the APK and mmap'ing them in place. WarpModule
      // needs to `exec()` libusque.so as a subprocess (it's not just
      // dlopen'd), and Android's W^X policy blocks executing anything from
      // app-private storage the app wrote itself (e.g. filesDir) on
      // Android 10+ -- nativeLibraryDir is the one location that's
      // exempted from that restriction, but only when the lib was
      // actually extracted there, which requires this flag.
      application.$['android:extractNativeLibs'] = 'true';
    }

    return manifestConfig;
  });

  return withAndroidStyles(config, config => {
    // Safely access the styles
    const styles = config.modResults;

    // Ensure we have the basic structure
    if (!styles || !styles.resources) {
      return config;
    }

    // Ensure styles.resources.style exists and is an array
    if (!styles.resources.style || !Array.isArray(styles.resources.style)) {
      styles.resources.style = [];
    }

    // Helper function to safely add text color to a style
    const addTextColorToStyle = styleName => {
      // Find the style element
      const styleElement = styles.resources.style.find(
        style => style && style.$ && style.$.name === styleName,
      );

      if (!styleElement) {
        return; // Style not found, skip
      }

      // Ensure item array exists
      if (!styleElement.item || !Array.isArray(styleElement.item)) {
        styleElement.item = [];
      }

      // Check if text color already exists
      const existingTextColor = styleElement.item.find(
        item => item && item.$ && item.$.name === 'android:textColor',
      );

      if (existingTextColor) {
        // Update existing
        existingTextColor._ = '@android:color/white';
      } else {
        // Add new text color item
        styleElement.item.push({
          $: {name: 'android:textColor'},
          _: '@android:color/white',
        });
      }
    };

    // Apply text color to styles
    addTextColorToStyle('AppTheme');
    addTextColorToStyle('ResetEditText');

    return config;
  });
};

module.exports = withAndroidNativeConfig;
