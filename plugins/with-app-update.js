const fs = require('fs');
const path = require('path');
const { withAndroidManifest, withDangerousMod } = require('expo/config-plugins');

// Manifest + resource pieces the in-app updater needs to hand a downloaded
// APK to the system installer: the REQUEST_INSTALL_PACKAGES permission and a
// FileProvider exposing cache/updates/ (see AppUpdateModule.kt).
const FILE_PATHS_XML = `<?xml version="1.0" encoding="utf-8"?>
<paths>
  <cache-path name="vega_updates" path="updates/" />
</paths>
`;

const withUpdateManifest = (config) =>
  withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;

    if (!manifest['uses-permission']) manifest['uses-permission'] = [];
    const perm = 'android.permission.REQUEST_INSTALL_PACKAGES';
    if (!manifest['uses-permission'].some((p) => p.$['android:name'] === perm)) {
      manifest['uses-permission'].push({ $: { 'android:name': perm } });
    }

    const app = manifest.application[0];
    if (!app.provider) app.provider = [];
    const authority = '${applicationId}.updatefileprovider';
    if (!app.provider.some((p) => p.$['android:authorities'] === authority)) {
      app.provider.push({
        $: {
          'android:name': 'androidx.core.content.FileProvider',
          'android:authorities': authority,
          'android:exported': 'false',
          'android:grantUriPermissions': 'true',
        },
        'meta-data': [
          {
            $: {
              'android:name': 'android.support.FILE_PROVIDER_PATHS',
              'android:resource': '@xml/vega_update_file_paths',
            },
          },
        ],
      });
    }
    return cfg;
  });

const withUpdateResources = (config) =>
  withDangerousMod(config, [
    'android',
    async (cfg) => {
      const xmlDir = path.join(
        cfg.modRequest.projectRoot,
        'android',
        'app',
        'src',
        'main',
        'res',
        'xml',
      );
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.writeFileSync(path.join(xmlDir, 'vega_update_file_paths.xml'), FILE_PATHS_XML, 'utf8');
      return cfg;
    },
  ]);

module.exports = function withAppUpdate(config) {
  config = withUpdateManifest(config);
  config = withUpdateResources(config);
  return config;
};
