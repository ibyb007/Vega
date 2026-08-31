import React, { useRef, useState, useEffect, useCallback } from 'react';
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

export interface TVPlayerQuality {
  label: string;
  url: string;
  headers?: any;
}

interface TVPlayerScreenProps {
  streamUrl: string;
  title: string;
  headers?: Record<string, string>;
  qualities?: TVPlayerQuality[];
  onClose: () => void;
}

type AspectRatioMode = 'contain' | 'cover' | 'stretch';

const AUTO_HIDE_MS = 6000;
const SPEED_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2];

export const TVPlayerScreen: React.FC<TVPlayerScreenProps> = ({
  streamUrl,
  title,
  headers,
  qualities,
  onClose,
}) => {
  const videoRef = useRef<VideoRef>(null);
  const defaultPlayer = useSettingsStore((state) => state.defaultPlayer);

  // The active source can change when the user picks a different quality,
  // so it lives in state seeded from props rather than being read from
  // props directly.
  const [activeSource, setActiveSource] = useState({ url: streamUrl, headers });
  const [activeQualityLabel, setActiveQualityLabel] = useState<string>(
    qualities && qualities.length > 0 ? qualities[0].label : 'Auto',
  );
  const resumeAtRef = useRef<number | null>(null);

  const [paused, setPaused] = useState(false);
  const [buffering, setBuffering] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [showControls, setShowControls] = useState(true);
  const [speed, setSpeed] = useState(1);

  // Video Track & Display states
  const [resizeMode, setResizeMode] = useState<AspectRatioMode>('contain');
  const [audioTracks, setAudioTracks] = useState<any[]>([]);
  const [textTracks, setTextTracks] = useState<any[]>([]);
  const [selectedAudio, setSelectedAudio] = useState<any>({ type: SelectedTrackType.INDEX, value: 0 });
  const [selectedSub, setSelectedSub] = useState<any>({ type: SelectedTrackType.DISABLED });

  // Dialog States
  const [dialogType, setDialogType] = useState<'audio' | 'subtitle' | 'quality' | null>(null);

  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHideTimer = () => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  };

  const scheduleAutoHide = useCallback(() => {
    clearHideTimer();
    if (paused || dialogType) return;
    hideTimerRef.current = setTimeout(() => {
      setShowControls(false);
    }, AUTO_HIDE_MS);
  }, [paused, dialogType]);

  // Any interaction (focusing a control, opening/closing a dialog, toggling
  // pause) should reveal the controls and restart the auto-hide countdown.
  const registerInteraction = useCallback(() => {
    setShowControls(true);
    scheduleAutoHide();
  }, [scheduleAutoHide]);

  useEffect(() => {
    scheduleAutoHide();
    return clearHideTimer;
  }, [scheduleAutoHide]);

  useEffect(() => {
    if (defaultPlayer === 'vlc' || defaultPlayer === 'external') {
      launchExternalPlayer(activeSource.url, title);
    }
    // Only on mount / explicit default-player change -- not on every
    // quality switch (that would re-launch the external app repeatedly).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultPlayer]);

  const launchExternalPlayer = async (url: string, mediaTitle: string) => {
    try {
      const extra: Record<string, any> = { title: mediaTitle };

      if (activeSource.headers && Object.keys(activeSource.headers).length > 0) {
        Object.assign(extra, activeSource.headers);
        extra['android.media.intent.extra.HTTP_HEADERS'] = activeSource.headers;
        extra.headers = activeSource.headers;

        const referer = activeSource.headers['Referer'] || activeSource.headers['referer'];
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
      ToastAndroid.show('No external video player found. Falling back to internal player.', ToastAndroid.LONG);
    }
  };

  const handleSeek = (deltaSeconds: number) => {
    const next = Math.max(0, Math.min(duration, currentTime + deltaSeconds));
    videoRef.current?.seek(next);
    setCurrentTime(next);
    registerInteraction();
  };

  const toggleAspectRatio = () => {
    setResizeMode((prev) => {
      const next = prev === 'contain' ? 'cover' : prev === 'cover' ? 'stretch' : 'contain';
      const label = next === 'contain' ? 'Fit' : next === 'cover' ? 'Crop' : 'Stretch';
      ToastAndroid.show(`Aspect Ratio: ${label}`, ToastAndroid.SHORT);
      return next;
    });
    registerInteraction();
  };

  const cycleSpeed = () => {
    const idx = SPEED_STEPS.indexOf(speed);
    const next = SPEED_STEPS[(idx + 1) % SPEED_STEPS.length];
    setSpeed(next);
    ToastAndroid.show(`Speed: ${next}x`, ToastAndroid.SHORT);
    registerInteraction();
  };

  const switchQuality = (q: TVPlayerQuality) => {
    resumeAtRef.current = currentTime;
    setBuffering(true);
    setActiveSource({ url: q.url, headers: q.headers });
    setActiveQualityLabel(q.label);
    setDialogType(null);
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  };

  const currentAudioLabel =
    audioTracks[selectedAudio?.value]?.title ||
    audioTracks[selectedAudio?.value]?.language?.toUpperCase() ||
    (audioTracks.length > 0 ? 'Audio' : '—');

  const currentSubLabel =
    selectedSub?.type === SelectedTrackType.DISABLED
      ? 'Off'
      : textTracks[selectedSub?.value]?.title ||
        textTracks[selectedSub?.value]?.language?.toUpperCase() ||
        'On';

  const aspectLabel = resizeMode === 'contain' ? 'Fit' : resizeMode === 'cover' ? 'Crop' : 'Stretch';

  return (
    <View style={styles.container}>
      <Video
        ref={videoRef}
        source={{ uri: activeSource.url, headers: activeSource.headers }}
        style={StyleSheet.absoluteFill}
        resizeMode={resizeMode}
        paused={paused}
        rate={speed}
        selectedAudioTrack={selectedAudio}
        selectedTextTrack={selectedSub}
        onLoad={(meta: any) => {
          setDuration(meta.duration);
          setAudioTracks(meta.audioTracks || []);
          setTextTracks(meta.textTracks || []);
          setBuffering(false);
          if (resumeAtRef.current != null) {
            videoRef.current?.seek(resumeAtRef.current);
            resumeAtRef.current = null;
          }
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

      {/* Invisible full-screen focus target used to bring controls back
          once they've auto-hidden -- it's the only focusable element on
          screen while `showControls` is false, so the D-pad naturally
          lands here. */}
      {!showControls && (
        <TVFocusablePressable
          hasTVPreferredFocus
          style={StyleSheet.absoluteFillObject}
          onFocus={registerInteraction}
          onPress={registerInteraction}
        >
          {() => <View style={StyleSheet.absoluteFillObject} />}
        </TVFocusablePressable>
      )}

      {/* Bottom Controls Bar */}
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
            <View style={styles.timeRow}>
              <Text style={styles.timeText}>{formatTime(currentTime)}</Text>
              <Text style={styles.timeText}>{formatTime(duration)}</Text>
            </View>
          </View>

          {/* Playback controls row */}
          <View style={styles.controlsRow}>
            <TVFocusablePressable
              hasTVPreferredFocus={showControls}
              scaleFocused={1.15}
              focusedBorderColor="#8A5CF6"
              borderRadius={8}
              onFocus={registerInteraction}
              onPress={() => {
                setPaused((p) => !p);
                registerInteraction();
              }}
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

            <TVFocusablePressable
              scaleFocused={1.15}
              focusedBorderColor="#8A5CF6"
              borderRadius={8}
              onFocus={registerInteraction}
              onPress={() => handleSeek(-10)}
              style={styles.actionIconBtn}
            >
              {() => <MaterialCommunityIcons name="rewind-10" size={24} color="#FFFFFF" />}
            </TVFocusablePressable>

            <TVFocusablePressable
              scaleFocused={1.15}
              focusedBorderColor="#8A5CF6"
              borderRadius={8}
              onFocus={registerInteraction}
              onPress={() => handleSeek(10)}
              style={styles.actionIconBtn}
            >
              {() => <MaterialCommunityIcons name="fast-forward-10" size={24} color="#FFFFFF" />}
            </TVFocusablePressable>
          </View>

          {/* Labeled option row -- mirrors the mobile app's bottom bar */}
          <View style={styles.optionsRow}>
            <TVFocusablePressable
              scaleFocused={1.06}
              focusedBorderColor="#8A5CF6"
              borderRadius={8}
              onFocus={registerInteraction}
              onPress={() => setDialogType('audio')}
              style={styles.optionBtn}
            >
              {() => (
                <View style={styles.optionBtnInner}>
                  <MaterialCommunityIcons name="volume-high" size={20} color="#FFFFFF" />
                  <Text numberOfLines={1} style={styles.optionLabel}>
                    {currentAudioLabel}
                  </Text>
                </View>
              )}
            </TVFocusablePressable>

            <TVFocusablePressable
              scaleFocused={1.06}
              focusedBorderColor="#8A5CF6"
              borderRadius={8}
              onFocus={registerInteraction}
              onPress={() => setDialogType('subtitle')}
              style={styles.optionBtn}
            >
              {() => (
                <View style={styles.optionBtnInner}>
                  <MaterialCommunityIcons name="subtitles-outline" size={20} color="#FFFFFF" />
                  <Text numberOfLines={1} style={styles.optionLabel}>
                    {currentSubLabel}
                  </Text>
                </View>
              )}
            </TVFocusablePressable>

            <TVFocusablePressable
              scaleFocused={1.06}
              focusedBorderColor="#8A5CF6"
              borderRadius={8}
              onFocus={registerInteraction}
              onPress={cycleSpeed}
              style={styles.optionBtn}
            >
              {() => (
                <View style={styles.optionBtnInner}>
                  <MaterialCommunityIcons name="speedometer" size={20} color="#FFFFFF" />
                  <Text numberOfLines={1} style={styles.optionLabel}>
                    {speed}x
                  </Text>
                </View>
              )}
            </TVFocusablePressable>

            {qualities && qualities.length > 1 && (
              <TVFocusablePressable
                scaleFocused={1.06}
                focusedBorderColor="#8A5CF6"
                borderRadius={8}
                onFocus={registerInteraction}
                onPress={() => setDialogType('quality')}
                style={styles.optionBtn}
              >
                {() => (
                  <View style={styles.optionBtnInner}>
                    <MaterialCommunityIcons name="high-definition" size={20} color="#FFFFFF" />
                    <Text numberOfLines={1} style={styles.optionLabel}>
                      {activeQualityLabel}
                    </Text>
                  </View>
                )}
              </TVFocusablePressable>
            )}

            <TVFocusablePressable
              scaleFocused={1.06}
              focusedBorderColor="#8A5CF6"
              borderRadius={8}
              onFocus={registerInteraction}
              onPress={toggleAspectRatio}
              style={styles.optionBtn}
            >
              {() => (
                <View style={styles.optionBtnInner}>
                  <MaterialCommunityIcons name="aspect-ratio" size={20} color="#FFFFFF" />
                  <Text numberOfLines={1} style={styles.optionLabel}>
                    {aspectLabel}
                  </Text>
                </View>
              )}
            </TVFocusablePressable>

            <TVFocusablePressable
              scaleFocused={1.06}
              focusedBorderColor="#F59E0B"
              borderRadius={8}
              onFocus={registerInteraction}
              onPress={() => launchExternalPlayer(activeSource.url, title)}
              style={[styles.optionBtn, styles.vlcBtn]}
            >
              {() => (
                <View style={styles.optionBtnInner}>
                  <MaterialCommunityIcons name="open-in-app" size={20} color="#F59E0B" />
                  <Text numberOfLines={1} style={[styles.optionLabel, { color: '#F59E0B' }]}>
                    Open in VLC
                  </Text>
                </View>
              )}
            </TVFocusablePressable>

            <TVFocusablePressable
              scaleFocused={1.06}
              focusedBorderColor="#FFFFFF"
              borderRadius={8}
              onFocus={registerInteraction}
              onPress={onClose}
              style={styles.optionBtn}
            >
              {() => (
                <View style={styles.optionBtnInner}>
                  <MaterialCommunityIcons name="close" size={20} color="#FFFFFF" />
                  <Text numberOfLines={1} style={styles.optionLabel}>
                    Close
                  </Text>
                </View>
              )}
            </TVFocusablePressable>
          </View>
        </View>
      )}

      {/* Audio / Subtitles / Quality Modal Dialog */}
      <Modal
        visible={Boolean(dialogType)}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setDialogType(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>
              {dialogType === 'audio' ? 'Audio Tracks' : dialogType === 'subtitle' ? 'Subtitles' : 'Quality'}
            </Text>

            {dialogType === 'quality' && (
              <View style={styles.trackList}>
                {(qualities || []).map((q, i) => (
                  <TVFocusablePressable
                    key={`${q.url}-${i}`}
                    hasTVPreferredFocus={i === 0}
                    scaleFocused={1.03}
                    focusedBorderColor="#8A5CF6"
                    borderRadius={8}
                    onPress={() => switchQuality(q)}
                    style={[styles.trackRow, activeQualityLabel === q.label && styles.trackSelected]}
                  >
                    {() => <Text style={styles.trackText}>{q.label}</Text>}
                  </TVFocusablePressable>
                ))}
              </View>
            )}

            {dialogType === 'subtitle' && (
              <View style={styles.trackList}>
                <TVFocusablePressable
                  hasTVPreferredFocus
                  scaleFocused={1.03}
                  focusedBorderColor="#8A5CF6"
                  borderRadius={8}
                  onPress={() => {
                    setSelectedSub({ type: SelectedTrackType.DISABLED });
                    setDialogType(null);
                  }}
                  style={[styles.trackRow, selectedSub.type === SelectedTrackType.DISABLED && styles.trackSelected]}
                >
                  {() => <Text style={styles.trackText}>Off</Text>}
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

                {textTracks.length === 0 && (
                  <Text style={styles.emptyModalText}>No subtitle tracks available for this stream.</Text>
                )}
              </View>
            )}

            {dialogType === 'audio' && (
              <View style={styles.trackList}>
                {audioTracks.map((trk, i) => (
                  <TVFocusablePressable
                    key={i}
                    hasTVPreferredFocus={i === 0}
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

                {audioTracks.length === 0 && (
                  <Text style={styles.emptyModalText}>No alternate audio tracks available.</Text>
                )}
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
    paddingBottom: 24,
    paddingTop: 48,
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
  },
  titleLabel: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 14,
  },
  progressContainer: {
    width: '100%',
    marginBottom: 18,
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
  timeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  timeText: {
    color: '#9CA3AF',
    fontSize: 13,
    fontWeight: '600',
  },
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 18,
  },
  actionIconBtn: {
    padding: 10,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  optionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  optionBtn: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  optionBtnInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  optionLabel: {
    color: '#E5E7EB',
    fontSize: 13,
    fontWeight: '600',
    maxWidth: 110,
  },
  vlcBtn: {
    backgroundColor: 'rgba(245, 158, 11, 0.12)',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalBox: {
    width: 460,
    maxHeight: 500,
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
  emptyModalText: {
    color: '#6B7280',
    fontSize: 13,
    paddingVertical: 8,
  },
});
