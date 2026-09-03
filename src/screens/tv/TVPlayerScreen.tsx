import React, { useRef, useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  ToastAndroid,
  Modal,
  BackHandler,
  ScrollView,
  findNodeHandle,
} from 'react-native';
import Video, { VideoRef, SelectedTrackType, ResizeMode } from 'react-native-video';
import LinearGradient from 'react-native-linear-gradient';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { TVFocusablePressable } from '../../components/tv/TVFocusablePressable';
import useContentStore from '../../lib/zustand/contentStore';
import useContinueWatchingStore from '../../lib/zustand/continueWatchingStore';
import { providerManager } from '../../lib/services/ProviderManager';
import { launchVideo } from '../../lib/services/PlayerLauncher';
import type { EpisodeLink, TextTracks } from '../../lib/providers/types';

const useTVEventHandler = (require('react-native') as any).useTVEventHandler;

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English', hi: 'Hindi', es: 'Spanish', fr: 'French', de: 'German',
  it: 'Italian', pt: 'Portuguese', ru: 'Russian', ja: 'Japanese', ko: 'Korean',
  zh: 'Chinese', ar: 'Arabic', ta: 'Tamil', te: 'Telugu', ml: 'Malayalam',
  kn: 'Kannada', bn: 'Bengali', mr: 'Marathi', pa: 'Punjabi', ur: 'Urdu',
  tr: 'Turkish', pl: 'Polish', nl: 'Dutch', th: 'Thai', vi: 'Vietnamese',
  id: 'Indonesian', ms: 'Malay', fa: 'Persian', he: 'Hebrew', uk: 'Ukrainian',
};

const describeTrack = (trk: any, fallbackLabel: string): string => {
  if (!trk) return fallbackLabel;
  const rawTitle = (trk?.title || trk?.label || '').trim();
  const rawLang = (trk?.language || trk?.lang || '').toLowerCase().trim();

  // If track already has brackets like [English] or [Hindi], keep it intact
  if (rawTitle && /\[.+\]/.test(rawTitle)) {
    return rawTitle;
  }

  const code = rawLang.slice(0, 2);
  const friendlyLang = LANGUAGE_NAMES[code] || (rawLang ? rawLang.toUpperCase() : '');

  if (rawTitle && friendlyLang) {
    if (rawTitle.toLowerCase().includes(friendlyLang.toLowerCase())) {
      return rawTitle;
    }
    return `${rawTitle} [${friendlyLang}]`;
  }
  if (rawTitle) return rawTitle;
  if (friendlyLang) return `${fallbackLabel} [${friendlyLang}]`;
  return fallbackLabel;
};

interface EpisodeItem {
  id?: string | number;
  title?: string;
  link?: string;
  url?: string;
  type?: string;
  image?: string;
  poster?: string;
}

interface ResolvedNextEpisode extends EpisodeItem {
  headers?: Record<string, string>;
  subtitles?: TextTracks;
  qualities?: { name: string; url: string }[];
}

interface TVPlayerScreenProps {
  streamUrl: string;
  title: string;
  posterUrl?: string;
  itemLink?: string;
  providerValue?: string;
  headers?: Record<string, string>;
  subtitles?: TextTracks;
  episodes?: EpisodeItem[];
  currentEpisodeIndex?: number;
  servers?: { name: string; url: string }[];
  qualities?: { name: string; url: string }[];
  onSelectNextEpisode?: (nextEpisode: ResolvedNextEpisode) => void;
  onSelectServer?: (serverUrl: string) => void;
  onSelectQuality?: (qualityUrl: string) => void;
  onClose: () => void;
}

type AspectRatioMode = 'contain' | 'cover' | 'stretch';
type DialogType = 'subtitles' | 'audio' | 'server' | 'quality' | null;

