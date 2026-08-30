import React, { useRef, useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  ToastAndroid,
} from 'react-native';
import Video, { VideoRef } from 'react-native-video';
import * as IntentLauncher from 'expo-intent-launcher';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { TVFocusablePressable } from '../../components/tv/TVFocusablePressable';
import { useSettingsStore } from '../../lib/zustand/settingsStore';

interface TVPlayerScreenProps {
  streamUrl: string;
  title: string;
  onClose: () => void;
}

export const TVPlayerScreen: React.FC<TVPlayerScreenProps> = ({
  streamUrl,
  title,
  onClose,
}) => {
  const videoRef = useRef<VideoRef>(null);
  const defaultPlayer = useSettingsStore((state) => state.defaultPlayer);
  const [paused, setPaused] = useState(false);
  const [buffering, setBuffering] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [showControls, setShowControls] = useState(true);

  useEffect(() => {
    if (defaultPlayer === 'vlc' || defaultPlayer === 'external') {
      launchExternalPlayer(streamUrl, title);
    }
  }, [defaultPlayer, streamUrl]);

  const launchExternalPlayer = async (url: string, mediaTitle: string) => {
    try {
      await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
        data: url,
        type: 'video/*',
        extra: {
          title: mediaTitle,
        },
      });
    } catch (e) {
      ToastAndroid.show('No external video player found. Falling back to internal player.', ToastAndroid.LONG);
    }
  };

  const handleSeek = (deltaSeconds: number) => {
    const next = Math.max(0, Math.min(duration, currentTime + deltaSeconds));
    videoRef.current?.seek(next);
    setCurrentTime(next);
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  };

  return (
    <View style={styles.container}>
      <Video
        ref={videoRef}
        source={{ uri: streamUrl }}
        style={StyleSheet.absoluteFill}
        resizeMode="contain"
        paused={paused}
        onLoad={(meta) => {
          setDuration(meta.duration);
          setBuffering(false);
        }}
        onProgress={(prog) => setCurrentTime(prog.currentTime)}
        onBuffer={(buf) => setBuffering(buf.isBuffering)}
        onError={(err) => {
          ToastAndroid.show(`Playback error: ${err.error?.errorString || 'Cannot play stream'}`, ToastAndroid.LONG);
          setBuffering(false);
        }}
      />

      {buffering && (
        <View style={styles.centerOverlay}>
          <ActivityIndicator size="large" color="#8A5CF6" />
        </View>
      )}

      {showControls && (
        <View style={styles.osdContainer}>
          <View style={styles.topBar}>
            <Text numberOfLines={1} style={styles.mediaTitle}>
              {title}
            </Text>
            <TVFocusablePressable
              scaleFocused={1.1}
              focusedBorderColor="#8A5CF6"
              borderRadius={8}
              onPress={() => launchExternalPlayer(streamUrl, title)}
              style={styles.extBtn}
            >
              {() => (
                <View style={styles.btnRow}>
                  <MaterialCommunityIcons name="open-in-app" size={18} color="#FFFFFF" />
                  <Text style={styles.extBtnText}>Open External</Text>
                </View>
              )}
            </TVFocusablePressable>
          </View>

          <View style={styles.bottomBar}>
            <View style={styles.progressRow}>
              <Text style={styles.timeText}>{formatTime(currentTime)}</Text>
              <View style={styles.progressBarBackground}>
                <View
                  style={[
                    styles.progressBarFill,
                    { width: duration > 0 ? `${(currentTime / duration) * 100}%` : '0%' },
                  ]}
                />
              </View>
              <Text style={styles.timeText}>{formatTime(duration)}</Text>
            </View>

            <View style={styles.controlButtons}>
              <TVFocusablePressable
                scaleFocused={1.15}
                focusedBorderColor="#8A5CF6"
                borderRadius={20}
                onPress={() => handleSeek(-10)}
                style={styles.circleBtn}
              >
                {() => <MaterialCommunityIcons name="rewind-10" size={24} color="#FFFFFF" />}
              </TVFocusablePressable>

              <TVFocusablePressable
                hasTVPreferredFocus={true}
                scaleFocused={1.15}
                focusedBorderColor="#8A5CF6"
                borderRadius={24}
                onPress={() => setPaused(!paused)}
                style={styles.playBtn}
              >
                {() => (
                  <MaterialCommunityIcons
                    name={paused ? 'play' : 'pause'}
                    size={28}
                    color="#FFFFFF"
                  />
                )}
              </TVFocusablePressable>

              <TVFocusablePressable
                scaleFocused={1.15}
                focusedBorderColor="#8A5CF6"
                borderRadius={20}
                onPress={() => handleSeek(10)}
                style={styles.circleBtn}
              >
                {() => <MaterialCommunityIcons name="fast-forward-10" size={24} color="#FFFFFF" />}
              </TVFocusablePressable>

              <TVFocusablePressable
                scaleFocused={1.15}
                focusedBorderColor="#EF4444"
                borderRadius={20}
                onPress={onClose}
                style={styles.closeBtn}
              >
                {() => <MaterialCommunityIcons name="close" size={24} color="#FFFFFF" />}
              </TVFocusablePressable>
            </View>
          </View>
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  centerOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
  },
  osdContainer: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'space-between',
    padding: 36,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
  },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  mediaTitle: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '800',
    maxWidth: '75%',
  },
  extBtn: {
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  btnRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  extBtnText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  bottomBar: {
    gap: 16,
  },
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  timeText: {
    color: '#D1D5DB',
    fontSize: 13,
    fontWeight: '600',
    width: 44,
    textAlign: 'center',
  },
  progressBarBackground: {
    flex: 1,
    height: 5,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#8A5CF6',
  },
  controlButtons: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 20,
  },
  circleBtn: {
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    padding: 10,
  },
  playBtn: {
    backgroundColor: '#8A5CF6',
    padding: 12,
  },
  closeBtn: {
    backgroundColor: 'rgba(239, 68, 68, 0.3)',
    padding: 10,
  },
});
