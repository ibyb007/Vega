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
} from 'react-native';
import Video, { VideoRef, SelectedTrackType } from 'react-native-video';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { TVFocusablePressable } from '../../components/tv/TVFocusablePressable';
import useContentStore from '../../lib/zustand/contentStore';
import useContinueWatchingStore from '../../lib/zustand/continueWatchingStore';
import { providerManager } from '../../lib/services/ProviderManager';
import { launchVideo } from '../../lib/services/PlayerLauncher';
import type { EpisodeLink, TextTracks } from '../../lib/providers/types';

// Safe, conditional lookup -- `useTVEventHandler` only exists on the
// `react-native-tvos` fork, not plain `react-native` (which this project
// uses). Calling it unconditionally would crash on mount. This mirrors the
// exact guard already used by `TVOSSupport.tsx` for the mobile player.
const useTVEventHandler = (require('react-native') as any).useTVEventHandler;

// Friendly display names for common ISO 639-1 language codes, since many
// streams only tag tracks with a bare code (e.g. "en", "hi") and no title.
const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English', hi: 'Hindi', es: 'Spanish', fr: 'French', de: 'German',
  it: 'Italian', pt: 'Portuguese', ru: 'Russian', ja: 'Japanese', ko: 'Korean',
  zh: 'Chinese', ar: 'Arabic', ta: 'Tamil', te: 'Telugu', ml: 'Malayalam',
  kn: 'Kannada', bn: 'Bengali', mr: 'Marathi', pa: 'Punjabi', ur: 'Urdu',
  tr: 'Turkish', pl: 'Polish', nl: 'Dutch', th: 'Thai', vi: 'Vietnamese',
  id: 'Indonesian', ms: 'Malay', fa: 'Persian', he: 'Hebrew', uk: 'Ukrainian',
};

