import React, { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  Image,
  StyleSheet,
  ActivityIndicator,
  ToastAndroid,
  Modal,
  BackHandler,
  ScrollView,
  findNodeHandle,
  useWindowDimensions,
} from 'react-native';
import Video, {
  VideoRef,
  SelectedTrackType,
  SelectedVideoTrackType,
  ResizeMode,
  BufferingStrategyType,
} from 'react-native-video';
import LinearGradient from 'react-native-linear-gradient';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import Svg, { Path } from 'react-native-svg';
import KeyEvent from 'react-native-keyevent';
import { TVFocusablePressable } from '../../components/tv/TVFocusablePressable';
import useContentStore from '../../lib/zustand/contentStore';
import useContinueWatchingStore from '../../lib/zustand/continueWatchingStore';
import useSettingsStore, { AudioBoostProfile } from '../../lib/zustand/settingsStore';
import { providerManager } from '../../lib/services/ProviderManager';
import { launchVideo } from '../../lib/services/PlayerLauncher';
import { settingsStorage } from '../../lib/storage';
import { formatEpisodeLabel as formatSeasonEpisodeLabel } from '../../lib/utils/episodeParsing';
import { fetchIntroDbSegments } from '../../lib/services/theIntroDbService';
import { resolveTmdbId } from '../../lib/services/tmdbIdResolver';
import type { IntroDbSegment } from '../../lib/services/theIntroDbService';
import type { EpisodeLink, TextTracks, SkipInterval } from '../../lib/providers/types';

// Credits that start before this fraction of the runtime are treated as bad
// community data for the "Up Next" trigger -- firing the popup mid-episode
// would be far worse than falling back to the default 120s-before-end.
const MIN_CREDITS_START_FRACTION = 0.5;

// Folds TheIntroDB's fetched segments into whatever the provider's own
// `skip` array already had, without duplicating a type the provider already
// supplied (provider data wins -- it came with the exact stream that's
// playing, TheIntroDB's is matched by title/episode number).
//   intro   -> "Intro"  (drives the Skip Intro popup)
//   recap   -> "Recap"  (drives the Skip Recap popup)
//   credits -> "Outro"  (series only; drives the "Up Next" trigger via the
//              existing `/outro/i` lookup -- the first credits block wins)
const mergeSkipIntervals = (
  provider: SkipInterval[] = [],
  fetched: IntroDbSegment[],
  opts: { isSeries: boolean; durationSec: number }
): SkipInterval[] => {
  const hasType = (re: RegExp) => provider.some((s) => re.test(s.title || ''));
  const additions: SkipInterval[] = [];
  for (const seg of fetched) {
    if (seg.type === 'intro' && !hasType(/intro/i)) {
      additions.push({ title: 'Intro', from: seg.from, to: seg.to });
    } else if (seg.type === 'recap' && !hasType(/recap/i)) {
      additions.push({ title: 'Recap', from: seg.from, to: seg.to });
    }
  }

  if (opts.isSeries && !hasType(/outro/i)) {
    // `fetched` is sorted by start time, so the first credits entry is the
    // main credits block (later ones are typically post-credits scenes).
    const credits = fetched.find((s) => s.type === 'credits');
    if (
      credits &&
      opts.durationSec > 0 &&
      credits.from >= opts.durationSec * MIN_CREDITS_START_FRACTION &&
      credits.from < opts.durationSec
    ) {
      additions.push({ title: 'Outro', from: credits.from, to: credits.to });
    }
  }

  if (additions.length === 0) return provider;
  return [...provider, ...additions].sort((a, b) => a.from - b.from);
};

// A title/episode is treated as "100% watched" for Continue Watching
// purposes once this many seconds or less remain -- matches the common
// "mark as watched near the credits" behaviour instead of only counting an
// exact onEnd fire (which streaks/seeking/IO recovery can skip past).
//
// It's also treated as complete the moment playback enters the "Outro"
// marker (see `skip`/`activeSkip`), whichever of the two comes first --
// some episodes' credits start well before this fallback window, and that
// same marker is what the "Up Next" popup itself uses to appear early.
// Keeping both mechanisms on the same completion condition means clicking
// "Play Now" on Up Next always mark this episode as finished, advances
// Continue Watching to the next episode immediately, and lines up with
// the resume/"finished" state TVDetailsScreen shows for it.
const NEARLY_COMPLETE_THRESHOLD_SECONDS = 180;

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

// ---- Quality badge helpers -------------------------------------------------
// Same idea as the mobile app's getQualityIconName()/formatQuality(), but the
// TV control bar shows a text badge: 4K / QHD / FHD / HD / SD.
type QualityTier = '4K' | 'QHD' | 'FHD' | 'HD' | 'SD';

const tierFromDimensions = (
  height?: number | string,
  width?: number | string,
): QualityTier | null => {
  const h = Number(height) || 0;
  const w = Number(width) || 0;
  if (h <= 0 && w <= 0) return null;

  let tier: QualityTier =
    h >= 1500 ? '4K' : h >= 1200 ? 'QHD' : h >= 1000 ? 'FHD' : h >= 500 ? 'HD' : 'SD';
  if (h <= 0) {
    // Only a width is known.
    tier = w >= 3400 ? '4K' : w >= 2400 ? 'QHD' : w >= 1800 ? 'FHD' : w >= 1200 ? 'HD' : 'SD';
  } else if (w >= 3400 && tier !== '4K') {
    tier = '4K';
  } else if (w >= 1800 && (tier === 'HD' || tier === 'SD')) {
    // Letterboxed / scope encodes (e.g. 1920x800) are still Full HD.
    tier = 'FHD';
  }
  return tier;
};

const tierFromLabel = (label?: string | number | null): QualityTier | null => {
  const s = String(label ?? '').trim().toLowerCase();
  if (!s || s === 'auto') return null;
  if (/8k|4320|4k|uhd|2160/.test(s)) return '4K';
  if (/qhd|1440|\b2k\b/.test(s)) return 'QHD';
  if (/fhd|1080/.test(s)) return 'FHD';
  if (/\bhd\b|720/.test(s)) return 'HD';
  if (/\bsd\b|576|480|360|240|144/.test(s)) return 'SD';
  const n = Number(s.match(/\d+/)?.[0]);
  return n >= 100 ? tierFromDimensions(n) : null;
};

const formatQualityText = (quality: string): string => {
  const q = quality.trim();
  return /^\d{3,4}$/.test(q) ? `${q}p` : q.toUpperCase();
};

// Provider tags for a stream (mirrors the mobile server list).
const extractStreamTags = (stream: any): string[] => {
  const raw: any[] = Array.isArray(stream?.tags)
    ? stream.tags
    : typeof stream?.tag === 'string'
    ? [stream.tag]
    : [];
  const quality = String(stream?.quality ?? '').trim().toLowerCase();
  return raw
    .map((t) => (typeof t === 'string' ? t.trim() : ''))
    .filter((t) => Boolean(t) && t.toLowerCase() !== quality);
};

