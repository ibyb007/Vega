// src/lib/services/PlayerLauncher.ts
import * as IntentLauncher from 'expo-intent-launcher';
import { Linking, Alert, Platform } from 'react-native';

export type PlayerChoice = 'exoplayer' | 'vlc' | 'external';

// Builds the same rich `extra` bundle (title + every header variant a
// receiving player might look for) that the original mobile app's
// `openExternalPlayer` in SeasonList.tsx already sends -- many streams
// need Referer/User-Agent headers to actually play, and VLC/other players
// look for these under several different extra keys.
const buildExtra = (title: string, headers?: Record<string, string>) => {
  const extra: Record<string, any> = { title, 'android.intent.extra.TITLE': title };

  if (headers && Object.keys(headers).length > 0) {
    Object.assign(extra, headers);
    extra['android.media.intent.extra.HTTP_HEADERS'] = headers;
    extra.headers = headers;
    extra.headers_array = Object.entries(headers).map(([k, v]) => `${k}: ${v}`);

    const referer = headers['Referer'] || headers['referer'];
    if (referer) {
      extra['android.intent.extra.REFERRER'] = referer;
      extra['android.intent.extra.REFERRER_NAME'] = referer;
    }
  }

  return extra;
};

export const launchVideo = async (
  streamUrl: string,
  title: string,
  player: PlayerChoice = 'exoplayer',
  headers?: Record<string, string>
) => {
  if (player === 'exoplayer') {
    return false; // Tells the view to render the internal react-native-video player
  }

  if (Platform.OS !== 'android') {
    Linking.openURL(streamUrl);
    return true;
  }

  if (player === 'vlc') {
    // Try to target VLC directly first (skips the chooser when it works).
    // IMPORTANT: this explicit-package attempt is unreliable in practice --
    // pairing an explicit `packageName` with a wildcard `type: 'video/*'`
    // fails to resolve on a number of real Android TV / VLC builds even
    // when VLC is installed, because explicit-component intent resolution
    // doesn't go through VLC's manifest `<data>` mime-matching the same
    // way an implicit intent does. The original (working) mobile app's
    // `openExternalPlayer` never sets `packageName` at all -- it sends a
    // plain implicit VIEW intent and lets Android resolve it -- so that's
    // the fallback here, and it's what actually needs to succeed.
    try {
      await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
        data: streamUrl,
        type: 'video/*',
        flags: 1,
        packageName: 'org.videolan.vlc',
        extra: buildExtra(title, headers),
      });
      return true;
    } catch {
      try {
        await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
          data: streamUrl,
          type: 'video/*',
          flags: 1,
          extra: buildExtra(title, headers),
        });
        return true;
      } catch {
        Alert.alert('Error', 'No compatible external video player found on this device.');
        return false;
      }
    }
  }

  return launchGenericExternal(streamUrl, title, headers);
};

const launchGenericExternal = async (
  streamUrl: string,
  title: string,
  headers?: Record<string, string>
) => {
  try {
    await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
      data: streamUrl,
      type: 'video/*',
      flags: 1,
      extra: buildExtra(title, headers),
    });
    return true;
  } catch {
    Alert.alert('Error', 'No compatible external video player found on this device.');
    return false;
  }
};
