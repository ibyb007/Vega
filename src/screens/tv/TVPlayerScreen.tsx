import React, { useRef, useState, useEffect, useCallback, useMemo } from 'react';
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
import Video, { VideoRef, SelectedTrackType, ResizeMode, BufferingStrategyType } from 'react-native-video';
import LinearGradient from 'react-native-linear-gradient';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import KeyEvent from 'react-native-keyevent';
import { TVFocusablePressable } from '../../components/tv/TVFocusablePressable';
import useContentStore from '../../lib/zustand/contentStore';
import useContinueWatchingStore from '../../lib/zustand/continueWatchingStore';
import useSettingsStore, { AudioBoostProfile } from '../../lib/zustand/settingsStore';
import { providerManager } from '../../lib/services/ProviderManager';
import { launchVideo } from '../../lib/services/PlayerLauncher';
import { settingsStorage } from '../../lib/storage';
import type { EpisodeLink, TextTracks } from '../../lib/providers/types';

// Android hardware key codes used by the global listener below.
// (react-native-keyevent reports raw Android KeyEvent.KEYCODE_* values.)
const KEYCODE_DPAD_UP = 19;
const KEYCODE_DPAD_DOWN = 20;
const KEYCODE_DPAD_LEFT = 21;
const KEYCODE_DPAD_RIGHT = 22;

// Post-decode gain (dB) applied via the native LoudnessEnhancer effect for each profile.
// 'off' must stay at 0 so applyAudioBoostGain() on the native side disables the effect
// entirely rather than attaching it with a zero target gain.
const AUDIO_BOOST_GAIN_DB: Record<AudioBoostProfile, number> = {
  off: 0,
  dialogue: 6,
  rich: 12,
};
const KEYCODE_DPAD_CENTER = 23;
const KEYCODE_ENTER = 66;
const KEYCODE_MEDIA_PLAY_PAUSE = 85;
const KEYCODE_BACK = 4;

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English', hi: 'Hindi', es: 'Spanish', fr: 'French', de: 'German',
  it: 'Italian', pt: 'Portuguese', ru: 'Russian', ja: 'Japanese', ko: 'Korean',
  zh: 'Chinese', ar: 'Arabic', ta: 'Tamil', te: 'Telugu', ml: 'Malayalam',
  kn: 'Kannada', bn: 'Bengali', mr: 'Marathi', pa: 'Punjabi', ur: 'Urdu',
  tr: 'Turkish', pl: 'Polish', nl: 'Dutch', th: 'Thai', vi: 'Vietnamese',
  id: 'Indonesian', ms: 'Malay', fa: 'Persian', he: 'Hebrew', uk: 'Ukrainian',
};

const isQualityExcluded = (
  target: string | undefined | null,
  excludedList: string[],
): boolean => {
  if (!target || !excludedList || excludedList.length === 0) return false;
  const text = target.toLowerCase().trim();

  return excludedList.some((ex) => {
    const exLower = ex.toLowerCase().trim();
    if (!exLower) return false;

    if (exLower === '4k' || exLower === '2160p' || exLower === '2160') {
      return text.includes('4k') || text.includes('2160');
    }
    const cleanNum = exLower.replace('p', '');
    return text.includes(exLower) || (cleanNum.length >= 3 && text.includes(cleanNum));
  });
};