const describeVideoTrack = (track: any) => {
  const title = track?.height
    ? `${track.height}p`
    : track?.width
    ? `${track.width}p`
    : 'Standard';
  const bitrate = Number(track?.bitrate) || 0;
  const bitrateText = bitrate
    ? bitrate >= 1000000
      ? `${(bitrate / 1000000).toFixed(1)} Mbps`
      : `${Math.round(bitrate / 1000)} kbps`
    : undefined;
  const detail = [
    bitrateText,
    track?.width && track?.height ? `${track.width}x${track.height}` : undefined,
    track?.codecs ? `${track.codecs}` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
  return { title, detail, tier: tierFromDimensions(track?.height, track?.width) };
};

// Full-width row body shared by the source and video-track rows in the
// dialog: wrapped title, optional chips, optional detail line, check mark.
const DialogRowBody: React.FC<{
  title: string;
  chips?: string[];
  detail?: string;
  selected: boolean;
}> = ({ title, chips = [], detail, selected }) => (
  <View style={styles.dialogItemInner}>
    <View style={styles.dialogItemBody}>
      <Text style={[styles.dialogItemText, selected && styles.dialogItemTextSelected]}>
        {title}
      </Text>
      {chips.length > 0 && (
        <View style={styles.dialogChipRow}>
          {chips.map((c, idx) => (
            <View key={`${c}-${idx}`} style={styles.dialogChip}>
              <Text style={styles.dialogChipText}>{c}</Text>
            </View>
          ))}
        </View>
      )}
      {!!detail && <Text style={styles.dialogItemDetail}>{detail}</Text>}
    </View>
    {selected && (
      <MaterialCommunityIcons
        name="check-circle"
        size={20}
        color="#A78BFA"
        style={styles.dialogItemCheck}
      />
    )}
  </View>
);

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

// Stremio's "episodes" control-bar icon (stacked video strips behind a
// play triangle) -- swapped in for the generic "view-list" glyph so the
// Episodes button reads the same as Stremio's own TV player.
const EpisodesIcon: React.FC<{ size: number; color: string }> = ({ size, color }) => (
  <Svg width={size} height={size} viewBox="0 0 512 512">
    <Path
      d="M498.9 158.06V89c.2-6.28-1.4-12.49-4.6-17.78-2.8-4.73-6.7-8.6-11.4-11.21-4.6-2.61-9.9-3.87-15.3-3.64h-.1c-36 .09-72.1.09-108.2 0H247.6c-26.5 0-53 0-79.6-.12-2 .1-4 .36-6 .77-4.7.87-9.1 2.97-12.9 6.1-3.8 3.14-6.7 7.2-8.6 11.84-.7 1.69-1.3 3.45-1.7 5.24-.7 2.66-1.1 5.4-1.2 8.15v33.23h-31.2c-2 .05-4.1.27-6 .65-4.8.87-9.2 2.98-13 6.1-3.7 3.14-6.7 7.2-8.6 11.84-.7 1.69-1.2 3.46-1.7 5.26-.7 2.66-1.1 5.39-1.2 8.15v32.71H42.8c-2 .01-4 .18-6 .5-4.8.87-9.2 2.97-13 6.1-3.7 3.13-6.7 7.19-8.7 11.82-.7 1.71-1.2 3.47-1.7 5.27-.6 2.66-1 5.4-1.1 8.16v194.91c-.2 6.29 1.4 12.5 4.8 17.8 2.7 4.69 6.6 8.54 11.2 11.15 4.7 2.61 9.9 3.88 15.1 3.7h.1c36.4-.12 72.7-.12 109 0h144.6c15.3 0 30.7 0 46 .15 2-.05 4-.26 6-.65 4.8-.9 9.2-2.99 13-6.12s6.7-7.19 8.6-11.82c.7-1.7 1.3-3.46 1.7-5.27l.1-.39c.6-2.55 1-5.18 1-7.82v-32.75c11.1 0 22.1.03 33.1.09 2.1-.04 4.2-.26 6.2-.65 4.7-.87 9.1-2.98 12.9-6.11 3.7-3.12 6.7-7.19 8.6-11.82.7-1.7 1.2-3.47 1.7-5.26l.1-.39c.6-2.57.9-5.19 1-7.83v-33.39c10.4 0 20.8 0 31.2.1 2-.05 4.1-.27 6.1-.66 4.7-.88 9.2-2.97 12.9-6.11 3.8-3.12 6.7-7.18 8.6-11.81.7-1.71 1.3-3.47 1.7-5.27l.1-.41c.6-2.56 1-5.19 1-7.83V158.06zM335.4 289.75v111.06c.2 3.76.3 8.43-5 9.14H57.6c-1 .15-2 .09-3-.19s-1.9-.77-2.7-1.44c-.6-.81-1.1-1.76-1.3-2.78-.3-1.02-.4-2.09-.2-3.14l.2-18.91v-53.34l.1-3.74v-95.1c-.2-4.22-.4-8.92 5-9.61.7-.07 1.3-.1 1.9-.09h270.8q1.5-.24 3 .18c1 .28 1.9.77 2.7 1.45.6.82 1 1.76 1.3 2.78.3 1.03.3 2.08.1 3.12l-.2 18.91v14.77zm63.6-64.68v43.3l.1 67.44v.3c.1 3.77.3 8.45-5.1 9.15-.5 0-1.3 0-2 .1h-18.4v-126.6c.1-4.32-.7-8.61-2.2-12.61s-3.8-7.63-6.7-10.68a30.5 30.5 0 0 0-10.2-7.04c-3.8-1.61-8-2.38-12.1-2.28h-.1c-36.1.11-72.1 0-108.2 0H114.3v-7.63c0-3.95 0-7.91-.1-11.86-.2-4.21-.4-8.91 5-9.59.5 0 1.2 0 1.9-.11H392c1-.15 2-.09 3 .19.9.29 1.8.78 2.6 1.45.7.82 1.1 1.76 1.4 2.77.3 1.02.3 2.09.2 3.13l-.3 18.91v14.77zm61.7-65.05v43.29l.1 67.44v.32c.1 3.77.3 8.45-5.1 9.14-.5 0-1.3 0-2 .11h-16.5V154.05c.1-4.31-.7-8.59-2.2-12.6-1.6-4-3.9-7.63-6.8-10.68-2.9-3.04-6.3-5.44-10.1-7.04-3.8-1.61-7.9-2.38-12.1-2.29h-.1c-36.1.11-72.1.11-108.2 0h-37.4l-74.4.14h-10v-8.15c0-3.97 0-7.93-.1-11.86-.1-4.24-.3-8.91 5.1-9.62.5 0 1.2 0 1.9-.09h271c.9-.16 2-.09 2.9.18 1 .28 1.9.78 2.7 1.45.6.82 1.1 1.77 1.3 2.79.3 1.01.3 2.07.1 3.11l-.2 18.93v14.78z"
      fill={color}
    />
    <Path
      d="m253.8 311.24-81.7 49.65c-.8.51-1.7.78-2.7.78-.9.01-2-.25-2.8-.74-.8-.5-1.5-1.21-2-2.08-.5-.86-.8-1.84-.8-2.85v-99.38c0-1.01.3-1.99.8-2.86.5-.86 1.2-1.57 2-2.07.8-.49 1.9-.76 2.8-.74 1 0 1.9.27 2.7.77l81.7 49.56c.8.51 1.5 1.23 2 2.1.5.88.7 1.87.7 2.88s-.2 2.01-.7 2.88-1.2 1.6-2 2.1"
      fill={color}
      fillRule="evenodd"
      clipRule="evenodd"
    />
  </Svg>
);

interface EpisodeItem {
  id?: string | number;
  title?: string;
  link?: string;
  url?: string;
  type?: string;
  image?: string;
  poster?: string;
  // Per-episode metadata enrichment (Cinemeta, or whatever the caller
  // screen -- e.g. TVDiscoverScreen -- already had in memory) used by the
  // "Videos" episode picker and the "Up Next" popup: synopsis/mini-poster
  // (`image`) plus real season/episode numbers for the "S01E02" label.
  synopsis?: string;
  season?: number;
  episodeNumber?: number;
  releaseDate?: string;
  skip?: SkipInterval[];
}

interface StreamOption {
  name: string;
  url: string;
  headers?: Record<string, string>;
  sourceType?: string;
  // Extra info shown in the picker (same fields the mobile server list shows).
  server?: string;
  quality?: string;
  tags?: string[];
}

interface ResolvedNextEpisode extends EpisodeItem {
  headers?: Record<string, string>;
  sourceType?: string;
  subtitles?: TextTracks;
  qualities?: StreamOption[];
  // Absolute index into `episodes` this resolves to. Omitted for a plain
  // "advance to the next one" (defaults to `currentEpisodeIndex + 1`);
  // set explicitly when jumping to an arbitrary episode picked from the
  // "Videos" list.
  targetIndex?: number;
}

interface TVPlayerScreenProps {
  streamUrl: string;
  title: string;
  posterUrl?: string;
  itemLink?: string;
  episodeId?: string;
  providerValue?: string;
  // Exact label of the season/quality/dub dropdown entry this stream was
  // launched from -- threaded straight into whatever Continue Watching
  // entry this session upserts. See ContinueWatchingItem.linkTitle.
  linkTitle?: string;
  headers?: Record<string, string>;
  sourceType?: string;
  subtitles?: TextTracks;
  episodes?: EpisodeItem[];
  currentEpisodeIndex?: number;
  servers?: StreamOption[];
  qualities?: StreamOption[];
  // Intro/outro/recap markers for the *currently playing* stream (from the
  // provider's `Stream.skip`). When an interval titled "Outro" is present,
  // it's used to time the "Up Next" popup instead of the 90s-remaining
  // fallback.
  skip?: SkipInterval[];
  // Used to look up intro/recap timestamps from TheIntroDB when the
  // provider's own `skip` didn't already supply them. Optional -- when
  // absent, the Skip Intro/Recap popup simply never appears.
  tmdbId?: number | string;
  imdbId?: string;
  // Clean show/movie title (NOT the episode title) and release year, used to
  // work out a tmdbId when the provider didn't supply one -- see
  // lib/services/tmdbIdResolver.ts. Optional; without them (and without ids)
  // the Skip Intro/Recap popup simply never appears.
  mediaTitle?: string;
  mediaYear?: string | number;
  startPosition?: number;
  // Present only when this stream was launched from the Discover screen's
  // page-2 results inspector -- threaded straight through to whatever
  // Continue Watching entry this session upserts so Home can reopen the
  // same Discover results view later instead of the regular details
  // screen. Opaque here; see ContinueWatchingItem.discoverSource.
  discoverSource?: any;
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
  linkTitle,
  headers,
  sourceType,
  subtitles,
  episodes = [],
  currentEpisodeIndex = 0,
  servers = [],
  qualities = [],
  skip,
  tmdbId,
  imdbId,
  mediaTitle,
  mediaYear,
  startPosition,
  discoverSource,
  onSelectNextEpisode,
  onSelectServer,
  onSelectQuality,
  onClose,
}) => {
  const videoRef = useRef<VideoRef>(null);
  // Drives the subtitles/audio/server/quality dialog's dynamic sizing --
  // same approach as TVDetailsScreen's Season/Quality picker.
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();

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
  const [activeSkip, setActiveSkip] = useState<SkipInterval[] | undefined>(skip);
  const [showEpisodesList, setShowEpisodesList] = useState(false);
  const [showNextUpPopup, setShowNextUpPopup] = useState(false);
  // One-shot per episode: flips true the moment the "Up Next" popup has
  // been triggered (whether by outro marker or the 90s fallback) so it
  // never re-appears after the person dismisses it, and resets on the
  // streamUrl-change effect below whenever a new episode actually loads.
  const nextUpTriggeredRef = useRef(false);

  // Skip Intro/Recap popup: holds the interval currently active (if any),
  // so the label ("Skip Intro" vs "Skip Recap") and the seek target are
  // both derived from it. Intro/recap sit well before the outro marker/
  // 90s-remaining window the "Up Next" popup uses, so the two never need
  // to coordinate over who's visible.
  const [activeSkipPopup, setActiveSkipPopup] = useState<SkipInterval | null>(null);
  const skipPopupHideTimer = useRef<NodeJS.Timeout | null>(null);
  // Every interval's `from` that has already been shown+dismissed (by Back,
  // by pressing Skip, or by auto-hide), so seeking back into the same
  // window doesn't re-trigger it -- but a *different* interval (e.g. recap
  // after intro) still can. Reset whenever a new stream/episode loads.
  const shownSkipIntervalsRef = useRef<Set<number>>(new Set());

  const [activeDialog, setActiveDialog] = useState<DialogType>(null);

  // Kept in sync on every render (not just in an effect) so the
  // already-scheduled hide-controls timeout below always sees the latest
  // open/closed state of any dropdown/pop-up (episodes, subtitles, audio,
  // server, quality) even though its callback closure was created earlier.
  const overlayOpenRef = useRef(false);
  overlayOpenRef.current = Boolean(activeDialog) || showEpisodesList;

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

  // Video (resolution) tracks reported by the player, like the mobile app's
  // Quality tab -- plus the decoded size, used to label the quality button.
  const [videoTracks, setVideoTracks] = useState<any[]>([]);
  const [videoSize, setVideoSize] = useState<{ width: number; height: number } | null>(null);
  const [selectedVideoTrack, setSelectedVideoTrack] = useState<any>({
    type: SelectedVideoTrackType.AUTO,
  });
  // null = Auto (adaptive); otherwise an index into `videoTracks`.
  const [selectedTrackListIdx, setSelectedTrackListIdx] = useState<number | null>(null);

  const processVideoTracks = useCallback((tracks: any[]) => {
    if (!tracks || tracks.length === 0) return;
    const seen = new Set<string>();
    const unique = tracks.filter((t) => {
      const key = `${t.bitrate}-${t.height || t.width}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    unique.sort(
      (a, b) => (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0),
    );
    const active = unique.find((t) => t.selected);
    if (active?.height) {
      setVideoSize((prev) =>
        prev?.height === active.height && prev?.width === active.width
          ? prev
          : { width: active.width || 0, height: active.height },
      );
    }
    setVideoTracks((prev) => {
      const k = (list: any[]) =>
        list.map((t) => `${t.index}:${t.height}:${t.width}:${t.bitrate}`).join('|');
      return k(prev) === k(unique) ? prev : unique;
    });
  }, []);

  // A new source means new tracks: clear the old ones so the quality button
  // never shows the previous stream's resolution while the next one loads.
  useEffect(() => {
    setVideoTracks([]);
    setVideoSize(null);
    setSelectedVideoTrack({ type: SelectedVideoTrackType.AUTO });
    setSelectedTrackListIdx(null);
  }, [activeMediaUrl]);

  // Text for the quality button: 4K / QHD / FHD / HD / SD. Prefers what the
  // player is actually decoding, then the provider's own quality tag.
  const qualityBadge = useMemo(() => {
    const activeOption =
      qualities.find((q) => q.url === activeMediaUrl) ||
      servers.find((s) => s.url === activeMediaUrl);
    const chosen = selectedTrackListIdx != null ? videoTracks[selectedTrackListIdx] : undefined;
    const track =
      chosen ??
      (videoTracks.length === 1 ? videoTracks[0] : undefined) ??
      videoTracks.find((t) => t.selected);
    const fromPlayer = tierFromDimensions(
      Number(track?.height) || Number(videoSize?.height) || 0,
      Number(track?.width) || Number(videoSize?.width) || 0,
    );
    if (fromPlayer) return fromPlayer;
    const label = activeOption?.quality || (!activeOption?.server ? activeOption?.name : undefined);
    return tierFromLabel(label) || 'Auto';
  }, [qualities, servers, activeMediaUrl, selectedTrackListIdx, videoTracks, videoSize]);

  const hasTrackChoices = videoTracks.length > 1;
  const qualityOptionCount = usableQualities.length + (hasTrackChoices ? videoTracks.length + 1 : 0);

  // Title + chips for a source row: server name with its quality/tags as
  // chips, like the mobile app's server list (falls back to the old label
  // for entries that carry no extra info).
  const buildSourceRow = (opt: StreamOption, i: number) => {
    const hasServer = !!opt.server?.trim();
    const title = hasServer ? opt.server!.trim() : opt.name || `Source ${i + 1}`;
    const tier = tierFromLabel(opt.quality);
    const chips: string[] = [];
    if (opt.quality) {
      const qText = formatQualityText(String(opt.quality));
      if (hasServer) {
        chips.push(tier && tier.toLowerCase() !== qText.toLowerCase() ? `${tier} · ${qText}` : qText);
      } else if (tier && tier.toLowerCase() !== title.toLowerCase()) {
        chips.push(tier);
      }
    }
    (opt.tags || []).forEach((t) => chips.push(t));
    return { title, chips };
  };

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
      setActiveSkip(skip);
      setBuffering(true);
      setCurrentTime(0);
      setDuration(0);
      setPaused(false);
      currentProgRef.current = { currentTime: 0, duration: 0 };
      nextUpTriggeredRef.current = false;
      setShowNextUpPopup(false);
      shownSkipIntervalsRef.current = new Set();
      if (skipPopupHideTimer.current) clearTimeout(skipPopupHideTimer.current);
      setActiveSkipPopup(null);
    }
  }, [streamUrl, headers, sourceType, skip]);

  // Looks up TheIntroDB for whatever intro/recap/outro markers the provider's
  // own `skip` array didn't already supply. Runs whenever the stream or
  // the episode identity changes; a token guards against a slow response
  // landing after the person has already moved on to a different episode.
  //
  // Many addon providers never supply a tmdbId, and TheIntroDB is far more
  // accurate with one than with an imdb id (especially for TV). So when it's
  // missing, `resolveTmdbId` works one out first (Cinemeta -> TMDB /find ->
  // vetted TMDB title search, cached on-device, see tmdbIdResolver.ts). If
  // that finds nothing, the lookup still proceeds with the imdb id alone.
  //
  // Waits until the player has reported the video duration so the request
  // can carry `duration_ms` -- TheIntroDB uses it to pick the matching
  // release (theatrical vs extended cut, etc.), and it costs one request
  // instead of two. `durationReady` (not `duration`) is the dependency so
  // small duration updates during playback don't trigger refetches, and the
  // value itself is read from `currentProgRef`, which the stream-change
  // reset above zeroes in the same commit -- so a stale duration from the
  // previous stream/episode can never be sent.
  //
  // Dependencies are primitives derived from `episodes` (not the array
  // itself) so a re-created array with the same content can't re-trigger it.
  const introDbFetchTokenRef = useRef(0);
  const durationReady = duration > 0;
  const introIsSeries = episodes.length > 0;
  const introSeason = episodes[currentEpisodeIndex]?.season;
  const introEpisodeNumber = episodes[currentEpisodeIndex]?.episodeNumber;
  useEffect(() => {
    const token = ++introDbFetchTokenRef.current;
    if (!tmdbId && !imdbId && !mediaTitle) return;
    const durationSec = currentProgRef.current.duration;
    if (!durationReady || !(durationSec > 0)) return;

    // A series episode without a known season/episode must not be looked up
    // as a movie (TMDB movie/TV id spaces overlap -> wrong title's markers).
    if (introIsSeries && (introSeason == null || introEpisodeNumber == null)) return;

    (async () => {
      let lookupTmdbId: number | string | undefined = tmdbId;
      if (!lookupTmdbId) {
        const identity = await resolveTmdbId({
          tmdbId,
          imdbId,
          title: mediaTitle,
          year: mediaYear,
          kind: introIsSeries ? 'series' : 'movie',
        });
        // Stream/episode moved on while resolving -- discard.
        if (introDbFetchTokenRef.current !== token) return;
        lookupTmdbId = identity?.tmdbId;
      }
      if (!lookupTmdbId && !imdbId) return;

      const segments = await fetchIntroDbSegments({
        tmdbId: lookupTmdbId,
        imdbId,
        season: introIsSeries ? introSeason : undefined,
        episode: introIsSeries ? introEpisodeNumber : undefined,
        durationSec,
      });
      // Stream/episode moved on before this resolved -- discard.
      if (introDbFetchTokenRef.current !== token) return;
      if (segments.length === 0) return;
      setActiveSkip((prev) =>
        mergeSkipIntervals(prev, segments, { isSeries: introIsSeries, durationSec })
      );
    })();
    // Duration is read from a ref once it first becomes available (see above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    streamUrl,
    tmdbId,
    imdbId,
    mediaTitle,
    mediaYear,
    introIsSeries,
    introSeason,
    introEpisodeNumber,
    durationReady,
  ]);

  useEffect(() => {
    return () => {
      if (skipPopupHideTimer.current) clearTimeout(skipPopupHideTimer.current);
    };
  }, []);

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
  const removeContinueWatching = useContinueWatchingStore((state) => state.removeItem);
  // Row identity is always the content's own info-page link when we have
  // one -- stable no matter which quality/source/episode was actually
  // played -- so progress on the same title always updates one row instead
  // of fragmenting into a new row per quality pick or per screen it was
  // launched from. `episodeId` here is repurposed as the *per-episode*
  // disambiguator (see `episodeKey` below), not the row id.
  const continueWatchingId = itemLink || episodeId || streamUrl;

  const syncProgressToStore = useCallback(
    (timeSec: number, totalDur: number) => {
      if (totalDur <= 0 || timeSec <= 0 || !continueWatchingId) return;

      const isSeries = episodes.length > 0;
      const remaining = totalDur - timeSec;

      // Same "Outro" marker the Up Next popup uses to appear (see the
      // outro-fallback effect above) -- once playback has reached it, the
      // episode counts as finished even if that's well outside the
      // 180-seconds-remaining window below (a long epilogue/credits
      // sequence can start much earlier than that).
      const outroMarker = (activeSkip || []).find((s) => /outro/i.test(s.title || ''));
      const isInOutro = !!outroMarker && timeSec >= outroMarker.from;

      // 180 seconds or less left (or already into the outro) counts as
      // "100% watched": a movie drops off the row entirely, a series
      // episode hands the row over to whatever's next (so Continue
      // Watching always points at something there's actually more of to
      // watch) -- rather than lingering on an entry the person has
      // effectively already finished.
      if (remaining <= NEARLY_COMPLETE_THRESHOLD_SECONDS || isInOutro) {
        if (!isSeries) {
          removeContinueWatching(continueWatchingId);
          return;
        }

        const nextEpisode = episodes[currentEpisodeIndex + 1] as
          | (EpisodeLink & { season?: number; episodeNumber?: number })
          | undefined;
        if (!nextEpisode?.link) {
          // Last episode of the series just finished -- nothing left to
          // resume, so drop the row same as a finished movie.
          removeContinueWatching(continueWatchingId);
          return;
        }

        const nextTitle = nextEpisode.title || title;
        upsertContinueWatching({
          id: continueWatchingId,
          title,
          episodeTitle: nextTitle !== title ? nextTitle : undefined,
          episode: { ...nextEpisode, title: nextTitle },
          episodeKey:
            nextEpisode.season != null && nextEpisode.episodeNumber != null
              ? `S${nextEpisode.season}E${nextEpisode.episodeNumber}`
              : undefined,
          type: 'series',
          poster: posterUrl,
          // Deliberately NOT set to posterUrl: posterUrl is a portrait
          // poster image (especially for entries sourced from Discover,
          // where it falls back to the catalog's own `poster` field), and
          // stretching a portrait image across the Home hero's landscape
          // backdrop area is what produces the "zoomed in poster" look.
          // Leaving this unset lets TVHomeScreen's own Cinemeta enrichment
          // (see updateHeroWithBestMetadata) fetch and fill in the real
          // landscape backdrop for this entry, same as any other row item.
          background: undefined,
          providerValue: providerValue || useContentStore.getState().provider?.value || '',
          infoUrl: itemLink || continueWatchingId,
          linkTitle,
          discoverSource,
          position: 0,
          duration: 0,
          updatedAt: Date.now(),
        });
        return;
      }

      const currentEpisode = episodes[currentEpisodeIndex];
      const episode: EpisodeLink = currentEpisode?.link
        ? {
            ...currentEpisode,
            title: currentEpisode.title || title,
            link: currentEpisode.link,
          }
        : { title, link: continueWatchingId };

      // Stable "S{season}E{episode}" for *this* episode, same format
      // TVDetailsScreen derives per-row -- computed straight from
      // `episodes[currentEpisodeIndex]` (which always tracks whichever
      // episode is actually playing, including after advancing via Up
      // Next/onEnd/the "Videos" list) rather than the `episodeId` prop,
      // which is only ever set once, when the player was first launched,
      // and would otherwise keep tagging every later episode in this
      // session with the episode it was originally opened on -- silently
      // breaking the "Resume" badge/row match on TVDetailsScreen for
      // every episode after the first.
      const currentEpisodeStableKey =
        currentEpisode?.season != null && currentEpisode?.episodeNumber != null
          ? `S${currentEpisode.season}E${currentEpisode.episodeNumber}`
          : undefined;

      upsertContinueWatching({
        id: continueWatchingId,
        title,
        episodeTitle:
          episode.title && episode.title !== title ? episode.title : undefined,
        episode,
        // Only meaningful for series -- a movie has nothing to
        // disambiguate, so leave it unset rather than storing a stray key.
        // `episodeId` is kept only as a fallback for callers that don't
        // enrich episodes with season/episodeNumber.
        episodeKey: isSeries ? currentEpisodeStableKey || episodeId || undefined : undefined,
        type: isSeries ? 'series' : 'movie',
        poster: posterUrl,
        // See the comment on the other upsertContinueWatching call above --
        // left unset on purpose so Home's Cinemeta enrichment supplies the
        // real backdrop instead of a stretched poster.
        background: undefined,
        providerValue: providerValue || useContentStore.getState().provider?.value || '',
        infoUrl: itemLink || continueWatchingId,
        linkTitle,
        discoverSource,
        position: Math.floor(timeSec),
        duration: Math.floor(totalDur),
        updatedAt: Date.now(),
      });
    },
    [
      continueWatchingId,
      itemLink,
      episodeId,
      episodes,
      currentEpisodeIndex,
      activeSkip,
      title,
      posterUrl,
      providerValue,
      linkTitle,
      discoverSource,
      upsertContinueWatching,
      removeContinueWatching,
    ]
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
      // A dropdown/pop-up (episodes, subtitles, audio, server, quality) is
      // open -- leave the control bar showing and don't re-arm the timer;
      // whatever closes the overlay calls resetInactivityTimer() again to
      // restart the normal 3.5s countdown.
      if (overlayOpenRef.current) {
        setShowControls(true);
        return;
      }
      setShowControls(false);
      setIsSeekbarFocused(false);
    }, 3500);
  }, []);

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
  const showNextUpPopupRef = useRef(showNextUpPopup);
  showNextUpPopupRef.current = showNextUpPopup;
  const activeSkipPopupRef = useRef(activeSkipPopup);
  activeSkipPopupRef.current = activeSkipPopup;
  const showEpisodesListRef = useRef(showEpisodesList);
  showEpisodesListRef.current = showEpisodesList;
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
      if (
        activeDialogRef.current ||
        showNextUpPopupRef.current ||
        activeSkipPopupRef.current ||
        showEpisodesListRef.current
      )
        return;
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
      if (activeSkipPopup) {
        if (skipPopupHideTimer.current) clearTimeout(skipPopupHideTimer.current);
        shownSkipIntervalsRef.current.add(activeSkipPopup.from);
        setActiveSkipPopup(null);
        // Deliberately no resetInactivityTimer() here -- this popup never
        // woke the control bar in the first place, so dismissing it
        // shouldn't wake it either.
        return true;
      }
      if (showNextUpPopup) {
        setShowNextUpPopup(false);
        resetInactivityTimer();
        return true;
      }
      if (showEpisodesList) {
        setShowEpisodesList(false);
        resetInactivityTimer();
        return true;
      }
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
  }, [
    activeDialog,
    showControls,
    showNextUpPopup,
    activeSkipPopup,
    showEpisodesList,
    onClose,
    resetInactivityTimer,
    syncProgressToStore,
  ]);

  const openInVLC = async () => {
    await launchVideo(activeMediaUrl || streamUrl, title, 'vlc', activeHeaders);
  };

  // Resolves and plays an arbitrary episode by its absolute index into
  // `episodes` -- shared by the auto "next episode" flow (onEnd / Up Next
  // popup / the physical "skip next" button) and by picking an arbitrary
  // row out of the "Videos" episode list.
  const playEpisodeAtIndex = async (targetIndex: number) => {
    if (resolvingNextEpisode) return;

    syncProgressToStore(
      currentProgRef.current.currentTime,
      currentProgRef.current.duration
    );

    if (targetIndex < 0 || targetIndex >= episodes.length) {
      if (targetIndex >= episodes.length) {
        ToastAndroid.show(
          episodes.length > 0 ? 'That was the last episode.' : 'Playback finished.',
          ToastAndroid.SHORT
        );
        onClose();
      }
      return;
    }

    const targetEp = episodes[targetIndex];
    const targetTitle = targetEp.title || `Episode ${targetIndex + 1}`;

    if (!targetEp.link || !providerValue) {
      ToastAndroid.show('Unable to resolve this episode.', ToastAndroid.SHORT);
      return;
    }

    setResolvingNextEpisode(true);
    ToastAndroid.show(
      `Loading: ${formatSeasonEpisodeLabel(targetEp.season, targetEp.episodeNumber, targetEp.title, targetTitle)}`,
      ToastAndroid.SHORT,
    );
    try {
      const streams = await providerManager.getStream({
        link: targetEp.link,
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
        server: s.server,
        quality: s.quality,
        tags: extractStreamTags(s),
      }));

      onSelectNextEpisode?.({
        ...targetEp,
        title: targetTitle,
        url: best.link,
        headers: best.headers,
        sourceType: best.type,
        subtitles: best.subtitles,
        qualities: qualList,
        skip: best.skip,
        targetIndex,
      });
    } catch (e: any) {
      console.warn('[TVPlayerScreen] Episode extraction failed:', e);
      ToastAndroid.show(e?.message || 'Failed to load episode.', ToastAndroid.LONG);
    } finally {
      setResolvingNextEpisode(false);
    }
  };

  const handleNextEpisode = () => playEpisodeAtIndex(currentEpisodeIndex + 1);

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
  const nextEpisodePreview = hasNextEpisode ? episodes[currentEpisodeIndex + 1] : undefined;

  const formatEpisodeLabel = (ep?: EpisodeItem) =>
    ep ? formatSeasonEpisodeLabel(ep.season, ep.episodeNumber, ep.title, 'Next Episode') : '';

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
        selectedVideoTrack={selectedVideoTrack}
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
          if (meta.naturalSize?.height) {
            setVideoSize({ width: meta.naturalSize.width || 0, height: meta.naturalSize.height });
          }
          if (meta.videoTracks?.length) processVideoTracks(meta.videoTracks);
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
        onVideoTracks={(e: any) => {
          if (e?.videoTracks?.length) processVideoTracks(e.videoTracks);
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

          // "Up Next" popup: fires once per episode, either right when an
          // outro marker (a `skip` interval titled "Outro") starts, or --
          // when no such marker was supplied by the provider -- 120 seconds
          // before the end, whichever data is actually available.
          if (!nextUpTriggeredRef.current && hasNextEpisode && duration > 0) {
            const outroInterval = (activeSkip || []).find(
              (s) => /outro/i.test(s.title || '') && s.from > 0 && s.from < duration
            );
            const triggerAt = outroInterval ? outroInterval.from : duration - 120;
            if (triggerAt >= 0 && prog.currentTime >= triggerAt && duration - prog.currentTime > 1) {
              nextUpTriggeredRef.current = true;
              setShowNextUpPopup(true);
            }
          }

          // Skip Intro/Recap popup: fires the moment playback enters an
          // interval titled "Intro" or "Recap" that hasn't already been
          // shown+dismissed this episode. Only one shows at a time --
          // intro and recap windows don't overlap in practice.
          if (!activeSkipPopupRef.current && !overlayOpenRef.current && !showNextUpPopupRef.current) {
            const hit = (activeSkip || []).find(
              (s) =>
                /intro|recap/i.test(s.title || '') &&
                !shownSkipIntervalsRef.current.has(s.from) &&
                prog.currentTime >= s.from &&
                prog.currentTime < s.to
            );
            if (hit) {
              setActiveSkipPopup(hit);
              if (skipPopupHideTimer.current) clearTimeout(skipPopupHideTimer.current);
              skipPopupHideTimer.current = setTimeout(() => {
                shownSkipIntervalsRef.current.add(hit.from);
                setActiveSkipPopup(null);
              }, 15000);
            }
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
              {(() => {
                const ep = episodes[currentEpisodeIndex];
                if (!ep || (!ep.title && ep.season == null)) return title;
                if (ep.title === title) return title;
                // "Lanterns.S01E01-Pilot" (falls back to the plain episode
                // name when the season/episode numbers aren't known).
                return `${title}.${formatSeasonEpisodeLabel(ep.season, ep.episodeNumber, ep.title, 'Episode')}`;
              })()}
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
                scaleFocused={1.12}
                focusedBorderColor="#8A5CF6"
                borderRadius={8}
                onFocus={() => resetInactivityTimer()}
                onPress={() => setActiveDialog('audio')}
                style={styles.controlBtn}
              >
                {() => <MaterialCommunityIcons name="volume-high" size={22} color="#FFFFFF" />}
              </TVFocusablePressable>

              {/* Audio Boost Profile Switcher */}
              <TVFocusablePressable
                scaleFocused={1.12}
                focusedBorderColor="#8A5CF6"
                borderRadius={8}
                onFocus={() => resetInactivityTimer()}
                onPress={handleCycleAudioBoost}
                style={[
                  styles.controlBtn,
                  audioBoostProfile !== 'off' && styles.activeIconBtn,
                ]}
              >
                {() => (
                  <MaterialCommunityIcons
                    name={
                      audioBoostProfile === 'rich'
                        ? 'surround-sound'
                        : audioBoostProfile === 'dialogue'
                        ? 'account-voice'
                        : 'volume-medium'
                    }
                    size={22}
                    color={audioBoostProfile !== 'off' ? '#A78BFA' : '#9CA3AF'}
                  />
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

              {/* Quality Selector -- label follows the playing stream:
                  4K / QHD / FHD / HD / SD (Auto until it's known). */}
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
                    <Text style={styles.pillText}>{qualityBadge}</Text>
                  </View>
                )}
              </TVFocusablePressable>

              {/* Episodes List */}
              {episodes.length > 0 && (
                <TVFocusablePressable
                  scaleFocused={1.12}
                  focusedBorderColor="#8A5CF6"
                  borderRadius={8}
                  onFocus={() => resetInactivityTimer()}
                  onPress={() => {
                    setShowEpisodesList(true);
                    resetInactivityTimer();
                  }}
                  style={styles.controlBtn}
                >
                  {() => <EpisodesIcon size={22} color="#FFFFFF" />}
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
          {/* Shrink-wraps its content up to 70% of the screen width (same
              rule as TVDetailsScreen's Season/Quality picker) -- a short
              list (e.g. two subtitle tracks) gets a compact card, a long
              one scrolls inside it; long labels wrap instead of
              truncating. */}
          <View
            style={[
              styles.dialogBox,
              {
                maxWidth: Math.min(windowWidth * 0.7, 900),
                maxHeight: windowHeight * 0.8,
              },
            ]}
          >
            <View style={styles.dialogHeader}>
              <MaterialCommunityIcons
                name={
                  activeDialog === 'subtitles'
                    ? 'closed-caption-outline'
                    : activeDialog === 'audio'
                    ? 'volume-high'
                    : activeDialog === 'server'
                    ? 'server-network'
                    : 'quality-high'
                }
                size={22}
                color="#A78BFA"
              />
              <View style={styles.dialogHeaderText}>
                <Text style={styles.dialogTitle}>
                  {activeDialog === 'subtitles' && 'Subtitles'}
                  {activeDialog === 'audio' && 'Audio Tracks'}
                  {activeDialog === 'server' && 'Select Server'}
                  {activeDialog === 'quality' && 'Select Quality'}
                </Text>
                <Text style={styles.dialogSubtitle}>
                  {activeDialog === 'subtitles' && `${textTracks.length + 1} options`}
                  {activeDialog === 'audio' && `${audioTracks.length} options`}
                  {activeDialog === 'server' && `${servers.length} options`}
                  {activeDialog === 'quality' &&
                    (qualityOptionCount > 0 ? `${qualityOptionCount} options` : 'No options')}
                </Text>
              </View>
            </View>
            <View style={styles.dialogDivider} />

            <ScrollView
              style={styles.dialogListScroll}
              contentContainerStyle={styles.dialogList}
              showsVerticalScrollIndicator={false}
            >
              {activeDialog === 'subtitles' && (
                <>
                  <TVFocusablePressable
                    hasTVPreferredFocus={true}
                    scaleFocused={1.02}
                    focusedBorderColor="#8A5CF6"
                    borderRadius={10}
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
                    {() => (
                      <View style={styles.dialogItemInner}>
                        {/* Full label, wrapped -- never truncated. */}
                        <Text
                          style={[
                            styles.dialogItemText,
                            selectedSub.type === SelectedTrackType.DISABLED &&
                              styles.dialogItemTextSelected,
                          ]}
                        >
                          Off / Disabled
                        </Text>
                        {selectedSub.type === SelectedTrackType.DISABLED && (
                          <MaterialCommunityIcons
                            name="check-circle"
                            size={20}
                            color="#A78BFA"
                            style={styles.dialogItemCheck}
                          />
                        )}
                      </View>
                    )}
                  </TVFocusablePressable>
                  {textTracks.map((trk, i) => {
                    const isSelected = selectedSub.value === i;
                    return (
                      <TVFocusablePressable
                        key={`sub-${i}`}
                        scaleFocused={1.02}
                        focusedBorderColor="#8A5CF6"
                        borderRadius={10}
                        onPress={() => {
                          userChoseSubtitleRef.current = true;
                          setSelectedSub({ type: SelectedTrackType.INDEX, value: i });
                          setActiveDialog(null);
                          resetInactivityTimer();
                        }}
                        style={[styles.dialogItem, isSelected && styles.dialogItemSelected]}
                      >
                        {() => (
                          <View style={styles.dialogItemInner}>
                            <Text
                              style={[
                                styles.dialogItemText,
                                isSelected && styles.dialogItemTextSelected,
                              ]}
                            >
                              {describeTrack(trk, `Subtitle Track ${i + 1}`)}
                            </Text>
                            {isSelected && (
                              <MaterialCommunityIcons
                                name="check-circle"
                                size={20}
                                color="#A78BFA"
                                style={styles.dialogItemCheck}
                              />
                            )}
                          </View>
                        )}
                      </TVFocusablePressable>
                    );
                  })}
                </>
              )}

              {activeDialog === 'audio' &&
                audioTracks.map((trk, i) => {
                  const isSelected = selectedAudio.value === i;
                  return (
                    <TVFocusablePressable
                      key={`audio-${i}`}
                      hasTVPreferredFocus={i === 0}
                      scaleFocused={1.02}
                      focusedBorderColor="#8A5CF6"
                      borderRadius={10}
                      onPress={() => {
                        setSelectedAudio({ type: SelectedTrackType.INDEX, value: i });
                        setActiveDialog(null);
                        resetInactivityTimer();
                      }}
                      style={[styles.dialogItem, isSelected && styles.dialogItemSelected]}
                    >
                      {() => (
                        <View style={styles.dialogItemInner}>
                          <Text
                            style={[
                              styles.dialogItemText,
                              isSelected && styles.dialogItemTextSelected,
                            ]}
                          >
                            {describeTrack(trk, `Audio Track ${i + 1}`)}
                          </Text>
                          {isSelected && (
                            <MaterialCommunityIcons
                              name="check-circle"
                              size={20}
                              color="#A78BFA"
                              style={styles.dialogItemCheck}
                            />
                          )}
                        </View>
                      )}
                    </TVFocusablePressable>
                  );
                })}

              {/* Server Options */}
              {activeDialog === 'server' &&
                servers.map((srv, i) => {
                  const isSelected = activeMediaUrl === srv.url;
                  const row = buildSourceRow(srv, i);
                  return (
                    <TVFocusablePressable
                      key={`server-${i}`}
                      hasTVPreferredFocus={i === 0}
                      scaleFocused={1.02}
                      focusedBorderColor="#8A5CF6"
                      borderRadius={10}
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
                      style={[styles.dialogItem, isSelected && styles.dialogItemSelected]}
                    >
                      {() => (
                        <DialogRowBody title={row.title} chips={row.chips} selected={isSelected} />
                      )}
                    </TVFocusablePressable>
                  );
                })}

              {/* Quality Options: the sources (server + quality + tags) and,
                  when the stream reports several resolutions, the video
                  tracks -- same two lists as the mobile Server/Quality tabs. */}
              {activeDialog === 'quality' && (
                <>
                  {usableQualities.length > 0 && hasTrackChoices && (
                    <Text style={styles.dialogSectionLabel}>Sources</Text>
                  )}
                  {usableQualities.map((q, i) => {
                    const isSelected = activeMediaUrl === q.url;
                    const row = buildSourceRow(q, i);
                    return (
                      <TVFocusablePressable
                        key={`quality-${i}`}
                        hasTVPreferredFocus={i === 0}
                        scaleFocused={1.02}
                        focusedBorderColor="#8A5CF6"
                        borderRadius={10}
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
                        style={[styles.dialogItem, isSelected && styles.dialogItemSelected]}
                      >
                        {() => (
                          <DialogRowBody title={row.title} chips={row.chips} selected={isSelected} />
                        )}
                      </TVFocusablePressable>
                    );
                  })}

                  {hasTrackChoices && (
                    <>
                      {usableQualities.length > 0 && (
                        <Text style={styles.dialogSectionLabel}>Video quality</Text>
                      )}
                      <TVFocusablePressable
                        hasTVPreferredFocus={usableQualities.length === 0}
                        scaleFocused={1.02}
                        focusedBorderColor="#8A5CF6"
                        borderRadius={10}
                        onPress={() => {
                          setSelectedVideoTrack({ type: SelectedVideoTrackType.AUTO });
                          setSelectedTrackListIdx(null);
                          setActiveDialog(null);
                          resetInactivityTimer();
                        }}
                        style={[
                          styles.dialogItem,
                          selectedTrackListIdx === null && styles.dialogItemSelected,
                        ]}
                      >
                        {() => (
                          <DialogRowBody
                            title="Auto"
                            detail="Adaptive bitrate"
                            selected={selectedTrackListIdx === null}
                          />
                        )}
                      </TVFocusablePressable>

                      {videoTracks.map((track: any, i: number) => {
                        const isSelected = selectedTrackListIdx === i;
                        const info = describeVideoTrack(track);
                        return (
                          <TVFocusablePressable
                            key={`vtrack-${i}`}
                            scaleFocused={1.02}
                            focusedBorderColor="#8A5CF6"
                            borderRadius={10}
                            onPress={() => {
                              if (typeof track.index === 'number' && track.index >= 0) {
                                setSelectedVideoTrack({
                                  type: SelectedVideoTrackType.INDEX,
                                  value: String(track.index),
                                });
                              } else if (track.height) {
                                setSelectedVideoTrack({
                                  type: SelectedVideoTrackType.RESOLUTION,
                                  value: String(track.height),
                                });
                              }
                              setSelectedTrackListIdx(i);
                              setActiveDialog(null);
                              resetInactivityTimer();
                            }}
                            style={[styles.dialogItem, isSelected && styles.dialogItemSelected]}
                          >
                            {() => (
                              <DialogRowBody
                                title={info.title}
                                chips={info.tier ? [info.tier] : []}
                                detail={info.detail}
                                selected={isSelected}
                              />
                            )}
                          </TVFocusablePressable>
                        );
                      })}
                    </>
                  )}

                  {usableQualities.length === 0 && !hasTrackChoices && (
                    <Text style={styles.dialogEmptyText}>
                      {videoTracks.length === 1
                        ? 'This stream has a single quality'
                        : videoSize
                        ? 'No quality options reported for this stream'
                        : 'Loading video tracks...'}
                    </Text>
                  )}
                </>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* "Up Next" Popup -- appears at the outro marker (if the provider
          supplied one) or 120s before the end otherwise. Deliberately has
          no onFocus-driven resetInactivityTimer() calls: it's a self-
          contained modal, so it shouldn't also wake the bottom control
          bar behind it when it appears. */}
      <Modal
        visible={showNextUpPopup}
        transparent
        animationType="fade"
        onRequestClose={() => {
          setShowNextUpPopup(false);
          resetInactivityTimer();
        }}
      >
        <View style={styles.nextUpOverlay} pointerEvents="box-none">
          <View style={styles.nextUpCard}>
            <View style={styles.nextUpTextCol}>
              <Text numberOfLines={1} style={styles.nextUpShowTitle}>
                {title}
              </Text>
              <Text numberOfLines={2} style={styles.nextUpEpisodeLine}>
                {formatEpisodeLabel(nextEpisodePreview)}
              </Text>

              <View style={styles.nextUpActionsRow}>
                <TVFocusablePressable
                  hasTVPreferredFocus
                  scaleFocused={1.04}
                  focusedBorderColor="#FFFFFF"
                  borderRadius={24}
                  onPress={() => {
                    setShowNextUpPopup(false);
                    handleNextEpisode();
                  }}
                  style={styles.nextUpPlayBtn}
                >
                  {() => (
                    <View style={styles.nextUpBtnInner}>
                      <MaterialCommunityIcons name="play" size={16} color="#0A0A0E" />
                      <Text style={styles.nextUpPlayBtnText}>Play Now</Text>
                    </View>
                  )}
                </TVFocusablePressable>

                <TVFocusablePressable
                  scaleFocused={1.04}
                  focusedBorderColor="#FFFFFF"
                  borderRadius={24}
                  onPress={() => {
                    setShowNextUpPopup(false);
                    resetInactivityTimer();
                  }}
                  style={styles.nextUpDismissBtn}
                >
                  {() => (
                    <View style={styles.nextUpBtnInner}>
                      <MaterialCommunityIcons name="close" size={16} color="#D1D5DB" />
                      <Text style={styles.nextUpDismissText}>Dismiss</Text>
                    </View>
                  )}
                </TVFocusablePressable>
              </View>
            </View>

            {nextEpisodePreview?.image ? (
              <Image
                source={{ uri: nextEpisodePreview.image }}
                style={styles.nextUpPoster}
                resizeMode="cover"
              />
            ) : null}
          </View>
        </View>
      </Modal>

      {/* Skip Intro/Recap popup -- appears the moment playback enters an
          "Intro" or "Recap" interval (provider-supplied `skip`, or
          TheIntroDB as a fallback). Like the "Up Next" popup above, it's a
          self-contained modal with no onFocus-driven resetInactivityTimer()
          calls, so it never wakes the bottom control bar behind it. The
          button opens already focused (hasTVPreferredFocus) so a bare OK
          press skips immediately; Back hides it (handled in the hardware
          back-press effect above) without closing the player. */}
      <Modal
        visible={!!activeSkipPopup}
        transparent
        animationType="fade"
        onRequestClose={() => {
          if (skipPopupHideTimer.current) clearTimeout(skipPopupHideTimer.current);
          if (activeSkipPopup) shownSkipIntervalsRef.current.add(activeSkipPopup.from);
          setActiveSkipPopup(null);
        }}
      >
        <View style={styles.skipPopupOverlay} pointerEvents="box-none">
          {activeSkipPopup ? (
            <TVFocusablePressable
              hasTVPreferredFocus
              scaleFocused={1.04}
              focusedBorderColor="#FFFFFF"
              borderRadius={8}
              onPress={() => {
                if (skipPopupHideTimer.current) clearTimeout(skipPopupHideTimer.current);
                shownSkipIntervalsRef.current.add(activeSkipPopup.from);
                const seekTo = activeSkipPopup.to;
                setActiveSkipPopup(null);
                videoRef.current?.seek(seekTo);
                setCurrentTime(seekTo);
                currentProgRef.current.currentTime = seekTo;
              }}
              style={styles.skipPopupBtn}
            >
              {() => (
                <View style={styles.nextUpBtnInner}>
                  <MaterialCommunityIcons name="skip-next" size={18} color="#0A0A0E" />
                  <Text style={styles.skipPopupBtnText}>
                    Skip {/recap/i.test(activeSkipPopup.title || '') ? 'Recap' : 'Intro'}
                  </Text>
                </View>
              )}
            </TVFocusablePressable>
          ) : null}
        </View>
      </Modal>

      {/* "Videos" Episode Picker -- scrollable list of every episode in the
          currently active season, each with its Cinemeta/Discover-sourced
          mini-poster and synopsis when available. */}
      <Modal
        visible={showEpisodesList}
        transparent
        animationType="fade"
        onRequestClose={() => {
          setShowEpisodesList(false);
          resetInactivityTimer();
        }}
      >
        <View style={styles.episodesOverlay}>
          <View style={styles.episodesCard}>
            <Text style={styles.episodesTitle}>Videos</Text>
            <ScrollView
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.episodesListContent}
            >
              {episodes.map((ep, idx) => {
                const isCurrent = idx === currentEpisodeIndex;
                const label = formatSeasonEpisodeLabel(
                  ep.season,
                  ep.episodeNumber,
                  ep.title,
                  `Episode ${idx + 1}`
                );
                return (
                  <TVFocusablePressable
                    key={`ep-list-${ep.id || ep.link || idx}`}
                    hasTVPreferredFocus={isCurrent}
                    scaleFocused={1.01}
                    focusedBorderColor="#8A5CF6"
                    borderRadius={12}
                    onFocus={() => resetInactivityTimer()}
                    onPress={() => {
                      setShowEpisodesList(false);
                      if (idx !== currentEpisodeIndex) playEpisodeAtIndex(idx);
                    }}
                    style={[styles.episodeListRow, isCurrent && styles.episodeListRowActive]}
                  >
                    {() => (
                      <View style={styles.episodeListRowInner}>
                        {ep.image ? (
                          <Image
                            source={{ uri: ep.image }}
                            style={styles.episodeListThumb}
                            resizeMode="cover"
                          />
                        ) : (
                          <View style={[styles.episodeListThumb, styles.episodeListThumbFallback]}>
                            <MaterialCommunityIcons name="play" size={20} color="#9CA3AF" />
                          </View>
                        )}
                        <View style={styles.episodeListTextCol}>
                          <View style={styles.episodeListHeaderRow}>
                            <Text
                              numberOfLines={1}
                              style={[styles.episodeListName, isCurrent && styles.episodeListNameActive]}
                            >
                              {label}
                            </Text>
                            {!!ep.releaseDate && (
                              <Text
                                style={[styles.episodeListDate, isCurrent && styles.episodeListDateActive]}
                              >
                                {ep.releaseDate}
                              </Text>
                            )}
                          </View>
                          {!!ep.synopsis && (
                            <Text
                              numberOfLines={2}
                              style={[
                                styles.episodeListSynopsis,
                                isCurrent && styles.episodeListSynopsisActive,
                              ]}
                            >
                              {ep.synopsis}
                            </Text>
                          )}
                        </View>
                      </View>
                    )}
                  </TVFocusablePressable>
                );
              })}
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
  activeIconBtn: {
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
  // Subtitles/audio/server/quality dialog -- deliberately mirrors
  // TVDetailsScreen's Season/Quality picker (pickerOverlay/pickerBox/
  // seasonPickerOption* there): a light dim backdrop, a shrink-wrapped
  // 0.7-opacity card sized off the window (see the inline maxWidth/
  // maxHeight above), and rows whose labels wrap instead of truncating.
  dialogBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  dialogBox: {
    minWidth: 380,
    backgroundColor: 'rgba(19, 19, 26, 0.7)',
    borderRadius: 18,
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 14,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.16)',
    elevation: 12,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 20,
  },
  dialogHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  dialogHeaderText: {
    flexShrink: 1,
  },
  dialogTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '800',
  },
  dialogSubtitle: {
    color: '#B4B9C4',
    fontSize: 12,
    marginTop: 2,
  },
  dialogDivider: {
    height: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    marginTop: 14,
    marginBottom: 10,
  },
  dialogListScroll: {
    flexGrow: 0,
    flexShrink: 1,
  },
  // Breathing room so a focused (scaled-up) row isn't clipped by the list.
  dialogList: {
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  dialogItem: {
    backgroundColor: 'rgba(255, 255, 255, 0.07)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.06)',
    borderRadius: 10,
    paddingVertical: 13,
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  dialogItemSelected: {
    backgroundColor: 'rgba(138, 92, 246, 0.28)',
    borderColor: '#8A5CF6',
    borderWidth: 1.5,
  },
  dialogItemInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  dialogItemText: {
    color: '#E5E7EB',
    fontSize: 15,
    lineHeight: 21,
    fontWeight: '600',
    // Full label, wrapped -- never truncated -- and shrinks to make room
    // for the check icon on the selected row instead of pushing it off.
    flexShrink: 1,
  },
  dialogItemTextSelected: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
  dialogItemCheck: {
    flexShrink: 0,
  },
  // Body of a picker row: wrapped title, optional chips + detail line.
  dialogItemBody: {
    flexShrink: 1,
  },
  dialogChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
    marginTop: 6,
  },
  dialogChip: {
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  dialogChipText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  dialogItemDetail: {
    color: 'rgba(255, 255, 255, 0.55)',
    fontSize: 12,
    lineHeight: 17,
    marginTop: 4,
  },
  dialogSectionLabel: {
    color: '#B4B9C4',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginTop: 6,
    marginBottom: 8,
    marginLeft: 4,
  },
  dialogEmptyText: {
    color: '#B4B9C4',
    fontSize: 14,
    lineHeight: 20,
    paddingVertical: 10,
    paddingHorizontal: 6,
  },

  // ---- "Up Next" popup ----------------------------------------------
  nextUpOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    alignItems: 'flex-end',
    padding: 36,
  },
  nextUpCard: {
    flexDirection: 'row',
    width: 560,
    backgroundColor: 'rgba(24, 24, 30, 0.96)',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    overflow: 'hidden',
  },
  nextUpTextCol: {
    flex: 1,
    padding: 22,
    justifyContent: 'center',
  },
  nextUpShowTitle: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '800',
    marginBottom: 8,
  },
  nextUpEpisodeLine: {
    color: '#D1D5DB',
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 18,
  },
  nextUpActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  nextUpBtnInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  nextUpPlayBtn: {
    backgroundColor: '#FFFFFF',
    paddingVertical: 10,
    paddingHorizontal: 18,
  },
  nextUpPlayBtnText: {
    color: '#0A0A0E',
    fontSize: 14,
    fontWeight: '800',
  },
  nextUpDismissBtn: {
    paddingVertical: 10,
    paddingHorizontal: 10,
  },
  nextUpDismissText: {
    color: '#D1D5DB',
    fontSize: 14,
    fontWeight: '700',
  },
  nextUpPoster: {
    width: 150,
    height: '100%',
  },

  // ---- Skip Intro/Recap popup --------------------------------------------
  skipPopupOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    alignItems: 'flex-end',
    padding: 36,
  },
  skipPopupBtn: {
    flexDirection: 'row',
    backgroundColor: '#FFFFFF',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 8,
  },
  skipPopupBtnText: {
    color: '#0A0A0E',
    fontSize: 15,
    fontWeight: '800',
  },

  // ---- "Videos" episode picker -----------------------------------------
  // A compact, right-of-center panel rather than a full-screen takeover --
  // it leaves the paused frame (and, below it, the player's own bottom
  // control bar) visible and only lightly dimmed around the edges.
  episodesOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 40,
    paddingBottom: 64,
  },
  // Narrower and taller than a first pass at this -- a compact row height
  // (small thumbnail, tight padding) is what actually gets several
  // episodes on screen at once, matching Stremio's own compact "Videos"
  // list rather than a couple of oversized cards.
  episodesCard: {
    width: 720,
    maxWidth: '56%',
    flex: 1,
    alignSelf: 'center',
    backgroundColor: 'rgba(15, 15, 19, 0.96)',
    borderRadius: 16,
    padding: 22,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  episodesTitle: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '800',
    marginBottom: 12,
  },
  episodesListContent: {
    gap: 8,
    paddingBottom: 10,
  },
  episodeListRow: {
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    borderRadius: 10,
    padding: 10,
  },
  episodeListRowActive: {
    backgroundColor: 'rgba(255, 255, 255, 0.92)',
  },
  episodeListRowInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  episodeListThumb: {
    width: 140,
    height: 79,
    borderRadius: 6,
    backgroundColor: '#1E1E28',
  },
  episodeListThumbFallback: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  episodeListTextCol: {
    flex: 1,
  },
  episodeListHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 3,
  },
  episodeListName: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
  },
  episodeListNameActive: {
    color: '#111114',
  },
  episodeListDate: {
    color: '#9CA3AF',
    fontSize: 11,
    fontWeight: '600',
  },
  episodeListDateActive: {
    color: '#4B5563',
  },
  episodeListSynopsis: {
    color: '#9CA3AF',
    fontSize: 12,
    lineHeight: 16,
  },
  episodeListSynopsisActive: {
    color: '#3F3F46',
  },
});

export default TVPlayerScreen;
