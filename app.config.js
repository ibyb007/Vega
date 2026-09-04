const fs = require('fs');
const path = require('path');

const tmdbApiKey =
  process.env.TMDB_API_KEY || process.env.EXPO_PUBLIC_TMDB_API_KEY || '';
const proxyApiUrl =
  process.env.PROXY_API_URL ||
  process.env.EXPO_PUBLIC_PROXY_API_URL ||
  process.env.META_PROXY_URL ||
  '';

module.exports = () => {
  const plugins = [
    './plugins/with-android-tv.js',
    './plugins/withKeyEvent.js',
    './plugins/with-custom-native-modules.js',
    './plugins/android-native-config.js',
    './plugins/with-saf-copy-module.js',
    './plugins/with-uri-permission-module.js',
    './plugins/with-proguard-rules.js',
    './plugins/with-jvm-args.js',
    './plugins/with-android-release-gradle.js',
    './plugins/with-android-signing.js',
    './plugins/with-android-okhttp.js',
    [
      'react-native-video',
      {
        enableNotificationControls: false,
        enableAndroidPictureInPicture: false,
        androidExtensions: {
          useExoplayerRtsp: true,
          useExoplayerSmoothStreaming: true,
          useExoplayerHls: true,
          useExoplayerDash: true,
        },
      },
    ],
    'react-native-edge-to-edge',
    './plugins/with-dynamic-launcher-splash.js',
    [
      'react-native-bootsplash',
      {
        assetsDir: 'assets/bootsplash',
        android: {
          parentTheme: 'EdgeToEdge',
        },
      },
    ],
    [
      'expo-build-properties',
      {
        android: {
          usePrecompiledHeaders: true,
          enableProguardInReleaseBuilds: true,
          splits: {
            abi: { enable: true, universalApk: false },
          },
          buildVariants: {
            release: {
              minifyEnabled: true,
              shrinkResources: true,
              splits: {
                abi: {
                  enable: true,
                  reset: true,
                  include: ['armeabi-v7a', 'arm64-v8a'],
                },
              },
            },
            debug: { minifyEnabled: false, debuggable: true },
          },
        },
        ios: {},
      },
    ],
    [
      'expo-dev-client',
      {
        launchMode: 'most-recent',
      },
    ],
    'expo-font',
    'expo-status-bar',
  ];

  return {
    expo: {
      name: 'Vega TV',
      scheme: 'com.vega',
      displayName: 'Vega TV',
      icon: './assets/icon.png',
      jsEngine: 'hermes',
      newArchEnabled: true,
      autolinking: { exclude: ['expo-splash-screen'] },
      plugins,
      slug: 'vega',
      version: '4.0.5',
      userInterfaceStyle: 'dark',
      experiments: {
        reactCompiler: true,
      },
      android: {
        isTV: true,
        minSdkVersion: 28,
        package: 'com.vega',
        versionCode: 191,
        permissions: [
          'ACCESS_NETWORK_STATE',
          'INTERNET',
          'WRITE_SETTINGS',
        ],
        blockedPermissions: [
          'android.permission.MANAGE_EXTERNAL_STORAGE',
          'android.permission.READ_EXTERNAL_STORAGE',
          'android.permission.READ_MEDIA_VIDEO',
          'android.permission.WRITE_EXTERNAL_STORAGE',
        ],
        queries: [
          { action: 'VIEW', data: { scheme: 'http' } },
          { action: 'VIEW', data: { scheme: 'https' } },
          { action: 'VIEW', data: { scheme: 'vlc' } },
          { action: 'VIEW', data: { mimeType: 'video/*' } },
        ],
        allowBackup: true,
        adaptiveIcon: {
          foregroundImage: './assets/adaptive_icon.png',
          backgroundColor: '#000000',
        },
        launchMode: 'singleTask',
        supportsPictureInPicture: false,
      },
      platforms: ['android'],
      extra: {
        tmdbApiKey,
        proxyApiUrl,
      },
    },
  };
};
