// src/lib/services/PlayerLauncher.ts
import * as IntentLauncher from 'expo-intent-launcher';
import { Linking, Alert, Platform } from 'react-native';

export type PlayerChoice = 'exoplayer' | 'vlc' | 'external';

export const launchVideo = async (
  streamUrl: string,
  title: string,
  player: PlayerChoice = 'exoplayer'
) => {
  if (player === 'exoplayer') {
    return false; // Tells the view to render the internal react-native-video player
  }

  if (Platform.OS !== 'android') {
    Linking.openURL(streamUrl);
    return true;
  }

  if (player === 'vlc') {
    try {
      await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
        data: streamUrl,
        type: 'video/*',
        packageName: 'org.videolan.vlc',
        extra: {
          title: title,
          return_result: true,
        },
      });
      return true;
    } catch {
      // Fallback if VLC package is not directly found
      return launchGenericExternal(streamUrl, title);
    }
  }

  return launchGenericExternal(streamUrl, title);
};

const launchGenericExternal = async (streamUrl: string, title: string) => {
  try {
    await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
      data: streamUrl,
      type: 'video/*',
      extra: {
        title: title,
      },
    });
    return true;
  } catch {
    Alert.alert('Error', 'No compatible external video player found on this device.');
    return false;
  }
};
