import React, { useState, useRef } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import Video, { VideoRef } from 'react-native-video';
import * as IntentLauncher from 'expo-intent-launcher';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { TVFocusablePressable } from '../../components/tv/TVFocusablePressable';

interface TVPlayerScreenProps {
  streamUrl: string;
  title: string;
  headers?: Record<string, string>;
  onClose: () => void;
}

export const TVPlayerScreen: React.FC<TVPlayerScreenProps> = ({
  streamUrl,
  title,
  headers,
  onClose,
}) => {
  const videoRef = useRef<VideoRef>(null);
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(true);

  // Open stream in VLC or Just Player via Android Intent
  const openInExternalPlayer = async () => {
    try {
      await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
        data: streamUrl,
        type: 'video/*',
      });
    } catch (err) {
      console.warn('Failed to launch external player intent:', err);
    }
  };

  return (
    <View style={styles.container}>
      <Video
        ref={videoRef}
        source={{ uri: streamUrl, headers }}
        style={StyleSheet.absoluteFillObject}
        resizeMode="contain"
        paused={paused}
        onLoadStart={() => setLoading(true)}
        onLoad={() => setLoading(false)}
        onError={(err) => console.error('Video Player Error:', err)}
        controls={false}
      />

      {loading && (
        <View style={styles.loader}>
          <ActivityIndicator size="large" color="#8A5CF6" />
        </View>
      )}

      {/* Top TV OSD Bar */}
      <View style={styles.topBar}>
        <Text numberOfLines={1} style={styles.title}>
          {title}
        </Text>
        <TVFocusablePressable
          scaleFocused={1.1}
          focusedBorderColor="#8A5CF6"
          borderRadius={8}
          onPress={openInExternalPlayer}
          style={styles.vlcButton}
        >
          {({ focused }) => (
            <View style={styles.vlcInner}>
              <MaterialCommunityIcons name="vlc" size={18} color="#FFFFFF" />
              <Text style={styles.vlcText}>External Player</Text>
            </View>
          )}
        </TVFocusablePressable>
      </View>

      {/* Bottom TV OSD Controls */}
      <View style={styles.bottomBar}>
        <TVFocusablePressable
          hasTVPreferredFocus={true}
          scaleFocused={1.15}
          focusedBorderColor="#8A5CF6"
          borderRadius={24}
          onPress={() => setPaused(!paused)}
          style={styles.playButton}
        >
          {({ focused }) => (
            <MaterialCommunityIcons
              name={paused ? 'play' : 'pause'}
              size={28}
              color="#FFFFFF"
            />
          )}
        </TVFocusablePressable>
        <TVFocusablePressable
          scaleFocused={1.1}
          focusedBorderColor="#8A5CF6"
          borderRadius={8}
          onPress={onClose}
          style={styles.closeButton}
        >
          {({ focused }) => (
            <Text style={styles.closeText}>Exit Player</Text>
          )}
        </TVFocusablePressable>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  loader: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  topBar: {
    position: 'absolute',
    top: 24,
    left: 48,
    right: 48,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    zIndex: 10,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '700',
    maxWidth: '70%',
  },
  vlcButton: {
    backgroundColor: 'rgba(255,255,255,0.15)',
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  vlcInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  vlcText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
  bottomBar: {
    position: 'absolute',
    bottom: 32,
    left: 48,
    right: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    zIndex: 10,
  },
  playButton: {
    backgroundColor: '#8A5CF6',
    width: 48,
    height: 48,
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeButton: {
    backgroundColor: 'rgba(255,255,255,0.15)',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  closeText: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
});
