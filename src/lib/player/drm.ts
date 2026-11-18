import type {StreamDrm} from '../providers/types';

/**
 * Provider DRM config -> react-native-video `source.drm`.
 *
 * ClearKey is delivered to ExoPlayer as a `data:` license URI that holds the
 * JSON license response ({"keys":[{kty,k,kid}]}). The react-native-video patch
 * (patches/react-native-video+6.19.2.patch) answers those requests locally
 * through LocalMediaDrmCallback instead of doing a network round trip, so
 * static ClearKey channels (e.g. LiveTG TV) work without a license server.
 */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const hexToBytes = (hex: string): number[] | null => {
  if (!/^[0-9a-f]{32}$/i.test(hex)) {
    return null;
  }
  const out: number[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    out.push(parseInt(hex.slice(i, i + 2), 16));
  }
  return out;
};

const bytesToBase64 = (bytes: number[]): string => {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += b === undefined ? '=' : B64[(n >> 6) & 63];
    out += c === undefined ? '=' : B64[n & 63];
  }
  return out;
};

const toBase64Url = (hex: string): string | null => {
  const bytes = hexToBytes(hex);
  if (!bytes) {
    return null;
  }
  return bytesToBase64(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
};

// The license JSON only contains ASCII (base64url keys), so char codes == bytes.
const asciiToBase64 = (text: string): string =>
  bytesToBase64(Array.from(text, ch => ch.charCodeAt(0)));

/** Builds the ClearKey JSON license response ExoPlayer/MediaDrm expects. */
export const buildClearKeyLicense = (
  clearKeys: Record<string, string>,
): string | null => {
  const keys: {kty: 'oct'; k: string; kid: string}[] = [];
  for (const [kidHex, keyHex] of Object.entries(clearKeys || {})) {
    const kid = toBase64Url(kidHex);
    const k = toBase64Url(keyHex);
    if (!kid || !k) {
      return null;
    }
    keys.push({kty: 'oct', k, kid});
  }
  if (!keys.length) {
    return null;
  }
  return JSON.stringify({keys, type: 'temporary'});
};

export interface VideoDrm {
  type: 'widevine' | 'playready' | 'clearkey' | 'fairplay';
  licenseServer?: string;
  headers?: Record<string, string>;
  multiDrm?: boolean;
  contentId?: string;
  certificateUrl?: string;
  base64Certificate?: boolean;
}

/** Returns the react-native-video drm prop, or undefined when unsupported. */
export const toVideoDrm = (drm?: StreamDrm | null): VideoDrm | undefined => {
  if (!drm || !drm.type) {
    return undefined;
  }

  if (drm.type === 'clearkey') {
    if (drm.clearKeys && Object.keys(drm.clearKeys).length) {
      const license = buildClearKeyLicense(drm.clearKeys);
      if (!license) {
        return undefined;
      }
      return {
        type: 'clearkey',
        licenseServer: `data:application/json;base64,${asciiToBase64(license)}`,
      };
    }
    if (drm.licenseServer) {
      return {
        type: 'clearkey',
        licenseServer: drm.licenseServer,
        headers: drm.headers,
      };
    }
    return undefined;
  }

  if (drm.type === 'widevine' || drm.type === 'playready') {
    if (!drm.licenseServer) {
      return undefined;
    }
    return {
      type: drm.type,
      licenseServer: drm.licenseServer,
      headers: drm.headers,
      multiDrm: drm.multiDrm,
    };
  }

  // FairPlay is iOS only; this is an Android TV app.
  return undefined;
};

/** Provider values that serve live channels (no resume position / duration). */
const LIVE_PROVIDERS = new Set(['liveTgTv', 'durbinLive']);

export const isLiveProvider = (providerValue?: string | null): boolean =>
  !!providerValue && LIVE_PROVIDERS.has(providerValue);
