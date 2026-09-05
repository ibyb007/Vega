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
    // The previous version tried an explicit `packageName: 'org.videolan.vlc'`
    // intent first. That's now removed: it's still not launching VLC even
    // though it's confirmed installed, which points at Android TV's VLC
    // build simply not exposing a matching explicit-component intent
    // filter (some TV ports of VLC only register the Leanback launcher
    // activity, not a generic ACTION_VIEW handler reachable by package
    // name) -- no combination of intent flags fixes that from our side.
    // Going straight to the plain implicit intent below, exactly like the
    // original (working) mobile app's `openExternalPlayer`, is the
    // reliable path: Android resolves it against every installed app's
    // manifest-declared `<data>` filters rather than requiring a specific
    // package to match, so it reaches VLC (or shows a chooser, if more
    // than one compatible player is installed) instead of silently
    // failing to resolve.
    try {
      await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
        data: streamUrl,
        type: 'video/*',
        flags: 1,
        extra: buildExtra(title, headers),
      });
      return true;
    } catch (error: any) {
      Alert.alert(
        'Error',
        `Could not open an external player.${error?.message ? `\n\n${error.message}` : ''}`
      );
      return false;
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