export const TVPlayerScreen: React.FC<TVPlayerScreenProps> = ({
  streamUrl,
  title,
  posterUrl,
  itemLink,
  providerValue,
  headers,
  subtitles,
  episodes = [],
  currentEpisodeIndex = 0,
  servers = [],
  qualities = [],
  onSelectNextEpisode,
  onSelectServer,
  onSelectQuality,
  onClose,
}) => {
  const videoRef = useRef<VideoRef>(null);
  const hideControlsTimer = useRef<NodeJS.Timeout | null>(null);
  const lastSyncTimeRef = useRef<number>(0);
  const currentProgRef = useRef<{ currentTime: number; duration: number }>({
    currentTime: 0,
    duration: 0,
  });

  // Self-referencing node handle for literal arrow key wake
  const wakeOverlayRef = useRef<View>(null);
  const [wakeNodeId, setWakeNodeId] = useState<number | undefined>(undefined);

  // Long-press continuous repeat timer
  const seekRepeatTimer = useRef<NodeJS.Timeout | null>(null);

  const [paused, setPaused] = useState(false);
  const [buffering, setBuffering] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [showControls, setShowControls] = useState(false);

  // Video track & display states
  const [resizeMode, setResizeMode] = useState<AspectRatioMode>('contain');
  const [audioTracks, setAudioTracks] = useState<any[]>([]);
  const [textTracks, setTextTracks] = useState<any[]>([]);
  const [selectedAudio, setSelectedAudio] = useState<any>({ type: SelectedTrackType.INDEX, value: 0 });
  const [selectedSub, setSelectedSub] = useState<any>({ type: SelectedTrackType.DISABLED });
  const [activeMediaUrl, setActiveMediaUrl] = useState<string>(streamUrl);
  const [resolvingNextEpisode, setResolvingNextEpisode] = useState(false);

  // Active Menu Dialog
  const [activeDialog, setActiveDialog] = useState<DialogType>(null);

  const prevStreamUrlRef = useRef(streamUrl);
  useEffect(() => {
    if (streamUrl && streamUrl !== prevStreamUrlRef.current) {
      prevStreamUrlRef.current = streamUrl;
      setActiveMediaUrl(streamUrl);
      setBuffering(true);
      setCurrentTime(0);
      setDuration(0);
      setPaused(false);
      currentProgRef.current = { currentTime: 0, duration: 0 };
    }
  }, [streamUrl]);

  // Bind native node ID for focus trap
  useEffect(() => {
    if (wakeOverlayRef.current) {
      const handle = findNodeHandle(wakeOverlayRef.current);
      if (handle) setWakeNodeId(handle);
    }
  }, [showControls]);

  // D-pad hold-to-seek tracking
  const seekHoldActiveRef = useRef(false);
  const seekReleaseTimerRef = useRef<NodeJS.Timeout | null>(null);
  useEffect(() => {
    return () => {
      if (seekReleaseTimerRef.current) clearTimeout(seekReleaseTimerRef.current);
      if (seekRepeatTimer.current) clearInterval(seekRepeatTimer.current);
    };
  }, []);

  const upsertContinueWatching = useContinueWatchingStore((state) => state.upsertItem);
  const continueWatchingId = itemLink || streamUrl;

  const syncProgressToStore = useCallback(
    (timeSec: number, totalDur: number) => {
      if (totalDur <= 0 || timeSec <= 0 || !continueWatchingId) return;

      const currentEpisode = episodes[currentEpisodeIndex];
      const episode: EpisodeLink = currentEpisode?.link
        ? {
            ...currentEpisode,
            title: currentEpisode.title || title,
            link: currentEpisode.link,
          }
        : { title, link: continueWatchingId };

      upsertContinueWatching({
        id: continueWatchingId,
        title,
        episodeTitle:
          episode.title && episode.title !== title ? episode.title : undefined,
        episode,
        type: episodes.length > 0 ? 'series' : 'movie',
        poster: posterUrl,
        background: posterUrl,
        providerValue: providerValue || useContentStore.getState().provider?.value || '',
        infoUrl: continueWatchingId,
        position: Math.floor(timeSec),
        duration: Math.floor(totalDur),
        updatedAt: Date.now(),
      });
    },
    [continueWatchingId, episodes, currentEpisodeIndex, title, posterUrl, providerValue, upsertContinueWatching]
  );

  useEffect(() => {
    return () => {
      if (currentProgRef.current.duration > 0) {
        syncProgressToStore(
          currentProgRef.current.currentTime,
          currentProgRef.current.duration
        );
      }
    };
  }, [syncProgressToStore]);

  const resetInactivityTimer = useCallback(() => {
    if (hideControlsTimer.current) {
      clearTimeout(hideControlsTimer.current);
    }
    setShowControls(true);
    hideControlsTimer.current = setTimeout(() => {
      setShowControls((prev) => {
        if (activeDialog) return true;
        return false;
      });
    }, 3500);
  }, [activeDialog]);

  useEffect(() => {
    return () => {
      if (hideControlsTimer.current) clearTimeout(hideControlsTimer.current);
    };
  }, []);

  const handleSeek = useCallback((delta: number) => {
    resetInactivityTimer();
    setCurrentTime((curr) => {
      const next = Math.max(0, Math.min(duration, curr + delta));
      videoRef.current?.seek(next);
      currentProgRef.current.currentTime = next;
      syncProgressToStore(next, duration);
      return next;
    });
  }, [duration, resetInactivityTimer, syncProgressToStore]);

  const startContinuousSeek = useCallback(
    (direction: 'forward' | 'backward') => {
      if (seekRepeatTimer.current) clearInterval(seekRepeatTimer.current);
      resetInactivityTimer();
      let step = direction === 'forward' ? 10 : -10;
      handleSeek(step);

      let ticks = 0;
      seekRepeatTimer.current = setInterval(() => {
        ticks += 1;
        if (ticks > 4) step = direction === 'forward' ? 25 : -25;
        handleSeek(step);
      }, 350);
    },
    [handleSeek, resetInactivityTimer]
  );

  const stopContinuousSeek = useCallback(() => {
    if (seekRepeatTimer.current) {
      clearInterval(seekRepeatTimer.current);
      seekRepeatTimer.current = null;
    }
  }, []);

  const handleCatcherPress = useCallback(() => {
    setPaused((prevPaused) => {
      const nextPaused = !prevPaused;
      syncProgressToStore(currentProgRef.current.currentTime, currentProgRef.current.duration);
      return nextPaused;
    });
    resetInactivityTimer();
  }, [resetInactivityTimer, syncProgressToStore]);

  const RELEASE_GAP_MS = 450;
  const handleDPadSeekEvent = useCallback((direction: 'left' | 'right') => {
    if (showControls && !seekHoldActiveRef.current) return;

    seekHoldActiveRef.current = true;
    if (seekReleaseTimerRef.current) clearTimeout(seekReleaseTimerRef.current);
    handleSeek(direction === 'right' ? 10 : -10);
    seekReleaseTimerRef.current = setTimeout(() => {
      seekHoldActiveRef.current = false;
    }, RELEASE_GAP_MS);
  }, [showControls, handleSeek]);

  // Global D-Pad Listener for TV remotes
  if (typeof useTVEventHandler === 'function') {
    useTVEventHandler((evt: any) => {
      if (!evt?.eventType) return;
      const type = evt.eventType;

      if (!showControls) {
        if (['up', 'down', 'left', 'right', 'select', 'playPause'].includes(type)) {
          resetInactivityTimer();
        }

        if (type === 'right') handleDPadSeekEvent('right');
        else if (type === 'left') handleDPadSeekEvent('left');
        else if (type === 'select' || type === 'playPause') {
          handleCatcherPress();
        }
      } else {
        if (['up', 'down', 'left', 'right', 'select'].includes(type)) {
          resetInactivityTimer();
        }
      }
    });
  }

  // Remote Back Button Handler
  useEffect(() => {
    const handleBackPress = () => {
      if (activeDialog) {
        setActiveDialog(null);
        resetInactivityTimer();
        return true;
      }
      if (showControls) {
        setShowControls(false);
        if (hideControlsTimer.current) clearTimeout(hideControlsTimer.current);
        return true;
      }
      syncProgressToStore(
        currentProgRef.current.currentTime,
        currentProgRef.current.duration
      );
      onClose();
      return true;
    };

    const sub = BackHandler.addEventListener('hardwareBackPress', handleBackPress);
    return () => sub.remove();
  }, [activeDialog, showControls, onClose, resetInactivityTimer, syncProgressToStore]);

  const openInVLC = async () => {
    await launchVideo(activeMediaUrl || streamUrl, title, 'vlc');
  };

  const handleNextEpisode = async () => {
    if (resolvingNextEpisode) return;

    syncProgressToStore(
      currentProgRef.current.currentTime,
      currentProgRef.current.duration
    );
    const nextIndex = currentEpisodeIndex + 1;
    if (episodes.length <= nextIndex) {
      ToastAndroid.show('No next episode available.', ToastAndroid.SHORT);
      return;
    }

    const nextEp = episodes[nextIndex];
    const nextTitle = nextEp.title || `Episode ${nextIndex + 1}`;

    if (!nextEp.link || !providerValue) {
      ToastAndroid.show('Unable to resolve next episode.', ToastAndroid.SHORT);
      return;
    }

    setResolvingNextEpisode(true);
    ToastAndroid.show(`Loading next episode: ${nextTitle}`, ToastAndroid.SHORT);
    try {
      const streams = await providerManager.getStream({
        link: nextEp.link,
        type: 'series',
        providerValue,
      });

      if (!streams || streams.length === 0) {
        ToastAndroid.show('No valid stream links found for this episode.', ToastAndroid.LONG);
        return;
      }

      const best = streams[0];
      const qualList = streams.map((s: any, idx: number) => ({
        name: s.quality ? `${s.quality}p` : s.server || `Source ${idx + 1}`,
        url: s.link,
      }));

      onSelectNextEpisode?.({
        ...nextEp,
        title: nextTitle,
        url: best.link,
        headers: best.headers,
        subtitles: best.subtitles,
        qualities: qualList,
      });
    } catch (e: any) {
      console.warn('[TVPlayerScreen] Next episode extraction failed:', e);
      ToastAndroid.show(e?.message || 'Failed to load next episode.', ToastAndroid.LONG);
    } finally {
      setResolvingNextEpisode(false);
    }
  };

  const toggleAspectRatio = () => {
    resetInactivityTimer();
    setResizeMode((prev) => {
      if (prev === 'contain') return 'cover';
      if (prev === 'cover') return 'stretch';
      return 'contain';
    });
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  };

  const hasNextEpisode = episodes.length > currentEpisodeIndex + 1;

  return (
    <View style={styles.container}>
      <Video
        key={`video-surface-${resizeMode}`}
        ref={videoRef}
        source={{ uri: activeMediaUrl || streamUrl, headers }}
        style={StyleSheet.absoluteFill}
        resizeMode={resizeMode as ResizeMode}
        paused={paused}
        selectedAudioTrack={selectedAudio}
        selectedTextTrack={selectedSub}
        textTracks={subtitles}
        subtitleStyle={{
          backgroundColor: 'transparent',
          opacity: 1,
          fontSize: 24,
          subtitlesFollowVideo: true,
          paddingBottom: 40,
        }}
        onLoad={(meta: any) => {
          const totalDur = meta.duration || 0;
          setDuration(totalDur);
          currentProgRef.current.duration = totalDur;
          if (meta.audioTracks?.length) setAudioTracks(meta.audioTracks);
          if (meta.textTracks?.length) setTextTracks(meta.textTracks);
          setBuffering(false);
        }}
        onAudioTracks={(e: any) => {
          if (e?.audioTracks?.length) setAudioTracks(e.audioTracks);
        }}
        onTextTracks={(e: any) => {
          if (e?.textTracks?.length) setTextTracks(e.textTracks);
        }}
        onProgress={(prog) => {
          setCurrentTime(prog.currentTime);
          currentProgRef.current.currentTime = prog.currentTime;

          const now = Date.now();
          if (now - lastSyncTimeRef.current > 3000) {
            lastSyncTimeRef.current = now;
            syncProgressToStore(prog.currentTime, duration);
          }
        }}
        onBuffer={(buf) => setBuffering(buf.isBuffering)}
        onError={(err) => {
          ToastAndroid.show(`Playback error: ${err.error?.errorString || 'Failed to play stream'}`, ToastAndroid.LONG);
          setBuffering(false);
        }}
      />

      {buffering && (
        <View style={styles.centerLoading}>
          <ActivityIndicator size="large" color="#8A5CF6" />
        </View>
      )}

      {/* Invisible TV Focus Catcher when controls are hidden */}
      {!showControls && (
        <View
          ref={wakeOverlayRef}
          style={StyleSheet.absoluteFill}
          focusable={true}
          hasTVPreferredFocus={true}
          nextFocusUp={wakeNodeId}
          nextFocusDown={wakeNodeId}
          nextFocusLeft={wakeNodeId}
          nextFocusRight={wakeNodeId}
        >
          <TVFocusablePressable
            hasTVPreferredFocus
            style={StyleSheet.absoluteFillObject}
            onPress={handleCatcherPress}
            focusedBorderColor="transparent"
            scaleFocused={1}
          >
            {() => <View style={StyleSheet.absoluteFillObject} />}
          </TVFocusablePressable>
        </View>
      )}

      {/* Transparent Bottom Player Controls Overlay */}
      {showControls && (
        <View style={styles.controlsWrapper}>
          <LinearGradient
            colors={['transparent', 'rgba(10, 10, 14, 0.75)', 'rgba(5, 5, 8, 0.95)']}
            locations={[0, 0.45, 1]}
            style={styles.gradientOverlay}
          />

          <View style={styles.controlsContent}>
            {/* Title */}
            <Text numberOfLines={1} style={styles.mediaTitle}>
              {title}
            </Text>

            {/* Interactive Focusable Seekbar */}
            <TVFocusablePressable
              scaleFocused={1.01}
              focusedBorderColor="#8A5CF6"
              borderRadius={4}
              onFocus={() => resetInactivityTimer()}
              onPress={() => handleSeek(15)}
              style={styles.progressContainer}
            >
              {({ focused }) => (
                <View>
                  <View style={[styles.progressTrack, focused && styles.progressTrackFocused]}>
                    <View
                      style={[
                        styles.progressFill,
                        { width: duration > 0 ? `${(currentTime / duration) * 100}%` : '0%' },
                        focused && styles.progressFillFocused,
                      ]}
                    />
                  </View>
                  <View style={styles.timeRow}>
                    <Text style={styles.timeText}>{formatTime(currentTime)}</Text>
                    <Text style={styles.timeText}>{formatTime(duration)}</Text>
                  </View>
                </View>
              )}
            </TVFocusablePressable>

            {/* Bottom Controls Row */}
            <View style={styles.actionRow}>
              {/* Play / Pause */}
              <TVFocusablePressable
                hasTVPreferredFocus={true}
                scaleFocused={1.12}
                focusedBorderColor="#8A5CF6"
                borderRadius={8}
                onFocus={() => resetInactivityTimer()}
                onPress={() => {
                  const nextPaused = !paused;
                  setPaused(nextPaused);
                  syncProgressToStore(currentTime, duration);
                  resetInactivityTimer();
                }}
                style={styles.controlBtn}
              >
                {() => (
                  <MaterialCommunityIcons
                    name={paused ? 'play' : 'pause'}
                    size={26}
                    color="#FFFFFF"
                  />
                )}
              </TVFocusablePressable>

              {/* 10s Rewind (Click: -10s, Long-press: continuous seek) */}
              <TVFocusablePressable
                scaleFocused={1.12}
                focusedBorderColor="#8A5CF6"
                borderRadius={8}
                onFocus={() => resetInactivityTimer()}
                onPress={() => handleSeek(-10)}
                onLongPress={() => startContinuousSeek('backward')}
                onPressOut={stopContinuousSeek}
                style={styles.controlBtn}
              >
                {() => <MaterialCommunityIcons name="rewind-10" size={24} color="#FFFFFF" />}
              </TVFocusablePressable>

              {/* 10s Forward (Click: +10s, Long-press: continuous seek) */}
              <TVFocusablePressable
                scaleFocused={1.12}
                focusedBorderColor="#8A5CF6"
                borderRadius={8}
                onFocus={() => resetInactivityTimer()}
                onPress={() => handleSeek(10)}
                onLongPress={() => startContinuousSeek('forward')}
                onPressOut={stopContinuousSeek}
                style={styles.controlBtn}
              >
                {() => <MaterialCommunityIcons name="fast-forward-10" size={24} color="#FFFFFF" />}
              </TVFocusablePressable>

              {/* Next Episode Button */}
              {hasNextEpisode && (
                <TVFocusablePressable
                  scaleFocused={1.12}
                  focusedBorderColor="#8A5CF6"
                  borderRadius={8}
                  onFocus={() => resetInactivityTimer()}
                  onPress={handleNextEpisode}
                  style={styles.controlBtn}
                >
                  {() => <MaterialCommunityIcons name="skip-next" size={26} color="#FFFFFF" />}
                </TVFocusablePressable>
              )}

              {/* Open in VLC */}
              <TVFocusablePressable
                scaleFocused={1.08}
                focusedBorderColor="#F59E0B"
                borderRadius={8}
                onFocus={() => resetInactivityTimer()}
                onPress={openInVLC}
                style={[styles.controlBtn, styles.vlcBtn]}
              >
                {() => (
                  <View style={styles.vlcBtnInner}>
                    <MaterialCommunityIcons name="vlc" size={20} color="#F59E0B" />
                    <Text style={styles.vlcText}>Open in VLC</Text>
                  </View>
                )}
              </TVFocusablePressable>

              {/* Audio Selector */}
              <TVFocusablePressable
                scaleFocused={1.08}
                focusedBorderColor="#8A5CF6"
                borderRadius={8}
                onFocus={() => resetInactivityTimer()}
                onPress={() => setActiveDialog('audio')}
                style={styles.controlPillBtn}
              >
                {() => (
                  <View style={styles.pillInner}>
                    <MaterialCommunityIcons name="volume-high" size={20} color="#FFFFFF" />
                    <Text style={styles.pillText}>Audio</Text>
                  </View>
                )}
              </TVFocusablePressable>

              {/* Subtitles Selector */}
              <TVFocusablePressable
                scaleFocused={1.08}
                focusedBorderColor="#8A5CF6"
                borderRadius={8}
                onFocus={() => resetInactivityTimer()}
                onPress={() => setActiveDialog('subtitles')}
                style={styles.controlPillBtn}
              >
                {() => (
                  <View style={styles.pillInner}>
                    <MaterialCommunityIcons name="subtitles-outline" size={20} color="#FFFFFF" />
                    <Text style={styles.pillText}>
                      {selectedSub.type === SelectedTrackType.DISABLED
                        ? 'Subtitles Off'
                        : describeTrack(textTracks[selectedSub.value], 'Subtitles')}
                    </Text>
                  </View>
                )}
              </TVFocusablePressable>

              {/* Server Selector */}
              {servers.length > 0 && (
                <TVFocusablePressable
                  scaleFocused={1.08}
                  focusedBorderColor="#8A5CF6"
                  borderRadius={8}
                  onFocus={() => resetInactivityTimer()}
                  onPress={() => setActiveDialog('server')}
                  style={styles.controlPillBtn}
                >
                  {() => (
                    <View style={styles.pillInner}>
                      <MaterialCommunityIcons name="server-network" size={20} color="#FFFFFF" />
                      <Text style={styles.pillText}>Server</Text>
                    </View>
                  )}
                </TVFocusablePressable>
              )}

              {/* Quality Selector */}
              {qualities.length > 0 && (
                <TVFocusablePressable
                  scaleFocused={1.08}
                  focusedBorderColor="#8A5CF6"
                  borderRadius={8}
                  onFocus={() => resetInactivityTimer()}
                  onPress={() => setActiveDialog('quality')}
                  style={styles.controlPillBtn}
                >
                  {() => (
                    <View style={styles.pillInner}>
                      <MaterialCommunityIcons name="tune-variant" size={20} color="#FFFFFF" />
                      <Text style={styles.pillText}>Quality</Text>
                    </View>
                  )}
                </TVFocusablePressable>
              )}

              {/* Aspect Ratio Mode */}
              <TVFocusablePressable
                scaleFocused={1.08}
                focusedBorderColor="#8A5CF6"
                borderRadius={8}
                onFocus={() => resetInactivityTimer()}
                onPress={toggleAspectRatio}
                style={styles.controlPillBtn}
              >
                {() => (
                  <View style={styles.pillInner}>
                    <MaterialCommunityIcons name="aspect-ratio" size={20} color="#FFFFFF" />
                    <Text style={styles.pillText}>{resizeMode.toUpperCase()}</Text>
                  </View>
                )}
              </TVFocusablePressable>
            </View>
          </View>
        </View>
      )}

      {/* D-Pad Navigable Drop-Down Dialog */}
      <Modal
        visible={Boolean(activeDialog)}
        transparent={true}
        animationType="fade"
        onRequestClose={() => {
          setActiveDialog(null);
          resetInactivityTimer();
        }}
      >
        <View style={styles.dialogBackdrop}>
          <View style={styles.dialogBox}>
            <Text style={styles.dialogTitle}>
              {activeDialog === 'subtitles' && 'Subtitles'}
              {activeDialog === 'audio' && 'Audio Tracks'}
              {activeDialog === 'server' && 'Select Server'}
              {activeDialog === 'quality' && 'Select Quality'}
            </Text>

            <ScrollView contentContainerStyle={styles.dialogList}>
              {/* Subtitle Options */}
              {activeDialog === 'subtitles' && (
                <>
                  <TVFocusablePressable
                    hasTVPreferredFocus={true}
                    scaleFocused={1.03}
                    focusedBorderColor="#8A5CF6"
                    borderRadius={8}
                    onPress={() => {
                      setSelectedSub({ type: SelectedTrackType.DISABLED });
                      setActiveDialog(null);
                      resetInactivityTimer();
                    }}
                    style={[
                      styles.dialogItem,
                      selectedSub.type === SelectedTrackType.DISABLED && styles.dialogItemSelected,
                    ]}
                  >
                    {() => <Text style={styles.dialogItemText}>Off / Disabled</Text>}
                  </TVFocusablePressable>
                  {textTracks.map((trk, i) => (
                    <TVFocusablePressable
                      key={`sub-${i}`}
                      scaleFocused={1.03}
                      focusedBorderColor="#8A5CF6"
                      borderRadius={8}
                      onPress={() => {
                        setSelectedSub({ type: SelectedTrackType.INDEX, value: i });
                        setActiveDialog(null);
                        resetInactivityTimer();
                      }}
                      style={[
                        styles.dialogItem,
                        selectedSub.value === i && styles.dialogItemSelected,
                      ]}
                    >
                      {() => (
                        <Text style={styles.dialogItemText}>
                          {describeTrack(trk, `Subtitle Track ${i + 1}`)}
                        </Text>
                      )}
                    </TVFocusablePressable>
                  ))}
                </>
              )}

              {/* Audio Options */}
              {activeDialog === 'audio' &&
                audioTracks.map((trk, i) => (
                  <TVFocusablePressable
                    key={`audio-${i}`}
                    hasTVPreferredFocus={i === 0}
                    scaleFocused={1.03}
                    focusedBorderColor="#8A5CF6"
                    borderRadius={8}
                    onPress={() => {
                      setSelectedAudio({ type: SelectedTrackType.INDEX, value: i });
                      setActiveDialog(null);
                      resetInactivityTimer();
                    }}
                    style={[
                      styles.dialogItem,
                      selectedAudio.value === i && styles.dialogItemSelected,
                    ]}
                  >
                    {() => (
                      <Text style={styles.dialogItemText}>
                        {describeTrack(trk, `Audio Track ${i + 1}`)}
                      </Text>
                    )}
                  </TVFocusablePressable>
                ))}

              {/* Server Options */}
              {activeDialog === 'server' &&
                servers.map((srv, i) => (
                  <TVFocusablePressable
                    key={`server-${i}`}
                    hasTVPreferredFocus={i === 0}
                    scaleFocused={1.03}
                    focusedBorderColor="#8A5CF6"
                    borderRadius={8}
                    onPress={() => {
                      setActiveMediaUrl(srv.url);
                      onSelectServer?.(srv.url);
                      setActiveDialog(null);
                      resetInactivityTimer();
                    }}
                    style={[
                      styles.dialogItem,
                      activeMediaUrl === srv.url && styles.dialogItemSelected,
                    ]}
                  >
                    {() => <Text style={styles.dialogItemText}>{srv.name}</Text>}
                  </TVFocusablePressable>
                ))}

              {/* Quality Options */}
              {activeDialog === 'quality' &&
                qualities.map((q, i) => (
                  <TVFocusablePressable
                    key={`quality-${i}`}
                    hasTVPreferredFocus={i === 0}
                    scaleFocused={1.03}
                    focusedBorderColor="#8A5CF6"
                    borderRadius={8}
                    onPress={() => {
                      setActiveMediaUrl(q.url);
                      onSelectQuality?.(q.url);
                      setActiveDialog(null);
                      resetInactivityTimer();
                    }}
                    style={[
                      styles.dialogItem,
                      activeMediaUrl === q.url && styles.dialogItemSelected,
                    ]}
                  >
                    {() => <Text style={styles.dialogItemText}>{q.name}</Text>}
                  </TVFocusablePressable>
                ))}
            </ScrollView>
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
  centerLoading: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
  },
  controlsWrapper: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    justifyContent: 'flex-end',
  },
  gradientOverlay: {
    ...StyleSheet.absoluteFillObject,
    height: 190,
  },
  controlsContent: {
    paddingHorizontal: 40,
    paddingBottom: 24,
    paddingTop: 16,
    zIndex: 10,
  },
  mediaTitle: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '800',
    marginBottom: 10,
    textShadowColor: 'rgba(0,0,0,0.9)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  progressContainer: {
    marginBottom: 12,
    paddingVertical: 4,
  },
  progressTrack: {
    width: '100%',
    height: 4,
    backgroundColor: 'rgba(255, 255, 255, 0.25)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressTrackFocused: {
    height: 6,
    backgroundColor: 'rgba(255, 255, 255, 0.4)',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#8A5CF6',
  },
  progressFillFocused: {
    backgroundColor: '#A78BFA',
  },
  timeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 6,
  },
  timeText: {
    color: '#D1D5DB',
    fontSize: 12,
    fontWeight: '600',
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  controlBtn: {
    padding: 10,
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  controlPillBtn: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
  },
  pillInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  pillText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
  vlcBtn: {
    backgroundColor: 'rgba(245, 158, 11, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.4)',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  vlcBtnInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  vlcText: {
    color: '#F59E0B',
    fontSize: 13,
    fontWeight: '700',
  },
  dialogBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  dialogBox: {
    width: 480,
    maxHeight: 380,
    backgroundColor: '#13131A',
    borderRadius: 14,
    padding: 20,
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.12)',
  },
  dialogTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '800',
    marginBottom: 14,
  },
  dialogList: {
    gap: 8,
  },
  dialogItem: {
    backgroundColor: '#1E1E28',
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  dialogItemSelected: {
    borderColor: '#8A5CF6',
    borderWidth: 1.5,
    backgroundColor: 'rgba(138, 92, 246, 0.2)',
  },
  dialogItemText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
});