const describeTrack = (trk: any, fallbackLabel: string): string => {
  if (trk?.title) return trk.title;
  const code = (trk?.language || '').toLowerCase().slice(0, 2);
  if (code && LANGUAGE_NAMES[code]) return `${LANGUAGE_NAMES[code]} (${code})`;
  if (trk?.language) return trk.language.toUpperCase();
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

// What actually gets handed back up to App.tsx once a next-episode's
// info-page link has been resolved to a real, playable stream via
// `providerManager.getStream()` -- see `handleNextEpisode` below.
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

  const [paused, setPaused] = useState(false);
  const [buffering, setBuffering] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  // Controls stay hidden until the first real interaction -- there is no
  // reason to flash them on when playback starts.
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

  // `activeMediaUrl` previously only seeded from `streamUrl` once, at
  // mount, via `useState(streamUrl)` -- it never re-synced afterwards. When
  // `onSelectNextEpisode` resolves a new episode's stream and App.tsx
  // re-renders this same (still-mounted) screen with a new `streamUrl`
  // prop, this effect is what actually swaps the video, resets progress,
  // and starts it playing. Without it, only `title` (passed straight
  // through as a prop) changed, which is why the on-screen text updated
  // but playback stayed on the previous episode.
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

  // D-pad hold-to-seek tracking (see `handleDPadSeekEvent` below).
  const seekHoldActiveRef = useRef(false);
  const seekReleaseTimerRef = useRef<NodeJS.Timeout | null>(null);
  useEffect(() => {
    return () => {
      if (seekReleaseTimerRef.current) clearTimeout(seekReleaseTimerRef.current);
    };
  }, []);

  const upsertContinueWatching = useContinueWatchingStore((state) => state.upsertItem);

  // `infoUrl` (the details-page link) identifies a title across episodes,
  // matching the mobile app's continue-watching key -- falls back to the
  // stream URL itself if this player was opened without one.
  const continueWatchingId = itemLink || streamUrl;

  // Sync playback timestamp to the shared continue-watching store (same one
  // the mobile app and the TV home screen's "Continue Watching" row read).
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

  // Flush progress on unmount / exit
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

  // Auto-Hide Control Overlay -- reveals controls and (re)starts a 3s
  // countdown to hide them again. This is only ever called from an actual
  // user interaction (a button press/focus, or the invisible catcher's
  // onPress below) -- never automatically on mount or on its own timer,
  // which is what previously caused the controls to flash back on by
  // themselves every few seconds (see note below).
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
    }, 3000);
  }, [activeDialog]);

  // Clear any pending hide timer on unmount only -- do NOT call
  // resetInactivityTimer() here. Controls start hidden and should only
  // appear from a genuine interaction.
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

  // OK/select press on the invisible full-screen catcher (i.e. while
  // controls are hidden) now instantly toggles play/pause, matching
  // Stremio, instead of requiring one press to reveal the control bar and
  // a second press on the Play/Pause button to actually pause.
  const handleCatcherPress = useCallback(() => {
    setPaused((prevPaused) => {
      const nextPaused = !prevPaused;
      syncProgressToStore(currentProgRef.current.currentTime, currentProgRef.current.duration);
      return nextPaused;
    });
    resetInactivityTimer();
  }, [resetInactivityTimer, syncProgressToStore]);

  // Long-press D-pad Left/Right seek (Stremio-style). Android TV's D-pad
  // auto-repeats the same 'left'/'right' event continuously for as long as
  // the physical button stays held down -- there's no separate key-up
  // event available here, so a run of repeats close together *is* the
  // "long press", and a gap of RELEASE_GAP_MS with no further repeats is
  // treated as release.
  //
  // This only takes over Left/Right when a hold-seek is already active, or
  // when the controls are hidden (i.e. the invisible catcher is the only
  // focusable thing on screen). While the control bar is showing and no
  // hold is in progress, Left/Right must keep doing normal D-pad focus
  // navigation between buttons -- otherwise every attempt to move focus
  // from Play to Rewind would also seek the video.
  const RELEASE_GAP_MS = 500;
  const handleDPadSeekEvent = useCallback((direction: 'left' | 'right') => {
    if (showControls && !seekHoldActiveRef.current) return;

    seekHoldActiveRef.current = true;
    if (seekReleaseTimerRef.current) clearTimeout(seekReleaseTimerRef.current);
    handleSeek(direction === 'right' ? 10 : -10);
    seekReleaseTimerRef.current = setTimeout(() => {
      seekHoldActiveRef.current = false;
    }, RELEASE_GAP_MS);
  }, [showControls, handleSeek]);

  // Guarded exactly like `TVOSSupport.tsx`'s equivalent hook for the mobile
  // player -- a no-op on plain React Native builds, active on the
  // `react-native-tvos` fork / Android TV builds that expose it.
  if (typeof useTVEventHandler === 'function') {
    useTVEventHandler((evt: any) => {
      if (evt?.eventType === 'right') handleDPadSeekEvent('right');
      else if (evt?.eventType === 'left') handleDPadSeekEvent('left');
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

  // Open in External VLC
  //
  // Previously this built its own intent `extra` map and stuffed the raw
  // `headers` *object* into it (both as `extra['...HTTP_HEADERS']` and
  // `extra.headers`). `expo-intent-launcher`'s `extra` only supports
  // primitive values that convert cleanly into a native Android Bundle --
  // a nested object isn't one of them, so building that intent failed
  // before VLC ever got a chance to open, and the identical retry in the
  // catch block hit the exact same problem. `PlayerLauncher.launchVideo`
  // (already in this codebase, just previously unused) builds the same
  // "open in VLC, falling back to a generic external player" intent
  // without that bug.
  const openInVLC = async () => {
    // launchVideo already surfaces an Alert if no compatible player is
    // found at all, so there's nothing further to do here on failure.
    await launchVideo(activeMediaUrl || streamUrl, title, 'vlc');
  };

  // `episodes[i].link` is the episode's *info-page* link (the same kind of
  // URL `TVDetailsScreen` fetches episode lists from) -- not a playable
  // stream. It has to be resolved through `providerManager.getStream()`
  // first, exactly like `TVDetailsScreen.resolveAndPlay` does for the
  // initial episode. Previously this handed `nextEp.link` straight to the
  // player as if it were already a video URL, so playback silently kept
  // running the current episode's stream while only the on-screen title
  // text changed.
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
      const qualities = streams.map((s: any, idx: number) => ({
        name: s.quality ? `${s.quality}p` : s.server || `Source ${idx + 1}`,
        url: s.link,
      }));

      onSelectNextEpisode?.({
        ...nextEp,
        title: nextTitle,
        url: best.link,
        headers: best.headers,
        subtitles: best.subtitles,
        qualities,
      });
    } catch (e: any) {
      console.warn('[TVPlayerScreen] Next episode stream extraction failed:', e);
      ToastAndroid.show(e?.message || 'Failed to load next episode.', ToastAndroid.LONG);
    } finally {
      setResolvingNextEpisode(false);
    }
  };

  const toggleAspectRatio = () => {
    resetInactivityTimer();
    if (resizeMode === 'contain') setResizeMode('cover');
    else if (resizeMode === 'cover') setResizeMode('stretch');
    else setResizeMode('contain');
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
        ref={videoRef}
        source={{ uri: activeMediaUrl || streamUrl, headers }}
        style={StyleSheet.absoluteFill}
        resizeMode={resizeMode}
        paused={paused}
        selectedAudioTrack={selectedAudio}
        selectedTextTrack={selectedSub}
        textTracks={subtitles}
        subtitleStyle={{ fontSize: 30, subtitlesFollowVideo: true }}
        onLoad={(meta: any) => {
          const totalDur = meta.duration || 0;
          setDuration(totalDur);
          currentProgRef.current.duration = totalDur;
          if (meta.audioTracks?.length) setAudioTracks(meta.audioTracks);
          if (meta.textTracks?.length) setTextTracks(meta.textTracks);
          setBuffering(false);
        }}
        // For many HLS sources, react-native-video hasn't finished parsing
        // audio/subtitle track metadata (language, title) by the time
        // `onLoad` fires -- it arrives slightly later via these dedicated
        // events instead. The mobile player already relies on both; the TV
        // player previously only read tracks off `onLoad`, which is why
        // the Audio/Subtitle picker often came up with no "en"/"hi" text
        // to show.
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

      {/* Invisible full-screen focus target used while controls are
          hidden. IMPORTANT: this only reveals controls on `onPress`
          (an actual OK/select button press) -- not `onFocus`. Since this
          is the only focusable element on screen while hidden, it also
          receives focus automatically the instant it mounts (Android's
          "preferred focus" behavior fires with no real user input at
          all). Wiring `onFocus` to reveal controls here previously
          created an infinite loop: hide -> this mounts -> auto-focuses
          itself -> reveals controls again -> hides again 3s later --
          repeating forever, which is the "blinking every 3 seconds" bug.
          Directional D-pad presses can't be distinguished from a plain
          "select" press without a global key listener, which isn't
          available in plain React Native (see the note further down) --
          so pressing the OK/center button is what brings the controls
          back. */}
      {!showControls && (
        <TVFocusablePressable
          hasTVPreferredFocus
          style={StyleSheet.absoluteFillObject}
          onPress={handleCatcherPress}
          focusedBorderColor="transparent"
          scaleFocused={1}
        >
          {() => <View style={StyleSheet.absoluteFillObject} />}
        </TVFocusablePressable>
      )}

      {/* Transparent Bottom Player Controls Overlay */}
      {showControls && (
        <View style={styles.controlsWrapper}>
          <View style={styles.controlsContent}>
            {/* Title */}
            <Text numberOfLines={1} style={styles.mediaTitle}>
              {title}
            </Text>

            {/* Seekbar & Time -- now a real focusable/selectable control
                (previously a plain View, which is why the remote could
                never land on it). Pressing it seeks forward 10s; the
                dedicated rewind/forward buttons remain the primary way to
                seek by exact increments, since a focused-but-idle element
                can't detect held left/right without a native key
                listener (see note near the invisible focus catcher). */}
            <TVFocusablePressable
              scaleFocused={1.02}
              focusedBorderColor="#8A5CF6"
              borderRadius={6}
              onFocus={() => resetInactivityTimer()}
              onPress={() => handleSeek(10)}
              style={styles.progressContainer}
            >
              {() => (
                <View>
                  <View style={styles.progressTrack}>
                    <View
                      style={[
                        styles.progressFill,
                        { width: duration > 0 ? `${(currentTime / duration) * 100}%` : '0%' },
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

              {/* 10s Rewind */}
              <TVFocusablePressable
                scaleFocused={1.12}
                focusedBorderColor="#8A5CF6"
                borderRadius={8}
                onFocus={() => resetInactivityTimer()}
                onPress={() => handleSeek(-10)}
                style={styles.controlBtn}
              >
                {() => <MaterialCommunityIcons name="rewind-10" size={24} color="#FFFFFF" />}
              </TVFocusablePressable>

              {/* 10s Forward */}
              <TVFocusablePressable
                scaleFocused={1.12}
                focusedBorderColor="#8A5CF6"
                borderRadius={8}
                onFocus={() => resetInactivityTimer()}
                onPress={() => handleSeek(10)}
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

              {/* Aspect Ratio */}
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
  },
  progressTrack: {
    width: '100%',
    height: 4,
    backgroundColor: 'rgba(255, 255, 255, 0.25)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#8A5CF6',
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
    width: 440,
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