const describeTrack = (trk: any, fallbackLabel: string): string => {
  if (!trk) return fallbackLabel;
  const rawTitle = (trk?.title || trk?.label || '').trim();
  const rawLang = (trk?.language || trk?.lang || '').toLowerCase().trim();

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

// Words that show up in subtitle filenames/titles but aren't a language
// (hearing-impaired/forced/codec tags etc.) - never treated as the language itself.
const NON_LANGUAGE_TAGS = new Set([
  'sdh', 'cc', 'forced', 'full', 'default', 'hi', 'vo', 'dub', 'dubbed',
  'ac3', 'dts', 'aac', '5.1', '2.0', 'sub', 'subs', 'subtitle', 'subtitles',
]);

const describeTrackCompact = (trk: any, fallbackLabel: string): string => {
  if (!trk) return fallbackLabel;
  const rawTitle = (trk?.title || trk?.label || '').trim();
  const rawLang = (trk?.language || trk?.lang || '').toLowerCase().trim();

  for (const lang of Object.values(LANGUAGE_NAMES)) {
    const re = new RegExp(`\\b${lang}\\b`, 'i');
    if (re.test(rawTitle)) return lang;
  }

  const code = rawLang.slice(0, 2);
  if (LANGUAGE_NAMES[code]) return LANGUAGE_NAMES[code];

  const bracketMatch = rawTitle.match(/\[([^\]]+)\]/) || rawTitle.match(/\(([^)]+)\)/);
  if (bracketMatch) {
    const inner = bracketMatch[1].trim();
    if (inner && !NON_LANGUAGE_TAGS.has(inner.toLowerCase())) {
      return inner.charAt(0).toUpperCase() + inner.slice(1).toLowerCase();
    }
  }

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
  sourceType?: string;
  subtitles?: TextTracks;
  qualities?: { name: string; url: string; headers?: Record<string, string>; sourceType?: string }[];
}

