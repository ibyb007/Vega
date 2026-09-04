const { withAndroidManifest } = require('@expo/config-plugins');

module.exports = function withAndroidTV(config) {
  return withAndroidManifest(config, async (config) => {
    const androidManifest = config.modResults.manifest;

    if (!androidManifest['uses-feature']) {
      androidManifest['uses-feature'] = [];
    }

    // Touchscreen is not required for TV
    androidManifest['uses-feature'].push({
      $: {
        'android:name': 'android.hardware.touchscreen',
        'android:required': 'false',
      },
    });

    // Declare Leanback software support
    androidManifest['uses-feature'].push({
      $: {
        'android:name': 'android.software.leanback',
        'android:required': 'false',
      },
    });

    // Reference the Leanback launcher banner (res/drawable-*/tv_banner.png)
    // on the <application> tag -- without this the launcher row has no
    // artwork to show even once the banner PNGs are in place under res/.
    androidManifest.application[0].$['android:banner'] = '@drawable/tv_banner';

    // Add LEANBACK_LAUNCHER category to MainActivity
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
