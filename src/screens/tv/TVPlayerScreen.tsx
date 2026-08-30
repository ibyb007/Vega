import React, { useRef, useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  ToastAndroid,
  Modal,
} from 'react-native';
import Video, { VideoRef, SelectedTrackType } from 'react-native-video';
import * as IntentLauncher from 'expo-intent-launcher';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { TVFocusablePressable } from '../../components/tv/TVFocusablePressable';
import { useSettingsStore } from '../../lib/zustand/settingsStore';

interface TVPlayerScreenProps {
  streamUrl: string;
  title: string;
  headers?: Record<string, string>;
  onClose: () => void;
}

type AspectRatioMode = 'contain' | 'cover' | 'stretch';

export const TVPlayerScreen: React.FC<TVPlayerScreenProps> = ({
  streamUrl,
  title,
  headers,
  onClose,
}) => {
  const videoRef = useRef<VideoRef>(null);
  const defaultPlayer = useSettingsStore((state) => state.defaultPlayer);

  const [paused, setPaused] = useState(false);
  const [buffering, setBuffering] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [showControls, setShowControls] = useState(true);

  // Video Track & Display states
  const [resizeMode, setResizeMode] = useState<AspectRatioMode>('contain');
  const [audioTracks, setAudioTracks] = useState<any[]>([]);
  const [textTracks, setTextTracks] = useState<any[]>([]);
  const [selectedAudio, setSelectedAudio] = useState<any>({ type: SelectedTrackType.INDEX, value: 0 });
  const [selectedSub, setSelectedSub] = useState<any>({ type: SelectedTrackType.DISABLED });

  // Dialog States
  const [dialogType, setDialogType] = useState<'audio' | 'subtitle' | null>(null);

  useEffect(() => {
    if (defaultPlayer === 'vlc' || defaultPlayer === 'external') {
      launchExternalPlayer(streamUrl, title);
    }
  }, [defaultPlayer, streamUrl]);

  const launchExternalPlayer = async (url: string, mediaTitle: string) => {
    try {
      const extra: Record<string, any> = { title: mediaTitle };

      if (headers && Object.keys(headers).length > 0) {
        Object.assign(extra, headers);
        extra['android.media.intent.extra.HTTP_HEADERS'] = headers;
        extra.headers = headers;

        const referer = headers['Referer'] || headers['referer'];
        if (referer) {
          extra['android.intent.extra.REFERRER'] = referer;
        }
      }

      await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
        data: url,
        type: 'video/*',
        extra,
      });
    } catch {
      ToastAndroid.show('No external player found. Falling back to internal player.', ToastAndroid.LONG);
    }
  };

  const handleSeek = (deltaSeconds: number) => {
    const next = Math.max(0, Math.min(duration, currentTime + deltaSeconds));
    videoRef.current?.seek(next);
    setCurrentTime(next);
  };

  const toggleAspectRatio = () => {
    if (resizeMode === 'contain') {
      setResizeMode('cover');
      ToastAndroid.show('Aspect Ratio: Crop (16:9)', ToastAndroid.SHORT);
    } else if (resizeMode === 'cover') {
      setResizeMode('stretch');
      ToastAndroid.show('Aspect Ratio: Stretch', ToastAndroid.SHORT);
    } else {
      setResizeMode('contain');
      ToastAndroid.show('Aspect Ratio: Fit', ToastAndroid.SHORT);
    }
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
        source={{ uri: streamUrl, headers }}
        style={StyleSheet.absoluteFill}
        resizeMode={resizeMode}
        paused={paused}
        selectedAudioTrack={selectedAudio}
        selectedTextTrack={selectedSub}
        onLoad={(meta: any) => {
          setDuration(meta.duration);
          setAudioTracks(meta.audioTracks || []);
          setTextTracks(meta.textTracks || []);
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

      {/* Stremio-Style Bottom Controls Bar */}
      {showControls && (
        <View style={styles.bottomOverlay}>
          <Text numberOfLines={1} style={styles.titleLabel}>
            {title}
          </Text>

          {/* Full-width scrub progress bar */}
          <View style={styles.progressContainer}>
            <View style={styles.progressBackground}>
              <View
                style={[
                  styles.progressFill,
                  { width: duration > 0 ? `${(currentTime / duration) * 100}%` : '0%' },
                ]}
              />
              <View
                style={[
                  styles.scrubberThumb,
                  { left: duration > 0 ? `${Math.min(99, (currentTime / duration) * 100)}%` : '0%' },
                ]}
              />
            </View>
          </View>

          {/* Controls row */}
          <View style={styles.controlsRow}>
            <View style={styles.leftButtonGroup}>
              {/* Play / Pause */}
              <TVFocusablePressable
                hasTVPreferredFocus={true}
                scaleFocused={1.15}
                focusedBorderColor="#8A5CF6"
                borderRadius={8}
                onPress={() => setPaused(!paused)}
                style={styles.actionIconBtn}
              >
                {() => (
                  <MaterialCommunityIcons
                    name={paused ? 'play' : 'pause'}
                    size={26}
                    color="#FFFFFF"
                  />
                )}
              </TVFocusablePressable>

              {/* 10s Rewind */}
              <TVFocusablePressable
                scaleFocused={1.15}
                focusedBorderColor="#8A5CF6"
                borderRadius={8}
                onPress={() => handleSeek(-10)}
                style={styles.actionIconBtn}
              >
                {() => <MaterialCommunityIcons name="rewind-10" size={24} color="#FFFFFF" />}
              </TVFocusablePressable>

              {/* 10s Fast-Forward */}
              <TVFocusablePressable
                scaleFocused={1.15}
                focusedBorderColor="#8A5CF6"
                borderRadius={8}
                onPress={() => handleSeek(10)}
                style={styles.actionIconBtn}
              >
                {() => <MaterialCommunityIcons name="fast-forward-10" size={24} color="#FFFFFF" />}
              </TVFocusablePressable>

              {/* Subtitles */}
              <TVFocusablePressable
                scaleFocused={1.15}
                focusedBorderColor="#8A5CF6"
                borderRadius={8}
                onPress={() => setDialogType('subtitle')}
                style={styles.actionIconBtn}
              >
                {() => <MaterialCommunityIcons name="subtitles-outline" size={24} color="#FFFFFF" />}
              </TVFocusablePressable>

              {/* Audio Tracks */}
              <TVFocusablePressable
                scaleFocused={1.15}
                focusedBorderColor="#8A5CF6"
                borderRadius={8}
                onPress={() => setDialogType('audio')}
                style={styles.actionIconBtn}
              >
                {() => <MaterialCommunityIcons name="volume-high" size={24} color="#FFFFFF" />}
              </TVFocusablePressable>

              {/* Aspect Ratio */}
              <TVFocusablePressable
                scaleFocused={1.15}
                focusedBorderColor="#8A5CF6"
                borderRadius={8}
                onPress={toggleAspectRatio}
                style={styles.actionIconBtn}
              >
                {() => <MaterialCommunityIcons name="aspect-ratio" size={24} color="#FFFFFF" />}
              </TVFocusablePressable>
            </View>

            {/* Time readout */}
            <View style={styles.timeWrapper}>
              <Text style={styles.timeCurrent}>{formatTime(currentTime)}</Text>
              <Text style={styles.timeDivider}> / </Text>
              <Text style={styles.timeDuration}>{formatTime(duration)}</Text>
            </View>
          </View>
        </View>
      )}

      {/* Audio / Subtitles Modal Dialog */}
      <Modal
        visible={Boolean(dialogType)}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setDialogType(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>
              {dialogType === 'audio' ? 'Audio Tracks' : 'Subtitles'}
            </Text>

            {dialogType === 'subtitle' ? (
              <View style={styles.trackList}>
                <TVFocusablePressable
                  scaleFocused={1.03}
                  focusedBorderColor="#8A5CF6"
                  borderRadius={8}
                  onPress={() => {
                    setSelectedSub({ type: SelectedTrackType.DISABLED });
                    setDialogType(null);
                  }}
                  style={[styles.trackRow, selectedSub.type === SelectedTrackType.DISABLED && styles.trackSelected]}
                >
                  {() => <Text style={styles.trackText}>Disabled</Text>}
                </TVFocusablePressable>

                {textTracks.map((trk, i) => (
                  <TVFocusablePressable
                    key={i}
                    scaleFocused={1.03}
                    focusedBorderColor="#8A5CF6"
                    borderRadius={8}
                    onPress={() => {
                      setSelectedSub({ type: SelectedTrackType.INDEX, value: i });
                      setDialogType(null);
                    }}
                    style={[styles.trackRow, selectedSub.value === i && styles.trackSelected]}
                  >
                    {() => (
                      <Text style={styles.trackText}>
                        {trk.title || trk.language || `Track ${i + 1}`}
                      </Text>
                    )}
                  </TVFocusablePressable>
                ))}
              </View>
            ) : (
              <View style={styles.trackList}>
                {audioTracks.map((trk, i) => (
                  <TVFocusablePressable
                    key={i}
                    scaleFocused={1.03}
                    focusedBorderColor="#8A5CF6"
                    borderRadius={8}
                    onPress={() => {
                      setSelectedAudio({ type: SelectedTrackType.INDEX, value: i });
                      setDialogType(null);
                    }}
                    style={[styles.trackRow, selectedAudio.value === i && styles.trackSelected]}
                  >
                    {() => (
                      <Text style={styles.trackText}>
                        {trk.title || trk.language || `Audio ${i + 1}`}
                      </Text>
                    )}
                  </TVFocusablePressable>
                ))}
              </View>
            )}
          </View>
        </View>
      </Modal>
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
  bottomOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 40,
    paddingBottom: 28,
    paddingTop: 48,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
  },
  titleLabel: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 14,
  },
  progressContainer: {
    width: '100%',
    height: 18,
    justifyContent: 'center',
    marginBottom: 8,
  },
  progressBackground: {
    width: '100%',
    height: 4,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    borderRadius: 2,
    position: 'relative',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#8A5CF6',
    borderRadius: 2,
  },
  scrubberThumb: {
    position: 'absolute',
    top: -5,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#8A5CF6',
  },
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  leftButtonGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  actionIconBtn: {
    padding: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  timeWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  timeCurrent: {
    color: '#E5E7EB',
    fontSize: 14,
    fontWeight: '700',
  },
  timeDivider: {
    color: '#6B7280',
    fontSize: 14,
  },
  timeDuration: {
    color: '#9CA3AF',
    fontSize: 14,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalBox: {
    width: 460,
    backgroundColor: '#16161E',
    borderRadius: 16,
    padding: 24,
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  modalTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 16,
  },
  trackList: {
    gap: 8,
  },
  trackRow: {
    backgroundColor: '#0A0A0E',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.06)',
  },
  trackSelected: {
    borderColor: '#8A5CF6',
    backgroundColor: 'rgba(138, 92, 246, 0.15)',
  },
  trackText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
});