interface TVPlayerScreenProps {
  streamUrl: string;
  title: string;
  posterUrl?: string;
  itemLink?: string;
  episodeId?: string;
  providerValue?: string;
  headers?: Record<string, string>;
  sourceType?: string;
  subtitles?: TextTracks;
  episodes?: EpisodeItem[];
  currentEpisodeIndex?: number;
  servers?: { name: string; url: string; headers?: Record<string, string>; sourceType?: string }[];
  qualities?: { name: string; url: string; headers?: Record<string, string>; sourceType?: string }[];
  startPosition?: number;
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
  episodeId,
  providerValue,
  headers,
  sourceType,
  subtitles,
  episodes = [],
  currentEpisodeIndex = 0,
  servers = [],
  qualities = [],
  startPosition,
  onSelectNextEpisode,
  onSelectServer,
  onSelectQuality,
  onClose,
}) => {
  const videoRef = useRef<VideoRef>(null);

  // Audio Profile state from zustand
  const audioBoostProfile = useSettingsStore((state) => state.audioBoostProfile);
  const cycleAudioBoostProfile = useSettingsStore((state) => state.cycleAudioBoostProfile);

  const bufferConfig = useMemo(
    () => ({
      minBufferMs: 8000,
      maxBufferMs: 20000,
      bufferForPlaybackMs: 1500,
      bufferForPlaybackAfterRebufferMs: 3000,
      backBufferDurationMs: 0,
      maxHeapAllocationPercent: 0.18,
      minBufferMemoryReservePercent: 0.2,
      minBackBufferMemoryReservePercent: 0.25,
      cacheSizeMB: 0,
    }),
    []
  );

  const seekbarRef = useRef<View>(null);
  const [seekbarSelfTag, setSeekbarSelfTag] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (seekbarRef.current) {
      const tag = findNodeHandle(seekbarRef.current);
      if (tag) setSeekbarSelfTag(tag);
    }
  }, []);

  const initialSeekAppliedRef = useRef(false);
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
  const [showControls, setShowControls] = useState(false);
  const [isSeekbarFocused, setIsSeekbarFocused] = useState(false);
  const [isSeeking, setIsSeeking] = useState(false);

  const [resizeMode, setResizeMode] = useState<AspectRatioMode>('contain');
  const [audioTracks, setAudioTracks] = useState<any[]>([]);
  const [textTracks, setTextTracks] = useState<any[]>([]);
  const [selectedAudio, setSelectedAudio] = useState<any>({ type: SelectedTrackType.INDEX, value: 0 });
  const [selectedSub, setSelectedSub] = useState<any>({ type: SelectedTrackType.DISABLED });
  const [activeMediaUrl, setActiveMediaUrl] = useState<string>(streamUrl);
  const [activeHeaders, setActiveHeaders] = useState<Record<string, string> | undefined>(headers);
  const [activeSourceType, setActiveSourceType] = useState<string | undefined>(sourceType);
  const [resolvingNextEpisode, setResolvingNextEpisode] = useState(false);

  const [activeDialog, setActiveDialog] = useState<DialogType>(null);

  const excludedQualities = useMemo(
    () => settingsStorage.getExcludedQualities() || [],
    [],
  );

  const usableQualities = useMemo(() => {
    if (!qualities || qualities.length === 0) return [];
    if (!excludedQualities || excludedQualities.length === 0) return qualities;

    const filtered = qualities.filter(
      (q) => !isQualityExcluded(q.name, excludedQualities),
    );
    return filtered.length > 0 ? filtered : qualities;
  }, [qualities, excludedQualities]);

  const prevStreamUrlRef = useRef(streamUrl);
  const pendingRecoverySeekRef = useRef<number | null>(null);
  const recoveryAttemptsRef = useRef(0);

  useEffect(() => {
    if (streamUrl && streamUrl !== prevStreamUrlRef.current) {
      prevStreamUrlRef.current = streamUrl;
      recoveryAttemptsRef.current = 0;
      setActiveMediaUrl(streamUrl);
      setActiveHeaders(headers);
      setActiveSourceType(sourceType);
      setBuffering(true);
      setCurrentTime(0);
      setDuration(0);
      setPaused(false);
      currentProgRef.current = { currentTime: 0, duration: 0 };
    }
  }, [streamUrl, headers, sourceType]);

  const videoSource = useMemo(
    () => ({
      uri: activeMediaUrl || streamUrl,
      headers: activeHeaders,
      ...(activeSourceType === 'm3u8' ? { type: 'm3u8' as const } : {}),
      ...(activeSourceType === 'mpd' ? { type: 'mpd' as const } : {}),
    }),
    [activeMediaUrl, streamUrl, activeHeaders, activeSourceType]
  );

  const autoSelectEnglishSubtitle = useCallback((tracks: any[]) => {
    if (userChoseSubtitleRef.current || hasAutoSelectedSubtitleRef.current) return;
    hasAutoSelectedSubtitleRef.current = true;

    if (!tracks || tracks.length === 0) return;
    const enIndex = tracks.findIndex((t: any) => {
      const lang = (t.language || t.lang || '').toLowerCase();
      const titleStr = (t.title || t.label || '').toLowerCase();
      return lang.startsWith('en') || titleStr.includes('english') || titleStr.includes('[en');
    });

    if (enIndex !== -1) {
      setSelectedSub({
        type: SelectedTrackType.INDEX,
        value: enIndex,
      });
    }
  }, []);

  const lastSeekDirection = useRef<'left' | 'right' | null>(null);
  const lastSeekTimestamp = useRef<number>(0);
  const seekStreak = useRef<number>(0);
  const seekReleaseTimer = useRef<NodeJS.Timeout | null>(null);
  const holdSeekInterval = useRef<NodeJS.Timeout | null>(null);

  const hasAutoSelectedSubtitleRef = useRef(false);
  const userChoseSubtitleRef = useRef(false);

  const upsertContinueWatching = useContinueWatchingStore((state) => state.upsertItem);
  const continueWatchingId = episodeId || itemLink || streamUrl;

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
        infoUrl: itemLink || continueWatchingId,
        position: Math.floor(timeSec),
        duration: Math.floor(totalDur),
        updatedAt: Date.now(),
      });
    },
    [continueWatchingId, itemLink, episodes, currentEpisodeIndex, title, posterUrl, providerValue, upsertContinueWatching]
  );

  useEffect(() => {
    return () => {
      if (currentProgRef.current.duration > 0) {
        syncProgressToStore(
          currentProgRef.current.currentTime,
          currentProgRef.current.duration
        );
      }
      if (seekReleaseTimer.current) clearTimeout(seekReleaseTimer.current);
    };
  }, [syncProgressToStore]);

  const resetInactivityTimer = useCallback(() => {
    if (hideControlsTimer.current) {
      clearTimeout(hideControlsTimer.current);
    }
    setShowControls(true);
    hideControlsTimer.current = setTimeout(() => {
      setShowControls((prev) => (activeDialog ? true : false));
      setIsSeekbarFocused(false);
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

  const handleContinuousDPadSeek = useCallback((dir: 'left' | 'right') => {
    resetInactivityTimer();
    setIsSeeking(true);
    const now = Date.now();
    const isRapidRepeat = lastSeekDirection.current === dir && now - lastSeekTimestamp.current < 450;

    if (isRapidRepeat) {
      seekStreak.current += 1;
    } else {
      seekStreak.current = 1;
    }

    lastSeekDirection.current = dir;
    lastSeekTimestamp.current = now;

    if (seekReleaseTimer.current) clearTimeout(seekReleaseTimer.current);
    seekReleaseTimer.current = setTimeout(() => {
      seekStreak.current = 0;
      lastSeekDirection.current = null;
      setIsSeeking(false);
    }, 500);

    let step = 10;
    if (seekStreak.current > 8) step = 45;
    else if (seekStreak.current > 4) step = 25;

    handleSeek(dir === 'right' ? step : -step);
  }, [handleSeek, resetInactivityTimer]);

  const holdFiredRef = useRef(false);

  const startHoldSeek = useCallback((dir: 'left' | 'right') => {
    holdFiredRef.current = false;
    if (holdSeekInterval.current) clearTimeout(holdSeekInterval.current);

    const tick = () => {
      holdFiredRef.current = true;
      handleContinuousDPadSeek(dir);
      holdSeekInterval.current = setTimeout(tick, 220);
    };
    holdSeekInterval.current = setTimeout(tick, 350);
  }, [handleContinuousDPadSeek]);

  const stopHoldSeek = useCallback(() => {
    if (holdSeekInterval.current) {
      clearTimeout(holdSeekInterval.current);
      holdSeekInterval.current = null;
    }
    if (seekReleaseTimer.current) {
      clearTimeout(seekReleaseTimer.current);
      seekReleaseTimer.current = null;
    }
    seekStreak.current = 0;
    lastSeekDirection.current = null;
    setIsSeeking(false);
  }, []);

  useEffect(() => {
    return () => {
      if (holdSeekInterval.current) clearTimeout(holdSeekInterval.current);
    };
  }, []);

  const handleCatcherPress = useCallback(() => {
    setPaused((prev) => {
      const next = !prev;
      syncProgressToStore(currentProgRef.current.currentTime, currentProgRef.current.duration);
      return next;
    });
    resetInactivityTimer();
  }, [resetInactivityTimer, syncProgressToStore]);

  const handleCycleAudioBoost = useCallback(() => {
    resetInactivityTimer();
    const nextMode = cycleAudioBoostProfile();
    const label =
      nextMode === 'rich'
        ? 'Audio Boost: Rich & Immersive (+12dB)'
        : nextMode === 'dialogue'
        ? 'Audio Boost: Dialogue / Night Mode (+6dB)'
        : 'Audio Boost: Standard (Off)';
    ToastAndroid.show(label, ToastAndroid.SHORT);
  }, [cycleAudioBoostProfile, resetInactivityTimer]);

  const audioBoostGain = useMemo(() => AUDIO_BOOST_GAIN_DB[audioBoostProfile], [audioBoostProfile]);

  const activeDialogRef = useRef(activeDialog);
  activeDialogRef.current = activeDialog;
  const showControlsRef = useRef(showControls);
  showControlsRef.current = showControls;
  const isSeekbarFocusedRef = useRef(isSeekbarFocused);
  isSeekbarFocusedRef.current = isSeekbarFocused;
  const isSeekingRef = useRef(isSeeking);
  isSeekingRef.current = isSeeking;
  const handleContinuousDPadSeekRef = useRef(handleContinuousDPadSeek);
  handleContinuousDPadSeekRef.current = handleContinuousDPadSeek;
  const handleCatcherPressRef = useRef(handleCatcherPress);
  handleCatcherPressRef.current = handleCatcherPress;
  const resetInactivityTimerRef = useRef(resetInactivityTimer);
  resetInactivityTimerRef.current = resetInactivityTimer;

  useEffect(() => {
    const handleKeyDown = (keyEvent: { keyCode?: number }) => {
      const keyCode = keyEvent?.keyCode;
      if (keyCode == null) return;
      if (activeDialogRef.current) return;
      if (keyCode === KEYCODE_BACK) return;

      const isLeft = keyCode === KEYCODE_DPAD_LEFT;
      const isRight = keyCode === KEYCODE_DPAD_RIGHT;
      const isUp = keyCode === KEYCODE_DPAD_UP;
      const isDown = keyCode === KEYCODE_DPAD_DOWN;
      const isSelect = keyCode === KEYCODE_DPAD_CENTER || keyCode === KEYCODE_ENTER;
      const isPlayPause = keyCode === KEYCODE_MEDIA_PLAY_PAUSE;

      if (!showControlsRef.current || isSeekingRef.current) {
        if (isRight) {
          handleContinuousDPadSeekRef.current('right');
        } else if (isLeft) {
          handleContinuousDPadSeekRef.current('left');
        } else if (isSelect || isPlayPause) {
          handleCatcherPressRef.current();
        } else {
          resetInactivityTimerRef.current();
        }
      } else {
        if (isSeekbarFocusedRef.current && (isLeft || isRight)) {
          handleContinuousDPadSeekRef.current(isRight ? 'right' : 'left');
          return;
        }
        if (isUp || isDown || isLeft || isRight || isSelect) {
          resetInactivityTimerRef.current();
        }
      }
    };

    const handleKeyUp = (keyEvent: { keyCode?: number }) => {
      const keyCode = keyEvent?.keyCode;
      if (keyCode == null) return;
      const isSeekKey =
        keyCode === KEYCODE_DPAD_LEFT ||
        keyCode === KEYCODE_DPAD_RIGHT ||
        keyCode === KEYCODE_DPAD_CENTER ||
        keyCode === KEYCODE_ENTER;
      if (!isSeekKey) return;

      if (holdSeekInterval.current) {
        clearTimeout(holdSeekInterval.current);
        holdSeekInterval.current = null;
      }
      if (seekReleaseTimer.current) {
        clearTimeout(seekReleaseTimer.current);
        seekReleaseTimer.current = null;
      }
      seekStreak.current = 0;
      lastSeekDirection.current = null;
      setIsSeeking(false);
      resetInactivityTimerRef.current();
    };

    KeyEvent.onKeyDownListener(handleKeyDown);
    KeyEvent.onKeyUpListener(handleKeyUp);
    return () => {
      KeyEvent.removeKeyDownListener();
      KeyEvent.removeKeyUpListener();
    };
  }, []);

  useEffect(() => {
    const handleBackPress = () => {
      if (activeDialog) {
        setActiveDialog(null);
        resetInactivityTimer();
        return true;
      }
      if (showControls) {
        setShowControls(false);
        setIsSeekbarFocused(false);
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
    await launchVideo(activeMediaUrl || streamUrl, title, 'vlc', activeHeaders);
  };

  const handleNextEpisode = async () => {
    if (resolvingNextEpisode) return;

    syncProgressToStore(
      currentProgRef.current.currentTime,
      currentProgRef.current.duration
    );
    const nextIndex = currentEpisodeIndex + 1;
    if (episodes.length <= nextIndex) {
      ToastAndroid.show(
        episodes.length > 0 ? 'That was the last episode.' : 'Playback finished.',
        ToastAndroid.SHORT
      );
      onClose();
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
        headers: s.headers,
        sourceType: s.type,
      }));

      onSelectNextEpisode?.({
        ...nextEp,
        title: nextTitle,
        url: best.link,
        headers: best.headers,
        sourceType: best.type,
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
        ref={videoRef}
        source={videoSource}
        style={StyleSheet.absoluteFill}
        resizeMode={resizeMode as ResizeMode}
        paused={paused}
        bufferConfig={bufferConfig}
        bufferingStrategy={BufferingStrategyType.DEPENDING_ON_MEMORY}
        selectedAudioTrack={selectedAudio}
        selectedTextTrack={selectedSub}
        textTracks={subtitles}
        audioBoostGain={audioBoostGain}
        subtitleStyle={{
          backgroundColor: 'transparent',
          opacity: 0,
          fontSize: 28,
          subtitlesFollowVideo: true,
          paddingBottom: 45,
        }}
        onLoad={(meta: any) => {
          const totalDur = meta.duration || 0;
          setDuration(totalDur);
          currentProgRef.current.duration = totalDur;
          if (meta.audioTracks?.length) setAudioTracks(meta.audioTracks);
          if (meta.textTracks?.length) {
            setTextTracks(meta.textTracks);
            autoSelectEnglishSubtitle(meta.textTracks);
          }
          setBuffering(false);

          if (pendingRecoverySeekRef.current != null) {
            const resumeAt = pendingRecoverySeekRef.current;
            pendingRecoverySeekRef.current = null;
            videoRef.current?.seek(resumeAt);
            setCurrentTime(resumeAt);
            currentProgRef.current.currentTime = resumeAt;
          } else if (!initialSeekAppliedRef.current) {
            initialSeekAppliedRef.current = true;
            if (startPosition && startPosition > 1) {
              videoRef.current?.seek(startPosition);
              setCurrentTime(startPosition);
              currentProgRef.current.currentTime = startPosition;
            }
          }
        }}
        onAudioTracks={(e: any) => {
          if (e?.audioTracks?.length) setAudioTracks(e.audioTracks);
        }}
        onTextTracks={(e: any) => {
          if (e?.textTracks?.length) {
            setTextTracks(e.textTracks);
            autoSelectEnglishSubtitle(e.textTracks);
          }
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
        onEnd={() => {
          handleNextEpisode();
        }}
        onError={async (err) => {
          const nearEnd = duration > 0 && duration - currentProgRef.current.currentTime <= 75;
          const isIoError =
            err.error?.errorCode?.toString().includes('IO_UNEXPECTED') ||
            err.error?.errorString?.includes('IO_UNEXPECTED') ||
            err.error?.errorString?.includes('BehindLiveWindowException') ||
            err.error?.errorString?.includes('ParsingException');

          if (nearEnd && isIoError) {
            handleNextEpisode();
            return;
          }

          const recoveryLink = episodes[currentEpisodeIndex]?.link || itemLink;
          if (isIoError && recoveryLink && providerValue && recoveryAttemptsRef.current < 2) {
            recoveryAttemptsRef.current += 1;
            const resumeAt = currentProgRef.current.currentTime;
            setBuffering(true);
            ToastAndroid.show('Connection dropped, reconnecting...', ToastAndroid.SHORT);
            try {
              const freshStreams = await providerManager.getStream({
                link: recoveryLink,
                type: episodes.length > 0 ? 'series' : 'movie',
                providerValue,
              });
              const fresh = freshStreams?.[0];
              if (fresh?.link) {
                pendingRecoverySeekRef.current = resumeAt;
                setActiveMediaUrl(fresh.link);
                setActiveHeaders(fresh.headers);
                setActiveSourceType(fresh.type);
                return;
              }
            } catch (e) {
              console.warn('[TVPlayerScreen] Stream recovery failed:', e);
            }
            setBuffering(false);
          }

          ToastAndroid.show(`Playback error: ${err.error?.errorString || 'Failed to play stream'}`, ToastAndroid.LONG);
          setBuffering(false);
        }}
      />

      {buffering && (
        <View style={styles.centerLoading}>
          <ActivityIndicator size="large" color="#8A5CF6" />
        </View>
      )}

      {(!showControls || isSeeking) && (
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

      {isSeeking && (
        <View style={styles.seekOverlay} pointerEvents="none">
          <LinearGradient
            colors={['transparent', 'rgba(0, 0, 0, 0.4)', 'rgba(0, 0, 0, 0.85)']}
            locations={[0, 0.4, 1]}
            style={styles.gradientOverlay}
          />
          <View style={styles.controlsContent}>
            <View style={styles.seekIndicatorRow}>
              <MaterialCommunityIcons
                name={lastSeekDirection.current === 'left' ? 'rewind' : 'fast-forward'}
                size={22}
                color="#8A5CF6"
              />
              <Text style={styles.seekIndicatorText}>{formatTime(currentTime)}</Text>
              <Text style={styles.timeText}> / {formatTime(duration)}</Text>
            </View>
            <View style={styles.progressTrack}>
              <View
                style={[
                  styles.progressFill,
                  { width: duration > 0 ? `${(currentTime / duration) * 100}%` : '0%' },
                ]}
              />
            </View>
          </View>
        </View>
      )}

      {/* Bottom Controls Overlay */}
      {showControls && !isSeeking && (
        <View style={styles.controlsWrapper}>
          <LinearGradient
            colors={['transparent', 'rgba(0, 0, 0, 0.4)', 'rgba(0, 0, 0, 0.85)']}
            locations={[0, 0.4, 1]}
            style={styles.gradientOverlay}
          />

          <View style={styles.controlsContent}>
            {/* Title */}
            <Text numberOfLines={1} style={styles.mediaTitle}>
              {episodes[currentEpisodeIndex]?.title &&
              episodes[currentEpisodeIndex].title !== title
                ? `${title} • ${episodes[currentEpisodeIndex].title}`
                : title}
            </Text>

            {/* Seekbar Container */}
            <View style={styles.progressContainer}>
              <TVFocusablePressable
                ref={seekbarRef}
                nextFocusLeft={seekbarSelfTag}
                nextFocusRight={seekbarSelfTag}
                scaleFocused={1}
                focusedBorderColor="transparent"
                borderRadius={0}
                onFocusChange={(f) => setIsSeekbarFocused(f)}
                onFocus={() => resetInactivityTimer()}
                onPress={() => handleSeek(15)}
                style={styles.progressHitArea}
              >
                {({ focused }) => {
                  const active = focused || isSeeking;
                  return (
                    <View style={[styles.progressTrack, active && styles.progressTrackFocused]}>
                      <View
                        style={[
                          styles.progressFill,
                          { width: duration > 0 ? `${(currentTime / duration) * 100}%` : '0%' },
                          active && styles.progressFillFocused,
                        ]}
                      />
                      {active && (
                        <View
                          style={[
                            styles.scrubThumb,
                            { left: `${Math.min(99, Math.max(0, duration > 0 ? (currentTime / duration) * 100 : 0))}%` },
                          ]}
                        />
                      )}
                    </View>
                  );
                }}
              </TVFocusablePressable>

              <View style={styles.timeRow}>
                <Text style={styles.timeText}>{formatTime(currentTime)}</Text>
                <Text style={styles.timeText}>{formatTime(duration)}</Text>
              </View>
            </View>

            {/* Bottom Controls Action Strip */}
            <View style={styles.actionRow}>
              {/* Play / Pause */}
              <TVFocusablePressable
                hasTVPreferredFocus={!isSeekbarFocused && !isSeeking}
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
                onPress={() => {
                  if (!holdFiredRef.current) handleSeek(-10);
                }}
                onPressIn={() => startHoldSeek('left')}
                onPressOut={stopHoldSeek}
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
                onPress={() => {
                  if (!holdFiredRef.current) handleSeek(10);
                }}
                onPressIn={() => startHoldSeek('right')}
                onPressOut={stopHoldSeek}
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
                    <Text style={styles.vlcText}>VLC</Text>
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

              {/* Audio Boost Profile Switcher */}
              <TVFocusablePressable
                scaleFocused={1.08}
                focusedBorderColor="#8A5CF6"
                borderRadius={8}
                onFocus={() => resetInactivityTimer()}
                onPress={handleCycleAudioBoost}
                style={[
                  styles.controlPillBtn,
                  audioBoostProfile !== 'off' && styles.activePillBtn,
                ]}
              >
                {() => (
                  <View style={styles.pillInner}>
                    <MaterialCommunityIcons
                      name={
                        audioBoostProfile === 'rich'
                          ? 'surround-sound'
                          : audioBoostProfile === 'dialogue'
                          ? 'account-voice'
                          : 'volume-medium'
                      }
                      size={20}
                      color={audioBoostProfile !== 'off' ? '#A78BFA' : '#9CA3AF'}
                    />
                    <Text
                      style={[
                        styles.pillText,
                        audioBoostProfile !== 'off' && styles.activePillText,
                      ]}
                    >
                      {audioBoostProfile === 'rich'
                        ? 'Rich Boost'
                        : audioBoostProfile === 'dialogue'
                        ? 'Dialogue Boost'
                        : 'Audio Boost'}
                    </Text>
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
                        : describeTrackCompact(textTracks[selectedSub.value], 'Subtitles')}
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
              {usableQualities.length > 0 && (
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

              {/* Aspect Ratio Mode Toggle */}
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
              {activeDialog === 'subtitles' && (
                <>
                  <TVFocusablePressable
                    hasTVPreferredFocus={true}
                    scaleFocused={1.03}
                    focusedBorderColor="#8A5CF6"
                    borderRadius={8}
                    onPress={() => {
                      userChoseSubtitleRef.current = true;
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
                        userChoseSubtitleRef.current = true;
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
                      const resumeAt = currentProgRef.current.currentTime || currentTime;
                      pendingRecoverySeekRef.current = resumeAt;
                      setActiveMediaUrl(srv.url);
                      setActiveHeaders(srv.headers);
                      setActiveSourceType(srv.sourceType);
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
                usableQualities.map((q, i) => (
                  <TVFocusablePressable
                    key={`quality-${i}`}
                    hasTVPreferredFocus={i === 0}
                    scaleFocused={1.03}
                    focusedBorderColor="#8A5CF6"
                    borderRadius={8}
                    onPress={() => {
                      const resumeAt = currentProgRef.current.currentTime || currentTime;
                      pendingRecoverySeekRef.current = resumeAt;
                      setActiveMediaUrl(q.url);
                      setActiveHeaders(q.headers);
                      setActiveSourceType(q.sourceType);
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
    height: 120,
    justifyContent: 'flex-end',
  },
  gradientOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 120,
  },
  seekOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 120,
    justifyContent: 'flex-end',
  },
  seekIndicatorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
  },
  seekIndicatorText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  controlsContent: {
    paddingHorizontal: 40,
    paddingBottom: 16,
    zIndex: 10,
  },
  mediaTitle: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '800',
    marginBottom: 6,
    textShadowColor: 'rgba(0,0,0,0.95)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  progressContainer: {
    marginBottom: 8,
  },
  progressHitArea: {
    paddingVertical: 4,
    justifyContent: 'center',
  },
  progressTrack: {
    width: '100%',
    height: 4,
    backgroundColor: 'rgba(255, 255, 255, 0.3)',
    borderRadius: 2,
    position: 'relative',
  },
  progressTrackFocused: {
    height: 6,
    backgroundColor: 'rgba(255, 255, 255, 0.5)',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#8A5CF6',
    borderRadius: 2,
  },
  progressFillFocused: {
    backgroundColor: '#A78BFA',
  },
  scrubThumb: {
    position: 'absolute',
    top: -4,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#FFFFFF',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.5,
    shadowRadius: 2,
  },
  timeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  timeText: {
    color: '#D1D5DB',
    fontSize: 12,
    fontWeight: '600',
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
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
  activePillBtn: {
    backgroundColor: 'rgba(138, 92, 246, 0.25)',
    borderWidth: 1,
    borderColor: '#8A5CF6',
  },
  activePillText: {
    color: '#A78BFA',
    fontWeight: '700',
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
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  vlcBtnInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
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

export default TVPlayerScreen;
