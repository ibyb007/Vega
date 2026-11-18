const fs = require('fs');
const path = require('path');
const {withDangerousMod} = require('expo/config-plugins');

/**
 * Static ClearKey support for react-native-video (Android).
 *
 * react-native-video only does ClearKey through an HTTP license server. The JS
 * side (src/lib/player/drm.ts) hands ClearKey streams over as a `data:` license
 * URI holding the JSON license response, and this plugin makes DRMManager.kt
 * answer those requests locally with LocalMediaDrmCallback.
 *
 * Done as a prebuild string edit rather than a patch-package patch so it can't
 * break on whitespace/line-ending changes. Idempotent; fails the build loudly if
 * react-native-video's source no longer matches.
 */
const MARKER = 'vega-static-clearkey';

const IMPORT_ANCHOR = 'import androidx.media3.common.util.Util\n';
const IMPORTS =
  'import android.util.Base64\n' +
  'import androidx.media3.common.C\n' +
  IMPORT_ANCHOR;

const IMPORT_ANCHOR_2 = 'import androidx.media3.exoplayer.drm.HttpMediaDrmCallback\n';
const IMPORTS_2 =
  IMPORT_ANCHOR_2 +
  'import androidx.media3.exoplayer.drm.LocalMediaDrmCallback\n' +
  'import androidx.media3.exoplayer.drm.MediaDrmCallback\n';

const CALLBACK_START = 'val drmCallback = HttpMediaDrmCallback(';
const CALLBACK_END = 'val mediaDrm = FrameworkMediaDrm.newInstance(uuid)';

const CALLBACK_BLOCK = `// ${MARKER}
            val licenseServer = drmProps.drmLicenseServer
            val drmCallback: MediaDrmCallback =
                if (uuid == C.CLEARKEY_UUID && licenseServer != null && licenseServer.startsWith("data:")) {
                    val comma = licenseServer.indexOf(',')
                    val payload = if (comma >= 0) licenseServer.substring(comma + 1) else ""
                    val isBase64 = comma > 0 && licenseServer.substring(0, comma).contains(";base64")
                    val response = if (isBase64) {
                        Base64.decode(payload, Base64.DEFAULT)
                    } else {
                        java.net.URLDecoder.decode(payload, "UTF-8").toByteArray(Charsets.UTF_8)
                    }
                    LocalMediaDrmCallback(response)
                } else {
                    val httpCallback = HttpMediaDrmCallback(licenseServer, dataSourceFactory)
                    val keyRequestPropertiesArray = drmProps.drmLicenseHeader
                    for (i in keyRequestPropertiesArray.indices step 2) {
                        httpCallback.setKeyRequestProperty(keyRequestPropertiesArray[i], keyRequestPropertiesArray[i + 1])
                    }
                    httpCallback
                }

            `;

module.exports = function withClearKeyDrm(config) {
  return withDangerousMod(config, [
    'android',
    async cfg => {
      const file = path.join(
        cfg.modRequest.projectRoot,
        'node_modules/react-native-video/android/src/main/java/com/brentvatne/exoplayer/DRMManager.kt',
      );
      if (!fs.existsSync(file)) {
        throw new Error(`with-clearkey-drm: ${file} not found`);
      }
      // Normalise CRLF so the anchors match regardless of checkout settings.
      let src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
      if (src.includes(MARKER)) {
        return cfg;
      }
      const start = src.indexOf(CALLBACK_START);
      const end = src.indexOf(CALLBACK_END);
      if (
        start < 0 ||
        end < start ||
        !src.includes(IMPORT_ANCHOR) ||
        !src.includes(IMPORT_ANCHOR_2)
      ) {
        throw new Error(
          'with-clearkey-drm: react-native-video DRMManager.kt changed; update plugins/with-clearkey-drm.js',
        );
      }
      src = src.slice(0, start) + CALLBACK_BLOCK + src.slice(end);
      src = src.replace(IMPORT_ANCHOR, IMPORTS).replace(IMPORT_ANCHOR_2, IMPORTS_2);
      fs.writeFileSync(file, src);
      return cfg;
    },
  ]);
};
