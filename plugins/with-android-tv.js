// plugins/with-android-tv.js
const { withAndroidManifest } = require('@expo/config-plugins');

module.exports = function withAndroidTV(config) {
  return withAndroidManifest(config, async (config) => {
    const androidManifest = config.modResults.manifest;

    // Ensure uses-feature list exists
    if (!androidManifest['uses-feature']) {
      androidManifest['uses-feature'] = [];
    }

    // Touchscreen is not required for Android TV
    androidManifest['uses-feature'].push({
      $: {
        'android:name': 'android.hardware.touchscreen',
        'android:required': 'false',
      },
    });

    // Leanback requirement
    androidManifest['uses-feature'].push({
      $: {
        'android:name': 'android.software.leanback',
        'android:required': 'false',
      },
    });

    // Add LEANBACK_LAUNCHER intent filter to MainActivity
    const mainActivity = androidManifest.application[0].activity.find(
      (a) => a.$['android:name'] === '.MainActivity'
    );

    if (mainActivity) {
      if (!mainActivity['intent-filter']) {
        mainActivity['intent-filter'] = [];
      }
      mainActivity['intent-filter'].push({
        action: [{ $: { 'android:name': 'android.intent.action.MAIN' } }],
        category: [{ $: { 'android:name': 'android.intent.category.LEANBACK_LAUNCHER' } }],
      });
      mainActivity.$['android:screenOrientation'] = 'sensorLandscape';
    }

    return config;
  });
};
