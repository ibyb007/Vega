import { getPlaybackPrefs, pickPreferredStream } from '../../lib/zustand/playbackPrefsStore';
import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  forwardRef,
  useImperativeHandle,
} from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Image,
  ActivityIndicator,
  Modal,
  TextInput,
  Dimensions,
  ToastAndroid,
  findNodeHandle,
} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import KeyEvent from 'react-native-keyevent';
import { TVFocusablePressable } from '../../components/tv/TVFocusablePressable';
import { TVPosterRow, POSTER_ROW_HEIGHT } from '../../components/tv/TVPosterRow';
import { TVDiscoverResultsView } from './TVDiscoverResultsView';
import { TVStreamPickerModal, StreamPickerOption } from '../../components/tv/TVStreamPickerModal';
import { getStremioDirectMatch, isStremioProvider } from '../../lib/services/stremioAddon';
import { TVNoProviderFallback } from '../../components/tv/TVNoProviderFallback';
import { TVHeroMeta, TVHeroMedia } from '../../components/tv/TVHeroMeta';
import { TVRoute } from '../../components/tv/TVNavigationRail';
import { NATIVE_RAIL_COLLAPSED_WIDTH } from '../../lib/native/NavRail';
import { registerRailLeftEdge } from '../../lib/tv/registerRailLeftEdge';
import { useTVEntryFocus } from '../../lib/tv/useTVEntryFocus';
import { useReadingOrderFocus } from '../../lib/tv/useReadingOrderFocus';
import useContentStore from '../../lib/zustand/contentStore';
import useContinueWatchingStore from '../../lib/zustand/continueWatchingStore';
import { providerManager } from '../../lib/services/ProviderManager';
import { Post, Info, EpisodeLink, Stream } from '../../lib/providers/types';
import {
  loadDiscoverCatalogs,
  fetchCatalogItems,
  fetchItemMeta,
  clearManifestCache,
  DiscoverCatalog,
  CatalogMediaItem,
} from '../../lib/services/stremioCatalog';
import {
  isStrictMatch,
  isAmbiguousYearMatch,
  mediaKindsConflict,
  extractExternalIds,
  hasExternalId,
  hasMatchingExternalId,
} from '../../lib/utils/titleMatcher';
import { parseSeasonNumber, parseEpisodeNumber, sortEpisodesChronologically } from '../../lib/utils/episodeParsing';
import {
  fetchMatchingCinemetaMeta,
  findCinemetaEpisode,
  formatCinemetaRuntime,
  formatEpisodeReleaseDate,
  peekCinemetaMeta,
  CinemetaMeta,
} from '../../lib/services/cinemetaService';
import {
  stremioCatalogStorage,
  StremioManifestEntry,
  HiddenCatalogEntry,
  settingsStorage,
} from '../../lib/storage';

export const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

// Trimmed from 88 -- the shared viewport wrapper in App.tsx already reserves
// the rail's collapsed width (72dp), so this only needs to be a small
// breathing margin on top of that, not a near-duplicate of the rail's width.
const CONTAINER_PADDING_LEFT = 20;
// Was 40 -- too tight a buffer for focused-card growth. Full-width elements
// on the results (page 2) screen -- episode cards, quality/season chips --
// are laid out flush against this padding with nothing else reserved for
// their `scaleFocused` transform, so focusing the rightmost one grew it a
// few dp past the edge of this padding and off the visible screen. The
// extra headroom here (plus the matching inset on episodesGrid/chipsRow
// below) keeps that growth inside the screen.
const CONTAINER_PADDING_RIGHT = 56;
// Page 2 has no rail beside it, so it needs a slightly larger left gutter than
// page 1's 20dp (which sits next to the rail strip). Tweak to taste.
const RESULTS_PADDING_LEFT = 48;
const GRID_GAP = 14;
const GRID_COLUMNS = 6;
// This screen's content sits inside App.tsx's shared viewport wrapper,
// which already applies `paddingLeft: NATIVE_RAIL_COLLAPSED_WIDTH` (72dp)
// to reserve room for the collapsed rail -- on top of this screen's own
// CONTAINER_PADDING_LEFT/RIGHT. The old CARD_WIDTH math sized 6 columns
// against the raw SCREEN_WIDTH and never subtracted that 72dp, so the
// cards were sized wider than the real available row width: the 6th
// column had nowhere to go, wrapped to the next line, and left a gap on
// the right of every row instead of a full 6-across grid.
const CARD_WIDTH = Math.floor(
  (SCREEN_WIDTH -
    NATIVE_RAIL_COLLAPSED_WIDTH -
    CONTAINER_PADDING_LEFT -
    CONTAINER_PADDING_RIGHT -
    GRID_GAP * (GRID_COLUMNS - 1)) /
    GRID_COLUMNS,
);
const CARD_HEIGHT = Math.round(CARD_WIDTH * 1.5);

const CATALOG_TYPE_LABEL: Record<string, string> = {
  movie: 'Movies',
  series: 'Shows',
  channel: 'Channels',
  tv: 'TV',
};

// Exported: also used by TVDiscoverResultsView, which renders the
// season/quality-filtered episode & source lists.
export const isQualityExcluded = (
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

interface TVDiscoverScreenProps {
  onSelectItem: (item: Post) => void;
  onNavigateRoute?: (route: TVRoute) => void;
  onPlayStream?: (streamUrl: string, title?: string, extraMeta?: any) => void;
  onRegisterBackHandler?: (handler: (() => boolean) | null) => void;
  onRegisterEntryHandleGetter?: (getter: (() => number | null) | null) => void;
  onRegisterReturnFocusTrigger?: (trigger: (() => void) | null) => void;
  resetFocusOnMount?: boolean;
  // Reports whether page 2 (results) is showing, so App can hide the native
  // rail behind it -- same treatment as the details screen / player.
  onResultsModeChange?: (active: boolean) => void;
}

// Module-level (not component state) so it survives this screen unmounting
// when the user navigates to another rail route and back -- same pattern as
// TVHomeScreen's `lastFocusedKey`. Tracks whichever browse-mode item (the
// "Catalogs" button, a category pill, or a poster) last had real focus, so
// the rail's Right-key/re-select can put focus back exactly there.
//
// This is deliberately a *separate* variable from
// `lastFocusedDiscoverResultsKey` below rather than one shared key. They
// used to be the same variable, which meant focusing anything in the page-2
// results view (the "Back to Discover" button, a source card, a link...)
// overwrote the page-1 poster key too. Pressing Back then dropped straight
// into browse mode with a results-only key that matched none of the grid's
// keys, so *no* grid item claimed `hasTVPreferredFocus` and Android's
// default focus search took over -- landing wherever was nearest
// (observed as the rail's Search button) instead of the poster the user
// had actually left on page 1. Keeping the two keyed independently means
// returning to browse mode always finds the real last-focused poster.
let lastFocusedDiscoverBrowseKey: string | null = null;
// Catalog key of the row that key belongs to (null while the Catalogs button
// or nothing is focused).
let lastFocusedDiscoverRowKey: string | null = null;
// Tracks whichever page-2 (results) item -- the Back button, a source
// card, a link, an episode, a direct-stream button -- last had real focus,
// independently of the page-1 browse key above.
let lastFocusedDiscoverResultsKey: string | null = null;
// Vertical scroll offset of the page-2 results ScrollView, kept alongside the
// key above. Coming back from the player remounts this whole screen with the
// ScrollView at offset 0; the episode/link the person left off on is usually
// further down and -- because that ScrollView clips off-screen children --
// isn't attached to the window yet, so its `hasTVPreferredFocus` request has
// nothing to focus and Android drops focus onto the nav rail instead.
// Restoring this offset (see handleResultsContentSizeChange) puts that item
// back inside the viewport before focus is re-requested.
let lastResultsScrollY = 0;
const catalogKey = (c: Pick<DiscoverCatalog, 'manifestUrl' | 'type' | 'id'>) =>
  `${c.manifestUrl}::${c.type}::${c.id}`;

const catalogDisplayName = (cat: DiscoverCatalog): string => {
  const base = (cat.name || cat.id || '').trim();
  const label = CATALOG_TYPE_LABEL[cat.type] || '';
  if (!base) return label || cat.type;
  if (!label) return base;
  const lower = base.toLowerCase();
  if (lower.includes(label.toLowerCase()) || lower.includes(cat.type.toLowerCase())) {
    return base;
  }
  return `${base} ${label}`;
};

const normalizeSearchResult = (data: any, providerValue: string): Post[] => {
  let rawList: any[] = [];
  if (Array.isArray(data)) {
    rawList = data;
  } else if (data && Array.isArray(data.posts)) {
    rawList = data.posts;
  } else if (data && Array.isArray(data.data)) {
    rawList = data.data;
  } else if (data && Array.isArray(data.results)) {
    rawList = data.results;
  }
  return rawList
    .filter((item) => Boolean(item && (item.title || item.name)))
    .map((item) => ({
      ...item,
      title: item.title || item.name || 'Untitled',
      image: item.image || item.poster || item.banner || '',
      link: item.link || item.url || '',
      provider: item.provider || providerValue,
    }));
};

interface DiscoverRowData {
  items: CatalogMediaItem[];
  loading: boolean;
  loaded: boolean;
  loadingMore: boolean;
  hasMore: boolean;
}

// Rows used to stop at the first catalog page; they now keep paging as focus
// nears the end, up to this many posters.
const MAX_ROW_POSTS = 300;
const EMPTY_ITEMS: CatalogMediaItem[] = [];
const ROW_LOOKAHEAD = 3;
// Top of the rows' viewport (the hero shows above it).
const ROW_TOP = 220;

interface SavedDiscoverState {
  catalogs?: DiscoverCatalog[];
  selectedCatalog?: DiscoverCatalog | null;
  // Every Discover row's loaded posters, so coming back from a title's page
  // (or the player) shows the rows exactly as they were.
  rowData?: Record<string, DiscoverRowData>;
  activeHero?: TVHeroMedia | null;

  screenMode: 'browse' | 'results';
  resultsTarget: (CatalogMediaItem & { logo?: string; cast?: string[]; runtime?: string }) | null;
  matchedAddonPosts: Post[];
  activeSourcePost: Post | null;
  sourceInfo: Info | null;
  activeLinkIndex: number;
  episodes: EpisodeLink[];
  // Episode stills / synopses / logo. Saved so a remount after playback
  // renders the SAME layout the person left; without it the first layout is
  // shorter and later grows, shifting the restored focus/scroll target.
  sourceCinemetaMeta?: CinemetaMeta | null;
}

let savedDiscoverState: SavedDiscoverState | null = null;

// Set by another screen (Home's Continue Watching row) right before
// navigating here, when the tapped item's continue-watching entry
// originated from a Discover catalog poster rather than a provider's own
// listing -- consumed once on mount below to jump straight into this
// item's page-2 "results" inspector via the exact same lookup path a
// fresh poster tap uses (see handleItemPress), instead of restoring
// whatever browse/results state this screen had last.
let pendingDiscoverOpenItem:
  | (CatalogMediaItem & { logo?: string; cast?: string[]; runtime?: string })
  | null = null;

// Resume context carried alongside `pendingDiscoverOpenItem` -- the
// originating Continue Watching entry's provider/episode identity and saved
// position, so this screen's results view can land on the same addon
// source and episode it was originally played from and pass the right
// `startPosition` through to onPlayStream, instead of opening a blank
// results browser with no memory of where playback left off.
export interface DiscoverResumeHint {
  providerValue?: string;
  infoUrl?: string;
  episodeKey?: string;
  episodeLink?: string;
  position?: number;
  duration?: number;
  // Exact label of the season/quality/dub dropdown entry (`activeLink.title`)
  // this episode was played from -- see ContinueWatchingItem.linkTitle.
  linkTitle?: string;
}

let pendingDiscoverResumeHint: DiscoverResumeHint | null = null;

export const openDiscoverResultFor = (
  item: CatalogMediaItem & { logo?: string; cast?: string[]; runtime?: string },
  resumeHint?: DiscoverResumeHint,
) => {
  pendingDiscoverOpenItem = item;
  pendingDiscoverResumeHint = resumeHint || null;
};

// Quick D-pad presses only update the hero once focus has rested for a
// moment; each hero change swaps up to three (blurred) full-screen images.
// Same value Home uses.
const HERO_APPLY_DELAY_MS = 80;
// Posters ahead of the focused one whose images are warmed into the disk cache.
const POSTER_PREFETCH_AHEAD = 8;

// ---------------------------------------------------------------------------
// Hero host
//
// The hero used to live in TVDiscoverScreen's own state, so *every* D-pad move
// -> setActiveHero -> re-rendered this whole (very large) screen. That kept
// the JS thread busy while a held Left/Right key was sweeping across posters,
// so JS-side focus bookkeeping lagged behind the native focus and the row
// felt slow / glitched. The hero state now lives here and the screen drives it
// imperatively (exactly like TVHomeScreen's HeroHost), so a hero change only
// re-renders this tiny component.
// ---------------------------------------------------------------------------
type HeroSetter = React.Dispatch<React.SetStateAction<TVHeroMedia | null>>;
interface HeroHostHandle {
  set: HeroSetter;
  get: () => TVHeroMedia | null;
}
const HeroHost = React.memo(
  forwardRef<HeroHostHandle, { initial: TVHeroMedia | null }>(({ initial }, ref) => {
    const [media, setMedia] = useState<TVHeroMedia | null>(initial);
    const mediaRef = useRef<TVHeroMedia | null>(media);
    mediaRef.current = media;
    useImperativeHandle(ref, () => ({ set: setMedia, get: () => mediaRef.current }), []);
    return <TVHeroMeta media={media} />;
  }),
);

export const TVDiscoverScreen: React.FC<TVDiscoverScreenProps> = ({
  onSelectItem,
  onNavigateRoute,
  onPlayStream,
  onRegisterBackHandler,
  onRegisterEntryHandleGetter,
  onRegisterReturnFocusTrigger,
  resetFocusOnMount,
  onResultsModeChange,
}) => {
  // Kept in sync with `screenMode` state below via a plain render-time
  // assignment (not an effect) so the mode-aware getter passed to
  // useTVEntryFocus always reads the *current* mode at call time, even
  // though the effect that captures this getter only fires once (see the
  // hook's own `[onRegisterEntryHandleGetter]` dep array).

  // Home's Continue Watching card can hand this screen an item to open on
  // page 2 (see openDiscoverResultFor). That request is already known at
  // mount time, so start straight in the results view instead of first
  // rendering the browse grid (nothing focusable yet -> Android parks focus
  // on the rail's Search button) and only switching over from an effect.
  const pendingOpenAtMountRef = useRef(pendingDiscoverOpenItem);
  const startInResults = pendingOpenAtMountRef.current !== null;
  // Page-2-specific state is never restored when a fresh open is pending --
  // whatever results view was saved belongs to a different title.
  const restoredState = startInResults ? null : savedDiscoverState;
  const freshResultsResetRef = useRef(false);
  if (startInResults && !freshResultsResetRef.current) {
    freshResultsResetRef.current = true;
    // A stale key from an earlier page-2 session (e.g. the episode last
    // played) would otherwise stop the Back button claiming focus below.
    lastFocusedDiscoverResultsKey = null;
    lastResultsScrollY = 0;
  }

  const screenModeRef = useRef<'browse' | 'results'>(
    startInResults ? 'results' : savedDiscoverState?.screenMode || 'browse',
  );

  // Keys of the page-2 items that currently have a real native view, and
  // the results ScrollView itself -- see registerReturnTrigger / the
  // scroll-restore below.
  const mountedResultsKeysRef = useRef<Set<string>>(new Set());
  const resultsScrollRef = useRef<ScrollView | null>(null);
  // Resume flow (Home -> Continue Watching -> here): until the person moves
  // focus themselves, focus is steered to the resume source/episode/play
  // button as each one appears; see shouldPreferResultsFocus.
  const resumeFocusPendingRef = useRef(false);

  // Shared fallback used both by the rail's Right-key recovery below and by
  // the post-mount focus safety-net further down: if the item we think was
  // last focused (`lastFocusedDiscoverResultsKey`) is missing or has no live
  // native view right now, there's nothing for a bare focus() to land on --
  // reroute to the always-present Back button (scrolled into view) instead
  // of silently doing nothing. `invoke` is whatever actually issues the real
  // focus request (the rail's returned trigger, or this screen's own
  // `requestRefocus`) -- both behave identically, so this can drive either.
  const reclaimResultsFocusOrFallback = useCallback((invoke: () => void) => {
    const key = lastFocusedDiscoverResultsKey;
    if (!key || !mountedResultsKeysRef.current.has(key)) {
      lastFocusedDiscoverResultsKey = 'results:back';
      resultsScrollRef.current?.scrollTo({ x: 0, y: 0, animated: false });
      setTimeout(invoke, 50);
      return;
    }
    invoke();
  }, []);

  // The rail's Right key asks the screen to re-focus whatever it last had
  // focused. If that item is no longer there (episode list changed, source
  // deselected...) or has been scrolled out of the viewport, the request
  // used to silently do nothing -- and because the rail swallows the Right
  // key while it waits for JS, that left no way back into the page at all.
  // Fall back to the Back button, scrolled into view, so it can never dead-end.
  const registerReturnTrigger = useCallback(
    (trigger: (() => void) | null) => {
      if (!onRegisterReturnFocusTrigger) return;
      if (!trigger) {
        onRegisterReturnFocusTrigger(null);
        return;
      }
      onRegisterReturnFocusTrigger(() => {
        if (screenModeRef.current === 'results') {
          reclaimResultsFocusOrFallback(trigger);
          return;
        }
        trigger();
      });
    },
    [onRegisterReturnFocusTrigger, reclaimResultsFocusOrFallback],
  );

  const {
    setItemRef: baseSetItemRef,
    keyFor,
    shouldPreferFocus,
    requestRefocus,
    refocusKey,
    refocusNonce,
  } = useTVEntryFocus(
    () =>
      screenModeRef.current === 'results'
        ? lastFocusedDiscoverResultsKey
        : lastFocusedDiscoverBrowseKey,
    onRegisterEntryHandleGetter,
    registerReturnTrigger,
    resetFocusOnMount,
    () => {
      lastFocusedDiscoverBrowseKey = null;
      lastFocusedDiscoverResultsKey = null;
      lastResultsScrollY = 0;
      lastFocusedDiscoverRowKey = null;
    }
  );

  // Page 2 has no rail beside it, so Left/Right at a row's edge walk the
  // page in reading order instead (see useReadingOrderFocus).
  const chain = useReadingOrderFocus();

  const setItemRef = useCallback(
    (key: string, node: any) => {
      baseSetItemRef(key, node);
      // Only page-2 items take part in the reading-order chain; skipping the
      // browse grid's posters avoids an extra re-render per poster mount.
      if (key.startsWith('results:')) chain.register(key, node);
      if (node) {
        mountedResultsKeysRef.current.add(key);
      } else {
        mountedResultsKeysRef.current.delete(key);
      }
    },
    [baseSetItemRef, chain.register],
  );

  // Captured once, after the hook above has had its chance to reset the
  // keys for a fresh tab entry: only a genuine "come back to an existing
  // page 2" mount (with something below the fold focused) needs the scroll
  // position put back.
  const restoreScrollYRef = useRef<number | null>(
    restoredState?.screenMode === 'results' &&
      lastFocusedDiscoverResultsKey &&
      lastResultsScrollY > 0
      ? lastResultsScrollY
      : null,
  );
  // Same story for the episode list: it was restored from saved state, so
  // there's nothing to re-fetch (and re-fetching swaps the grid for a
  // "Loading episodes..." row, unmounting the very card that should hold
  // focus).
  const restoredEpisodesRef = useRef<boolean>(
    Boolean(restoredState?.activeSourcePost && restoredState.episodes && restoredState.episodes.length > 0),
  );

  // When this mount is restoring an earlier page-2 position (Back from the
  // player), Android may park default focus on the top-most button (the
  // "Back to Discover" button) for a moment before the real target takes it.
  // That landing fires the button's onFocus, which used to overwrite the
  // remembered key with 'results:back' -- so the restore then "correctly"
  // refocused the Back button and the page scrolled to the top. While this
  // guard is armed, a focus on the Back button is not treated as the
  // person's choice (see noteResultsFocus).
  const restoreGuardRef = useRef<boolean>(
    restoredState?.screenMode === 'results' &&
      !!lastFocusedDiscoverResultsKey &&
      lastFocusedDiscoverResultsKey !== 'results:back',
  );
  useEffect(() => {
    if (!restoreGuardRef.current) return;
    const t = setTimeout(() => {
      restoreGuardRef.current = false;
    }, 1200);
    return () => clearTimeout(t);
  }, []);

  // Belt-and-suspenders for landing directly in results on mount -- either
  // resuming an existing page-2 session (most commonly: Back from the
  // player) or opening straight into one from Home's Continue Watching card
  // (see `startInResults`/`pendingDiscoverOpenItem` above). The scroll-
  // restore path right below already re-issues a real focus request when
  // the last-focused item was scrolled out of view, but plenty of sessions
  // never scrolled at all (`lastResultsScrollY` stays 0) -- e.g. hitting
  // Play without scrolling past the first source. Those still race the
  // exact same native focus hazard on the way back from the player: the
  // nav rail is transitioning from hidden to visible again at the same
  // moment this whole screen is remounting from scratch, and if Android's
  // default focus search resolves before this screen's own
  // `hasTVPreferredFocus` request wins, it lands on the rail (observed as
  // its "Search" row) instead -- with nothing below re-claiming it, since
  // the scroll-restore branch only ever fires when there's an offset to
  // restore. This flag makes the same one-time, post-layout re-assertion
  // fire for every direct-to-results mount, not just the scrolled ones.
  const resultsFocusSafetyNeededRef = useRef<boolean>(screenModeRef.current === 'results');

  const handleResultsContentSizeChange = useCallback(() => {
    const y = restoreScrollYRef.current;
    if (y !== null) {
      restoreScrollYRef.current = null;
      resultsFocusSafetyNeededRef.current = false;
      const key = lastFocusedDiscoverResultsKey;
      const resolvable = !!key && mountedResultsKeysRef.current.has(key);
      resultsScrollRef.current?.scrollTo({ x: 0, y: resolvable ? y : 0, animated: false });
      // Give the scroll a beat to update which children are attached, then
      // re-issue the real focus request for the item the person left off on
      // (or the Back button if that item is gone).
      setTimeout(() => requestRefocus(), 60);
      return;
    }
    if (resultsFocusSafetyNeededRef.current) {
      resultsFocusSafetyNeededRef.current = false;
      // No scroll to restore, but still worth one re-assertion in case the
      // rail won the initial focus race -- a no-op if it didn't, since this
      // just re-requests focus on the same item that should already have it.
      reclaimResultsFocusOrFallback(() => requestRefocus());
    }
  }, [requestRefocus, reclaimResultsFocusOrFallback]);

  // Mirrors `shouldPreferFocus`, but reads its own dedicated
  // `lastFocusedDiscoverResultsKey` variable instead of the page-1
  // browse key, so focusing anything here (the Back button, a source
  // card, a link...) never clobbers whichever poster the user had
  // focused on page 1 -- and, symmetrically, a leftover page-1 grid key
  // never suppresses the default entry point (the Back button) the
  // first time results are shown, since the two keys can no longer
  // collide.
  const shouldPreferResultsFocus = (key: string, defaultValue: boolean): boolean => {
    if (resumeFocusPendingRef.current) {
      // Resume flow: the Back button holds focus while sources load, then
      // the resume source -> episode/play button claim it as they appear,
      // until the person moves focus somewhere else themselves.
      return key === 'results:back' ? true : defaultValue;
    }
    return lastFocusedDiscoverResultsKey ? lastFocusedDiscoverResultsKey === key : defaultValue;
  };
  const noteResultsFocus = (key: string, keepResumePending: boolean = false) => {
    if (restoreGuardRef.current) {
      // Default-focus landing on the Back button while restoring: not a
      // real choice, so don't let it replace the remembered target.
      if (key === 'results:back') return;
      restoreGuardRef.current = false;
    }
    lastFocusedDiscoverResultsKey = key;
    if (!keepResumePending && key !== 'results:back') {
      resumeFocusPendingRef.current = false;
    }
  };
  // Wraps the raw `lastResultsScrollY` write so TVDiscoverResultsView
  // never touches that module-level variable directly -- kept here,
  // alongside the two closures above, as the one place that does.
  const handleResultsScroll = (e: any) => {
    lastResultsScrollY = e.nativeEvent.contentOffset.y;
  };

  const installedProviders = useContentStore((state) => state.installedProviders);
  const [manifests, setManifests] = useState<StremioManifestEntry[]>([]);
  const [catalogs, setCatalogs] = useState<DiscoverCatalog[]>(savedDiscoverState?.catalogs || []);
  const [hiddenCatalogs, setHiddenCatalogs] = useState<HiddenCatalogEntry[]>(() =>
    stremioCatalogStorage.getHiddenCatalogs(),
  );
  const [catalogsLoading, setCatalogsLoading] = useState(
    savedDiscoverState?.catalogs && savedDiscoverState.catalogs.length > 0 ? false : true,
  );
  const [catalogsError, setCatalogsError] = useState<string | null>(null);
  const [selectedCatalog, setSelectedCatalog] = useState<DiscoverCatalog | null>(
    savedDiscoverState?.selectedCatalog ?? null,
  );
  const selectedCatalogRef = useRef(selectedCatalog);
  selectedCatalogRef.current = selectedCatalog;
  const [rowData, setRowData] = useState<Record<string, DiscoverRowData>>(
    savedDiscoverState?.rowData || {},
  );
  const rowDataRef = useRef(rowData);
  rowDataRef.current = rowData;
  const heroHostRef = useRef<HeroHostHandle>(null);
  const initialHeroRef = useRef<TVHeroMedia | null>(savedDiscoverState?.activeHero ?? null);
  // Drop-in replacement for the old `setActiveHero` state setter.
  const setActiveHero = useCallback<HeroSetter>((update) => {
    heroHostRef.current?.set(update);
  }, []);
  const getActiveHero = useCallback(() => heroHostRef.current?.get() ?? null, []);
  const heroRequestIdRef = useRef(0);
  const heroEnrichTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heroApplyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (heroEnrichTimerRef.current) clearTimeout(heroEnrichTimerRef.current);
      if (heroApplyTimerRef.current) clearTimeout(heroApplyTimerRef.current);
    },
    [],
  );

  const [screenMode, setScreenMode] = useState<'browse' | 'results'>(
    startInResults ? 'results' : savedDiscoverState?.screenMode || 'browse',
  );
  screenModeRef.current = screenMode;

  // Tell App whether page 2 is showing so it can hide the rail behind it.
  // No cleanup on purpose: this screen unmounts whenever the player opens,
  // and reporting "not results" then would un-hide the rail right as the
  // screen remounts on the way back -- the exact focus race this avoids.
  // App clears the flag itself when it is genuinely left (see backToBrowse).
  useEffect(() => {
    onResultsModeChange?.(screenMode === 'results');
  }, [screenMode, onResultsModeChange]);

  const [resultsTarget, setResultsTarget] = useState<
    (CatalogMediaItem & { logo?: string; cast?: string[]; runtime?: string }) | null
  >((startInResults ? (pendingOpenAtMountRef.current as any) : savedDiscoverState?.resultsTarget) ?? null);
  const [resultsLoading, setResultsLoading] = useState(startInResults);
  const [matchedAddonPosts, setMatchedAddonPosts] = useState<Post[]>(
    restoredState?.matchedAddonPosts || [],
  );
  const resolveAbortRef = useRef<AbortController | null>(null);

  const [activeSourcePost, setActiveSourcePost] = useState<Post | null>(
    restoredState?.activeSourcePost ?? null,
  );
  const [sourceInfo, setSourceInfo] = useState<Info | null>(
    restoredState?.sourceInfo ?? null,
  );
  const [loadingSourceInfo, setLoadingSourceInfo] = useState(false);
  const [activeLinkIndex, setActiveLinkIndex] = useState(
    restoredState?.activeLinkIndex ?? 0,
  );
  // Picking a season/quality in TVDiscoverResultsView's picker modal needs
  // to update both the live state and the saved-for-restore mirror in one
  // place -- kept here (not duplicated in that file) since this is the
  // only spot that touches `savedDiscoverState` for this field.
  const handleSelectLink = useCallback((idx: number) => {
    setActiveLinkIndex(idx);
    if (savedDiscoverState) savedDiscoverState.activeLinkIndex = idx;
  }, []);
  const [episodes, setEpisodes] = useState<EpisodeLink[]>(
    restoredState?.episodes || [],
  );
  const [episodesLoading, setEpisodesLoading] = useState(false);

  const [sourceCinemetaMeta, setSourceCinemetaMeta] = useState<CinemetaMeta | null>(
    restoredState?.sourceCinemetaMeta ?? null,
  );
  // True only for the first run of the Cinemeta effect below on a remount that
  // restored the meta -- that run must keep it instead of blanking + refetching.
  const restoredCinemetaRef = useRef<boolean>(Boolean(restoredState?.sourceCinemetaMeta));
  // `type::imdbId` the current `sourceCinemetaMeta` belongs to. The effect
  // below re-runs whenever the provider's details arrive (its title/type
  // change) -- without this it blanked the meta on every one of those runs
  // and re-filled it a beat later, which is the "S01E01-S01E01 -> real name"
  // flash on the episode list.
  const cinemetaKeyRef = useRef<string | null>(null);
  const [extractingLink, setExtractingLink] = useState(false);
  // Stremio addon episodes: streams to choose from before playing.
  const [streamPicker, setStreamPicker] = useState<{
    options: StreamPickerOption[];
    onSelect: (index: number) => void;
  } | null>(null);

  // Resume context handed off by Home's Continue Watching card (see
  // `openDiscoverResultFor`/`pendingDiscoverResumeHint` above), consumed
  // once on mount alongside `pendingDiscoverOpenItem` below.
  const [resumeHint, setResumeHint] = useState<DiscoverResumeHint | null>(null);
  const autoSelectedResumeSourceRef = useRef(false);

  const [manageVisible, setManageVisible] = useState(false);
  const [manifestInput, setManifestInput] = useState('');
  const [addingManifest, setAddingManifest] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // Left-edge refs for the native nav rail's Left-key/entry-focus link
  const manageBtnRef = useRef<View | null>(null);
  const topFirstCardRef = useRef<View | null>(null);
  const sourcesRowFirstRef = useRef<View | null>(null);

  const excludedQualities = useMemo(
    () => settingsStorage.getExcludedQualities() || [],
    [],
  );

  const hiddenKeySet = new Set(hiddenCatalogs.map((h) => h.key));
  const visibleCatalogs = catalogs.filter((c) => !hiddenKeySet.has(catalogKey(c)));

  const heroFor = useCallback(
    (item: CatalogMediaItem): TVHeroMedia => ({
      title: item.title,
      backdropUrl: item.banner || item.poster,
      posterUrl: item.poster,
      isPosterFallback: !item.banner && Boolean(item.poster),
      overview: item.overview || 'Select a title to find matching sources from your addons.',
      year: item.year,
      rating: item.rating,
      genres: item.genres,
    }),
    [],
  );

  const enrichHeroRef = useRef<(item: CatalogMediaItem, be: string, id: string | undefined, rid: number) => void>(() => {});
  const focusHero = useCallback(
    (item: CatalogMediaItem, baseEndpoint: string) => {
      const metaId = item.imdb_id || item.id;
      const requestId = ++heroRequestIdRef.current;
      // Applied once focus has rested for a moment (see HERO_APPLY_DELAY_MS).
      if (heroApplyTimerRef.current) clearTimeout(heroApplyTimerRef.current);
      heroApplyTimerRef.current = setTimeout(() => {
        heroApplyTimerRef.current = null;
        if (heroRequestIdRef.current !== requestId) return;
        setActiveHero(heroFor(item));
      }, HERO_APPLY_DELAY_MS);
      // Held D-pad keys sweep across many posters; only the one focus settles
      // on should cost network calls.
      if (heroEnrichTimerRef.current) clearTimeout(heroEnrichTimerRef.current);
      heroEnrichTimerRef.current = setTimeout(() => {
        heroEnrichTimerRef.current = null;
        if (heroRequestIdRef.current !== requestId) return;
        enrichHeroRef.current(item, baseEndpoint, metaId, requestId);
      }, 250);
    },
    [heroFor, setActiveHero],
  );

  const enrichHero = useCallback(
    (item: CatalogMediaItem, baseEndpoint: string, metaId: string | undefined, requestId: number) => {
      if (!item.banner && metaId) {
        fetchItemMeta(baseEndpoint, item.type, metaId).then((meta) => {
          if (!meta?.background) return;
          if (heroRequestIdRef.current !== requestId) return;
          setActiveHero((prev) =>
            prev && prev.title === item.title
              ? { ...prev, backdropUrl: meta.background, isPosterFallback: false }
              : prev,
          );
        });
      }
      // Same "Cast: Name1, Name2, Name3" data the results page already
      // pulls from Cinemeta, now surfaced under the page 1 browse hero's
      // synopsis too. The same Cinemeta lookup also carries runtime, which
      // catalogs themselves never include -- surfaced here so page 1's
      // hero shows runtime consistently with page 2.
      if (metaId) {
        fetchMatchingCinemetaMeta(metaId, item.type, item.title).then((cMeta) => {
          if (!cMeta) return;
          const cast = cMeta.cast && cMeta.cast.length > 0 ? cMeta.cast.slice(0, 3) : undefined;
          const runtime = formatCinemetaRuntime(cMeta.runtime);
          if (!cast && !runtime) return;
          if (heroRequestIdRef.current !== requestId) return;
          setActiveHero((prev) =>
            prev && prev.title === item.title
              ? { ...prev, cast: cast || prev.cast, runtime: runtime || prev.runtime }
              : prev,
          );
        });
      }
    },
    [setActiveHero],
  );

  enrichHeroRef.current = enrichHero;

  const reloadCatalogs = useCallback(async (keepSelection = true) => {
    setCatalogsLoading(true);
    setCatalogsError(null);
    const all = stremioCatalogStorage.getManifests();
    setManifests(all);
    setHiddenCatalogs(stremioCatalogStorage.getHiddenCatalogs());
    // Only sources switched on in the Catalogs dialog are loaded.
    const list = all.filter((m) => m.enabled !== false);
    if (list.length === 0) {
      setCatalogs([]);
      setCatalogsError(
        all.length > 0 ? 'All catalogs are turned off. Open Catalogs to turn one on.' : null,
      );
      setCatalogsLoading(false);
      return;
    }
    // A catalog that must be given a search text / genre can't be browsed.
    const needsExtra = (c: DiscoverCatalog) =>
      (Array.isArray(c.extraRequired) && c.extraRequired.length > 0) ||
      (Array.isArray(c.extra) && c.extra.some((e) => e?.isRequired));
    const loaded = (await loadDiscoverCatalogs(list)).filter((c) => !needsExtra(c));
    setCatalogs(loaded);
    if (loaded.length === 0) {
      setCatalogsError('None of your enabled catalogs could be loaded.');
    }
    // Forget rows of catalogs that are gone.
    const alive = new Set(loaded.map((c) => catalogKey(c)));
    setRowData((prev) => {
      const next: Record<string, DiscoverRowData> = {};
      for (const k of Object.keys(prev)) if (alive.has(k)) next[k] = prev[k];
      return next;
    });
    setCatalogsLoading(false);
  }, []);

  useEffect(() => {
    reloadCatalogs(true);
  }, [reloadCatalogs]);

  // --- rows ---------------------------------------------------------------
  // One row per visible catalog. Rows load as focus approaches them (the
  // focused row plus ROW_LOOKAHEAD below), and each keeps paging as focus nears
  // the end of its posters.
  const [visibleRowCount, setVisibleRowCount] = useState(
    () => (savedDiscoverState?.rowData ? Object.keys(savedDiscoverState.rowData).length : 0) + ROW_LOOKAHEAD + 1,
  );
  const catalogByKeyRef = useRef<Record<string, DiscoverCatalog>>({});
  catalogByKeyRef.current = Object.fromEntries(catalogs.map((c) => [catalogKey(c), c]));

  const patchRow = useCallback((key: string, patch: Partial<DiscoverRowData>) => {
    setRowData((prev) => {
      const cur = prev[key] || { items: [], loading: false, loaded: false, loadingMore: false, hasMore: true };
      const next = { ...prev, [key]: { ...cur, ...patch } };
      if (savedDiscoverState) savedDiscoverState.rowData = next;
      return next;
    });
  }, []);

  const loadRow = useCallback(
    async (cat: DiscoverCatalog) => {
      const key = catalogKey(cat);
      patchRow(key, { loading: true });
      let res: CatalogMediaItem[] = [];
      try {
        res = (await fetchCatalogItems(cat.baseEndpoint, cat.type, cat.id, 0)) || [];
      } catch {}
      patchRow(key, {
        items: res.slice(0, MAX_ROW_POSTS),
        loading: false,
        loaded: true,
        hasMore: res.length > 0 && res.length < MAX_ROW_POSTS,
      });
    },
    [patchRow],
  );

  const loadMoreRow = useCallback(
    async (key: string) => {
      const cat = catalogByKeyRef.current[key];
      const cur = rowDataRef.current[key];
      if (!cat || !cur || !cur.loaded || cur.loadingMore || !cur.hasMore) return;
      patchRow(key, { loadingMore: true });
      let more: CatalogMediaItem[] = [];
      try {
        // Stremio catalogs page by "skip" = how many posters we already have.
        more = (await fetchCatalogItems(cat.baseEndpoint, cat.type, cat.id, cur.items.length)) || [];
      } catch {}
      const have = new Set(cur.items.map((i) => i.id));
      const fresh = more.filter((i) => !have.has(i.id));
      const merged = [...rowDataRef.current[key].items, ...fresh].slice(0, MAX_ROW_POSTS);
      patchRow(key, {
        items: merged,
        loadingMore: false,
        // A catalog that ignores `skip` just repeats itself: stop asking.
        hasMore: fresh.length > 0 && merged.length < MAX_ROW_POSTS,
      });
    },
    [patchRow],
  );

  useEffect(() => {
    visibleCatalogs.slice(0, visibleRowCount).forEach((cat) => {
      const d = rowData[catalogKey(cat)];
      if (!d || (!d.loaded && !d.loading)) loadRow(cat);
    });
  }, [visibleCatalogs.length, hiddenCatalogs, visibleRowCount, rowData, loadRow]);

  // Rows on screen: not-yet-loaded ones (skeleton) and ones with posters; a
  // catalog that came back empty has nothing to show and is left out.
  const browseRows = useMemo(
    () =>
      visibleCatalogs.slice(0, visibleRowCount).filter((cat) => {
        const d = rowData[catalogKey(cat)];
        return !d || !d.loaded || d.items.length > 0;
      }),
    [catalogs, hiddenCatalogs, visibleRowCount, rowData],
  );

  // Vertical position: the focused row slides to the top of the viewport.
  const rowIndexOfKey = (key: string | null) =>
    key ? Math.max(0, browseRows.findIndex((c) => catalogKey(c) === key)) : 0;
  const translateY = useSharedValue(-rowIndexOfKey(lastFocusedDiscoverRowKey) * POSTER_ROW_HEIGHT);
  const animatedRowsStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));
  // A row above the focused one appearing/disappearing shifts its index.
  useEffect(() => {
    if (!lastFocusedDiscoverRowKey) return;
    translateY.value = withTiming(-rowIndexOfKey(lastFocusedDiscoverRowKey) * POSTER_ROW_HEIGHT, {
      duration: 160,
      easing: Easing.out(Easing.quad),
    });
  }, [browseRows]);

  // Last D-pad key seen by the native key forwarder (it fires before Android
  // moves focus), used to recognise a stray focus jump between rows.
  const lastDpadKeyRef = useRef({ code: 0, at: 0 });
  useEffect(() => {
    const handleKeyDown = (e: { keyCode?: number }) => {
      const k = e?.keyCode;
      if (k === 19 || k === 20 || k === 21 || k === 22) {
        lastDpadKeyRef.current = { code: k, at: Date.now() };
      }
    };
    KeyEvent.onKeyDownListener(handleKeyDown);
    return () => KeyEvent.removeKeyDownListener();
  }, []);

  const handleRowCardFocus = useCallback(
    (rowKey: string, rowIndex: number, item: CatalogMediaItem, itemKey: string): boolean => {
      // Left/Right never changes row. If focus landed on another row right
      // after one of those keys (held-key overshoot at the end of a row), put
      // focus back instead of following it.
      const { code, at } = lastDpadKeyRef.current;
      if (
        lastFocusedDiscoverBrowseKey &&
        lastFocusedDiscoverRowKey &&
        rowKey !== lastFocusedDiscoverRowKey &&
        (code === 21 || code === 22) &&
        Date.now() - at < 350
      ) {
        requestRefocus();
        return false;
      }
      lastFocusedDiscoverBrowseKey = itemKey;
      lastFocusedDiscoverRowKey = rowKey;
      setVisibleRowCount((c) => (rowIndex + ROW_LOOKAHEAD + 1 > c ? rowIndex + ROW_LOOKAHEAD + 1 : c));
      translateY.value = withTiming(-rowIndex * POSTER_ROW_HEIGHT, {
        duration: 160,
        easing: Easing.out(Easing.quad),
      });
      const cat = catalogByKeyRef.current[rowKey];
      if (cat) focusHero(item, cat.baseEndpoint);
      return true;
    },
    [requestRefocus, translateY, focusHero],
  );

  const handleItemPress = useCallback(
    async (item: CatalogMediaItem, cat?: DiscoverCatalog) => {
      const selectedCatalog = cat ?? selectedCatalogRef.current;
      if (cat) setSelectedCatalog(cat);
      if (resolveAbortRef.current) {
        resolveAbortRef.current.abort();
      }
      const controller = new AbortController();
      resolveAbortRef.current = controller;
      // A new page-2 context starts with nothing remembered from an earlier
      // one -- a stale key/offset here is what left Back (the default entry
      // point) without focus and parked it on the rail instead.
      lastFocusedDiscoverResultsKey = null;
      lastResultsScrollY = 0;
      resumeFocusPendingRef.current = false;
      setResultsTarget(item);
      setScreenMode('results');
      setResultsLoading(true);
      setMatchedAddonPosts([]);
      setActiveSourcePost(null);
      setSourceInfo(null);
      setActiveLinkIndex(0);
      setEpisodes([]);

      savedDiscoverState = {
        catalogs,
        selectedCatalog,
        rowData: rowDataRef.current,
        activeHero: getActiveHero(),
        screenMode: 'results',
        resultsTarget: item,
        matchedAddonPosts: [],
        activeSourcePost: null,
        sourceInfo: null,
        activeLinkIndex: 0,
        episodes: [],
      };

      const metaId = item.imdb_id || item.id;
      if (metaId) {
        if (selectedCatalog) {
          fetchItemMeta(selectedCatalog.baseEndpoint, item.type, metaId).then((meta: any) => {
            if (meta?.background || meta?.logo) {
              setResultsTarget((prev) => {
                const next = prev
                  ? { ...prev, banner: meta.background || prev.banner, logo: meta.logo || (prev as any).logo }
                  : prev;
                if (savedDiscoverState) savedDiscoverState.resultsTarget = next;
                return next;
              });
            }
          });
        }
        fetchMatchingCinemetaMeta(metaId, item.type, item.title).then((cMeta: any) => {
          const runtime = formatCinemetaRuntime(cMeta?.runtime);
          if (cMeta?.logo || (cMeta?.cast && cMeta.cast.length > 0) || runtime) {
            setResultsTarget((prev) => {
              const next = prev
                ? {
                    ...prev,
                    logo: cMeta.logo || (prev as any).logo,
                    cast: cMeta.cast && cMeta.cast.length > 0 ? cMeta.cast : (prev as any).cast,
                    runtime: runtime || (prev as any).runtime,
                  }
                : prev;
              if (savedDiscoverState) savedDiscoverState.resultsTarget = next;
              return next;
            });
          }
        });
      }

      const targetIds = extractExternalIds(item);

      const matches: Post[] = [];
      // Publish matches to the list as each one is confirmed instead of
      // holding them all back until the slowest addon has finished.
      // Bursts (several posts confirmed in the same tick) are coalesced
      // into a single state update.
      let publishTimer: ReturnType<typeof setTimeout> | null = null;
      const publishMatches = () => {
        publishTimer = null;
        if (controller.signal.aborted) return;
        const snapshot = [...matches];
        setMatchedAddonPosts(snapshot);
        if (savedDiscoverState) {
          savedDiscoverState.matchedAddonPosts = snapshot;
        }
      };
      const addMatch = (post: Post) => {
        matches.push(post);
        if (!publishTimer) {
          publishTimer = setTimeout(publishMatches, 60);
        }
      };
      await Promise.allSettled(
        installedProviders.map(async (provider) => {
          try {
            // Stremio / Nuvio addons that serve streams are asked by id:
            // the poster's IMDb id is the match, so there is no title search
            // that could return same-named titles of other years.
            const targetImdb = targetIds.imdbId || (item as any).imdb_id || undefined;
            if (isStremioProvider(provider.value) && targetImdb) {
              try {
                const direct = await getStremioDirectMatch({
                  providerValue: provider.value,
                  imdbId: targetImdb,
                  type: item.type,
                  title: item.title,
                  year: item.year,
                  poster: item.poster,
                });
                if (direct) {
                  if (!controller.signal.aborted) addMatch(direct);
                  return;
                }
              } catch {}
            }
            const data = await providerManager.getSearchPosts({
              searchQuery: item.title,
              page: 1,
              providerValue: provider.value,
              signal: controller.signal,
            });
            const posts = normalizeSearchResult(data, provider.value);
            await Promise.allSettled(
              posts.map(async (post) => {
                // A provider result that embeds its own IMDb/TMDB id is
                // judged on that id alone -- it's a stronger signal than any
                // amount of text normalization, so it overrides the text
                // match both ways (accepts loosely-formatted titles the text
                // matcher would miss, and rejects same-titled-but-wrong-year
                // releases the text matcher can't tell apart). Only results
                // with no id at all fall back to the title/year text logic.
                const candidateIds = extractExternalIds(post);
                if (hasExternalId(candidateIds)) {
                  if (hasMatchingExternalId(targetIds, candidateIds)) {
                    addMatch(post);
                  }
                  return;
                }

                const postYear = (post as any).year;
                // Some providers embed a 'movie' | 'series' type directly on
                // their search-result posts (see normalizeSearchResult's
                // `...item` spread) -- when present, this is an extra,
                // independent signal alongside title/year that a same-titled
                // movie and series can't both satisfy.
                const postType = (post as any).type;
                if (isStrictMatch(item.title, post.title, item.year, postYear, item.type, postType)) {
                  addMatch(post);
                  return;
                }

                // The title lines up and we know the year of the poster the
                // user actually clicked, but this provider's search result
                // carries no year of its own to compare it against -- e.g.
                // clicking "The Gentlemen (2024-)" (the series) shouldn't
                // silently absorb a provider's undated "The Gentlemen" hit
                // for the unrelated 2019 movie just because the search
                // result never mentions a year. Rather than guess, resolve
                // this specific candidate's own metadata (the same
                // imdb-based lookup its details screen would use) and only
                // accept it if that confirms the same release -- or if the
                // metadata *also* has no year to check, in which case
                // there's genuinely nothing left to disqualify it with.
                if (
                  controller.signal.aborted ||
                  !isAmbiguousYearMatch(item.title, post.title, item.year, postYear, item.type, postType)
                ) {
                  return;
                }
                try {
                  const info = await providerManager.getMetaData({
                    link: post.link,
                    provider: post.provider || provider.value,
                  });
                  if (controller.signal.aborted) return;
                  const metaImdbId = (info as any)?.imdbId;
                  // Ids the candidate's own page reports settle it outright
                  // when both sides name the same kind of id.
                  const infoIds = extractExternalIds(info);
                  if (infoIds.imdbId && targetIds.imdbId) {
                    if (infoIds.imdbId === targetIds.imdbId) addMatch(post);
                    return;
                  }
                  if (infoIds.tmdbId && targetIds.tmdbId) {
                    if (infoIds.tmdbId === targetIds.tmdbId) addMatch(post);
                    return;
                  }
                  // The provider's own info page for this exact post/link is
                  // the strongest type signal available for it -- stronger
                  // than the search-result's `type` (if any), and it's what
                  // actually explains the original bug: a type-scoped
                  // Cinemeta lookup below (item.type = 'series') against a
                  // movie's imdb id typically resolves nothing, so metaYear
                  // stays undefined -- which the old code then treated as
                  // "no year anywhere, nothing to disqualify with" and
                  // accepted anyway. Checking info.type first catches that
                  // case before it ever gets there.
                  const metaType = (info as any)?.type;
                  if (mediaKindsConflict(item.type, metaType)) {
                    return;
                  }
                  let metaYear: string | undefined;
                  if (metaImdbId) {
                    const cMeta = await fetchMatchingCinemetaMeta(metaImdbId, item.type, post.title);
                    if (cMeta?.year !== undefined && cMeta?.year !== null) {
                      metaYear = String(cMeta.year);
                    } else if (cMeta?.releaseInfo) {
                      metaYear = String(cMeta.releaseInfo).match(/(19|20)\d{2}/)?.[0];
                    }
                  }
                  if (!metaYear) {
                    // The page's own tags usually lead with the year.
                    metaYear = ((info as any)?.tags || [])
                      .map((t: any) => String(t).match(/^(19|20)\d{2}$/)?.[0])
                      .find(Boolean);
                  }
                  if (controller.signal.aborted) return;
                  // Stremio addons: a same-titled hit whose year can't be
                  // verified is not accepted when we know the clicked
                  // title's year (e.g. other "The Odyssey" releases).
                  if (!metaYear && isStremioProvider(provider.value) && item.year) {
                    return;
                  }
                  if (
                    !metaYear ||
                    isStrictMatch(item.title, post.title, item.year, metaYear, item.type, metaType)
                  ) {
                    addMatch(post);
                  }
                } catch (metaErr) {
                  // Couldn't resolve this candidate's own metadata -- fall
                  // back to the previous permissive behaviour rather than
                  // silently dropping a possibly-correct match, but still
                  // honor a known type conflict from the search result
                  // itself (postType) or the raw scraped titles, since that
                  // much doesn't require the failed network call.
                  if (
                    !controller.signal.aborted &&
                    !mediaKindsConflict(item.type, postType, item.title, post.title)
                  ) {
                    addMatch(post);
                  }
                }
              }),
            );
          } catch (e) {
            if ((e as any)?.name !== 'AbortError') {
              console.warn(`[Discover] Match error on ${provider.value}:`, e);
            }
          }
        }),
      );
      if (publishTimer) {
        clearTimeout(publishTimer);
        publishTimer = null;
      }
      if (controller.signal.aborted) return;
      publishMatches();
      setResultsLoading(false);
    },
    [installedProviders, catalogs, getActiveHero],
  );

  // Consumes a pending "open this item's results view" request set by
  // Home's Continue Watching card (see openDiscoverResultFor above), once,
  // right after mount -- reusing the exact same matching flow a fresh
  // page-1 poster tap goes through, rather than restoring the browse/
  // results state this screen had left off with.
  const pendingDiscoverOpenConsumedRef = useRef(false);
  useEffect(() => {
    if (pendingDiscoverOpenConsumedRef.current) return;
    pendingDiscoverOpenConsumedRef.current = true;
    if (pendingDiscoverOpenItem) {
      const item = pendingDiscoverOpenItem;
      pendingDiscoverOpenItem = null;
      const hint = pendingDiscoverResumeHint;
      pendingDiscoverResumeHint = null;
      if (hint) setResumeHint(hint);
      handleItemPress(item);
      if (hint) resumeFocusPendingRef.current = true;
    }
  }, [handleItemPress]);

  const handleSelectSourceCard = useCallback(async (sourcePost: Post) => {
    setActiveSourcePost(sourcePost);
    setSourceInfo(null);
    setActiveLinkIndex(0);
    setEpisodes([]);
    setLoadingSourceInfo(true);
    if (savedDiscoverState) {
      savedDiscoverState.activeSourcePost = sourcePost;
      savedDiscoverState.sourceInfo = null;
      savedDiscoverState.activeLinkIndex = 0;
      savedDiscoverState.episodes = [];
    }
    try {
      const info = await providerManager.getMetaData({
        link: sourcePost.link,
        provider: sourcePost.provider || '',
      });
      setSourceInfo(info);
      if (savedDiscoverState) {
        savedDiscoverState.sourceInfo = info;
      }
    } catch (err) {
      console.warn('[Discover] getMetaData error:', err);
      setSourceInfo(null);
      ToastAndroid.show('Could not load details from this source.', ToastAndroid.SHORT);
    } finally {
      setLoadingSourceInfo(false);
    }
  }, []);

  // Once the matching addon sources finish loading for a resumed item,
  // jump straight to the same source it was originally played from
  // (matched on the source's own info-page link, falling back to just the
  // provider) instead of leaving the person to re-pick a source card from
  // scratch every time they tap a Discover-sourced Continue Watching card.
  // Runs once per mount -- if the person picks a different source
  // manually, that choice is left alone.
  //
  // Matches now stream in one by one, so this can't just pick from whatever
  // the first batch happens to contain: the exact info-page match is taken
  // the moment it shows up, but the provider-only fallback (and giving up)
  // waits until every addon has finished searching -- same outcome as when
  // the list used to arrive all at once.
  useEffect(() => {
    if (autoSelectedResumeSourceRef.current) return;
    if (!resumeHint || activeSourcePost) return;
    const exact =
      (resumeHint.infoUrl && matchedAddonPosts.find((p) => p.link === resumeHint.infoUrl)) || null;
    if (exact) {
      autoSelectedResumeSourceRef.current = true;
      handleSelectSourceCard(exact);
      return;
    }
    if (resultsLoading) return;
    autoSelectedResumeSourceRef.current = true;
    const byProvider =
      (resumeHint.providerValue &&
        matchedAddonPosts.find((p) => p.provider === resumeHint.providerValue)) ||
      null;
    if (byProvider) {
      handleSelectSourceCard(byProvider);
    }
  }, [resumeHint, activeSourcePost, matchedAddonPosts, resultsLoading, handleSelectSourceCard]);

  // Once that resumed source's own metadata (and its season/quality/dub
  // dropdown) has loaded, land on the exact entry the episode was
  // originally played from -- see DiscoverResumeHint.linkTitle. Runs once
  // per mount; a manual pick afterwards is left alone.
  const autoSelectedResumeLinkRef = useRef(false);
  useEffect(() => {
    if (autoSelectedResumeLinkRef.current) return;
    if (!resumeHint?.linkTitle) return;
    if (!sourceInfo?.linkList?.length) return;
    autoSelectedResumeLinkRef.current = true;
    const idx = sourceInfo.linkList.findIndex((l) => l.title === resumeHint.linkTitle);
    if (idx >= 0) {
      setActiveLinkIndex(idx);
      if (savedDiscoverState) savedDiscoverState.activeLinkIndex = idx;
    }
  }, [resumeHint, sourceInfo]);

  const handleBackToSources = useCallback(() => {
    // The episode/link that held focus is about to disappear; hand focus to
    // the Back button (scrolled into view) instead of letting Android pick.
    lastFocusedDiscoverResultsKey = null;
    lastResultsScrollY = 0;
    resultsScrollRef.current?.scrollTo({ x: 0, y: 0, animated: false });
    setActiveSourcePost(null);
    setSourceInfo(null);
    setActiveLinkIndex(0);
    setEpisodes([]);
    if (savedDiscoverState) {
      savedDiscoverState.activeSourcePost = null;
      savedDiscoverState.sourceInfo = null;
      savedDiscoverState.activeLinkIndex = 0;
      savedDiscoverState.episodes = [];
    }
  }, []);

  useEffect(() => {
    const rawLinkList = sourceInfo?.linkList || [];
    const linkList = rawLinkList.filter(
      (l) =>
        !isQualityExcluded(l?.quality, excludedQualities) &&
        !isQualityExcluded(l?.title, excludedQualities),
    );
    const usableLinkList = linkList.length > 0 ? linkList : rawLinkList;
    const activeLink = usableLinkList[activeLinkIndex] || usableLinkList[0];

    if (!activeSourcePost?.provider) {
      setEpisodes([]);
      return;
    }

    // Returning from the player: episodes were restored with the rest of the
    // saved page-2 state and nothing they depend on has changed, so skip the
    // re-fetch (and the loading row that would replace the grid, unmounting
    // the card that is supposed to get focus back).
    if (restoredEpisodesRef.current) {
      restoredEpisodesRef.current = false;
      if (episodes.length > 0) return;
    }

    if (activeLink?.episodesLink) {
      let isMounted = true;
      setEpisodesLoading(true);
      providerManager
        .getEpisodes({ url: activeLink.episodesLink, providerValue: activeSourcePost.provider })
        .then((eps) => {
          const sorted = sortEpisodesChronologically(eps || []);
          const filtered = sorted.filter(
            (ep: any) =>
              !isQualityExcluded(ep?.quality, excludedQualities) &&
              !isQualityExcluded(ep?.title, excludedQualities),
          );
          const finalEps = filtered.length > 0 ? filtered : sorted;

          if (isMounted) {
            setEpisodes(finalEps);
            if (savedDiscoverState) savedDiscoverState.episodes = finalEps;
          }
        })
        .catch((err) => {
          console.warn('[Discover] getEpisodes error:', err);
          if (isMounted) {
            setEpisodes([]);
            if (savedDiscoverState) savedDiscoverState.episodes = [];
          }
        })
        .finally(() => {
          if (isMounted) setEpisodesLoading(false);
        });
      return () => {
        isMounted = false;
      };
    }

    const isSeries =
      resultsTarget?.type === 'series' ||
      sourceInfo?.type === 'series' ||
      sourceInfo?.type === 'tv' ||
      selectedCatalog?.type === 'series' ||
      Boolean(activeLink?.directLinks?.some((d) => d.type === 'series')) ||
      Boolean(activeLink?.directLinks && activeLink.directLinks.length > 1 && resultsTarget?.type !== 'movie');

    if (isSeries && activeLink?.directLinks && activeLink.directLinks.length > 0) {
      const directEps: EpisodeLink[] = activeLink.directLinks.map((d, i) => ({
        id: (d as any).id || `${i + 1}`,
        title: d.title || `Episode ${i + 1}`,
        link: d.link,
        image: d.image || sourceInfo?.image || resultsTarget?.poster,
        description: d.description,
        skip: d.skip,
      }));
      const sorted = sortEpisodesChronologically(directEps);
      const filtered = sorted.filter(
        (ep: any) =>
          !isQualityExcluded(ep?.quality, excludedQualities) &&
          !isQualityExcluded(ep?.title, excludedQualities),
      );
      const finalEps = filtered.length > 0 ? filtered : sorted;

      setEpisodes(finalEps);
      if (savedDiscoverState) savedDiscoverState.episodes = finalEps;
      setEpisodesLoading(false);
      return;
    }

    if (isSeries && usableLinkList.length > 1 && !usableLinkList.some((l) => Boolean(l.episodesLink))) {
      const linkListEps: EpisodeLink[] = usableLinkList
        .map((l, i) => ({
          id: `${i + 1}`,
          title: l.title || `Episode ${i + 1}`,
          link: l.directLinks?.[0]?.link || (l as any).link || '',
          image: l.directLinks?.[0]?.image || sourceInfo?.image || resultsTarget?.poster,
          description: l.directLinks?.[0]?.description,
        }))
        .filter((e) => Boolean(e.link));

      if (linkListEps.length > 1) {
        const sorted = sortEpisodesChronologically(linkListEps);
        const filtered = sorted.filter(
          (ep: any) =>
            !isQualityExcluded(ep?.quality, excludedQualities) &&
            !isQualityExcluded(ep?.title, excludedQualities),
        );
        const finalEps = filtered.length > 0 ? filtered : sorted;

        setEpisodes(finalEps);
        if (savedDiscoverState) savedDiscoverState.episodes = finalEps;
        setEpisodesLoading(false);
        return;
      }
    }

    setEpisodes([]);
    if (savedDiscoverState) savedDiscoverState.episodes = [];
  }, [sourceInfo, activeLinkIndex, activeSourcePost, resultsTarget?.type, selectedCatalog?.type, excludedQualities]);

  useEffect(() => {
    let isMounted = true;
    // A provider-supplied IMDb id has to be sanity-checked against the
    // provider's own title. The id on the Cinemeta catalog item the user
    // clicked, though, is Cinemeta's own and comes with its canonical
    // title -- checking that against the provider's scraped title (say
    // "The Boys [Hindi] S1-S5") rejected a perfectly correct id, so
    // episode names/synopses never appeared for such providers.
    const providerImdbId = sourceInfo?.imdbId;
    const catalogImdbId = resultsTarget?.imdb_id || resultsTarget?.id;
    const imdbId = providerImdbId || catalogImdbId;
    const type = sourceInfo?.type || resultsTarget?.type;
    const knownTitle = providerImdbId ? sourceInfo?.title : resultsTarget?.title;
    const key = imdbId && type ? `${type}::${imdbId}` : null;

    if (restoredCinemetaRef.current) {
      // Remount after playback: keep the restored meta so the first layout
      // matches the one the person left (no blank -> refetch -> grow).
      restoredCinemetaRef.current = false;
      cinemetaKeyRef.current = key;
      return () => {
        isMounted = false;
      };
    }

    // Only reset when the title this meta belongs to actually changed; a
    // provider's details arriving later must not wipe an already-correct
    // meta. Seed from the in-memory cache so a new title paints instantly
    // when the hero enrichment already pulled it.
    if (cinemetaKeyRef.current !== key) {
      cinemetaKeyRef.current = key;
      const cached = key ? peekCinemetaMeta(imdbId, type) : null;
      setSourceCinemetaMeta(cached);
      if (savedDiscoverState) savedDiscoverState.sourceCinemetaMeta = cached;
    }

    if (imdbId && type) {
      fetchMatchingCinemetaMeta(imdbId, type, knownTitle).then((meta) => {
        if (!isMounted || !meta) return;
        setSourceCinemetaMeta(meta);
        if (savedDiscoverState) savedDiscoverState.sourceCinemetaMeta = meta;
      });
    }
    return () => {
      isMounted = false;
    };
  }, [
    sourceInfo?.imdbId,
    sourceInfo?.type,
    sourceInfo?.title,
    resultsTarget?.imdb_id,
    resultsTarget?.id,
    resultsTarget?.type,
    resultsTarget?.title,
  ]);

  const getSavedResumePosition = useCallback(
    (canonicalLink: string): number => {
      try {
        const cwState: any = useContinueWatchingStore.getState?.();
        const cwItems = cwState?.items || [];
        const cwMatch = cwItems.find(
          (c: any) =>
            c?.infoUrl === canonicalLink ||
            c?.link === canonicalLink ||
            c?.id === canonicalLink ||
            c?.episodeId === canonicalLink,
        );
        if (cwMatch?.position) return cwMatch.position;

        const csState: any = useContentStore.getState?.();
        const history = csState?.watchHistory || [];
        const hMatch = history.find(
          (h: any) =>
            h?.link === canonicalLink ||
            h?.id === canonicalLink ||
            h?.episodeId === canonicalLink,
        );
        if (hMatch?.currentTime) return hMatch.currentTime;
      } catch (err) {
        console.warn('[Discover] Failed to retrieve resume position:', err);
      }
      return 0;
    },
    [],
  );

  const handleResolveAndPlay = useCallback(
    async (
      link: string,
      title: string,
      type: string,
      episodeIdx: number = 0,
      customEpisodes?: EpisodeLink[],
      episodeKey?: string,
    ) => {
      const providerValue = activeSourcePost?.provider;
      if (!providerValue || !link) {
        ToastAndroid.show('No active provider found for this media', ToastAndroid.SHORT);
        return;
      }
      if (!onPlayStream) {
        onSelectItem(activeSourcePost);
        return;
      }
      setExtractingLink(true);
      try {
        const streams: Stream[] = await providerManager.getStream({
          link,
          type,
          providerValue,
        });
        if (!streams || streams.length === 0) {
          ToastAndroid.show('No valid stream links found from this source.', ToastAndroid.LONG);
          return;
        }

        const filteredStreams = streams.filter(
          (s) =>
            !isQualityExcluded((s as any)?.quality, excludedQualities) &&
            !isQualityExcluded((s as any)?.server, excludedQualities),
        );
        const usableStreams = filteredStreams.length > 0 ? filteredStreams : streams;

        const defaultBest =
          pickPreferredStream(usableStreams, getPlaybackPrefs(activeSourcePost?.link)) || usableStreams[0];
        const qualities = usableStreams.map((s, idx) => ({
          name: s.quality ? `${s.quality}p` : s.server || `Source ${idx + 1}`,
          url: s.link,
          headers: s.headers,
          sourceType: s.type,
          drm: s.drm,
          server: s.server,
          quality: s.quality,
          tags: (() => {
            const raw: any[] = Array.isArray((s as any).tags)
              ? (s as any).tags
              : typeof (s as any).tag === 'string'
              ? [(s as any).tag]
              : [];
            const q = String(s.quality ?? '').trim().toLowerCase();
            return raw
              .map((t) => (typeof t === 'string' ? t.trim() : ''))
              .filter((t) => Boolean(t) && t.toLowerCase() !== q);
          })(),
        }));

        const playStream = (best: Stream) => {
        const episodesToSend =
          customEpisodes && customEpisodes.length > 0
            ? customEpisodes
            : episodes && episodes.length > 0
            ? episodes
            : undefined;

        // Same season/episode-number + Cinemeta synopsis/thumbnail
        // enrichment the on-screen episode grid below already applies for
        // display -- mirrored here so the TV player's "Videos" list and
        // "Up Next" popup get real synopses/mini-posters too, instead of
        // whatever bare title/link the provider returned.
        const rawLinkListForEnrich = sourceInfo?.linkList || [];
        const linkListForEnrich = rawLinkListForEnrich.filter(
          (l) =>
            !isQualityExcluded((l as any)?.quality, excludedQualities) &&
            !isQualityExcluded((l as any)?.title, excludedQualities),
        );
        const usableLinkListForEnrich =
          linkListForEnrich.length > 0 ? linkListForEnrich : rawLinkListForEnrich;
        const activeLinkForEnrich = usableLinkListForEnrich[activeLinkIndex] || usableLinkListForEnrich[0];

        const enrichedEpisodesToSend = episodesToSend
          ? episodesToSend.map((ep, idx) => {
              // Prefer the season number embedded in the episode's own
              // title (providers that flatten every season into one list
              // give each episode a "S01 E01" / "S02 E01" style title) over
              // the tab-level guess -- otherwise every episode collapses
              // onto the same season number and two different episodes can
              // end up with an identical "S01E01" label.
              const seasonNum =
                parseSeasonNumber(ep.title) ?? parseSeasonNumber(activeLinkForEnrich?.title) ?? activeLinkIndex + 1;
              const episodeNum = parseEpisodeNumber(ep.title) ?? idx + 1;
              const cinemetaEp = findCinemetaEpisode(sourceCinemetaMeta, seasonNum, episodeNum);
              return {
                ...ep,
                // Real episode name (Cinemeta) over whatever bare/numeric
                // label the provider used, e.g. "Episode 12" or "S01E12" --
                // mirrors the on-screen episode grid above so the player's
                // "Videos" list and "Up Next" popup show real names too.
                title: cinemetaEp?.name || cinemetaEp?.title || ep.title,
                image: cinemetaEp?.thumbnail || ep.image,
                synopsis: ep.description || cinemetaEp?.overview,
                season: seasonNum,
                episodeNumber: episodeNum,
                releaseDate: formatEpisodeReleaseDate(cinemetaEp?.released),
              };
            })
          : undefined;

        if (savedDiscoverState) {
          savedDiscoverState.screenMode = 'results';
          savedDiscoverState.resultsTarget = resultsTarget;
          savedDiscoverState.matchedAddonPosts = matchedAddonPosts;
          savedDiscoverState.activeSourcePost = activeSourcePost;
          savedDiscoverState.sourceInfo = sourceInfo;
          savedDiscoverState.activeLinkIndex = activeLinkIndex;
          savedDiscoverState.episodes = episodesToSend || episodes;
          savedDiscoverState.sourceCinemetaMeta = sourceCinemetaMeta;
        }

        const canonicalKey = episodeKey || link || activeSourcePost?.link;

        // Resume matching: prefer the resume hint carried straight from the
        // Continue Watching entry itself (see resumeHint state above) --
        // it's a direct, positive signal of exactly which title/episode
        // this position belongs to, rather than a guess based on whichever
        // link string this particular re-fetch happened to resolve to. A
        // series episode only takes the hint's position if its own stable
        // season/episode key (or, for older entries, its raw episode link)
        // matches; a movie has nothing else to disambiguate, so any
        // resumeHint position applies. Falls back to the raw canonical-key
        // lookup for anything not opened via a Continue Watching card.
        const isSeriesPlay = type === 'series';
        const resumeHintPosition = resumeHint
          ? isSeriesPlay
            ? resumeHint.episodeKey && resumeHint.episodeKey === episodeKey
              ? resumeHint.position
              : resumeHint.episodeLink && resumeHint.episodeLink === link
              ? resumeHint.position
              : undefined
            : resumeHint.position
          : undefined;
        const resumePos = resumeHintPosition ?? getSavedResumePosition(canonicalKey);

        onPlayStream(best.link, title, {
          // IMDb-id providers keep a backdrop in `image` and the portrait
          // poster in `poster`/the listing post -- prefer the poster (see
          // the matching comment in TVDetailsScreen).
          posterUrl: sourceInfo?.imdbId
            ? sourceInfo?.poster || activeSourcePost?.image || sourceInfo?.image || resultsTarget?.poster
            : sourceInfo?.image || sourceInfo?.poster || activeSourcePost?.image || resultsTarget?.poster,
          itemLink: activeSourcePost?.link,
          episodeId: canonicalKey,
          startPosition: resumePos,
          providerValue,
          linkTitle: activeLinkForEnrich?.title,
          episodes: enrichedEpisodesToSend,
          currentEpisodeIndex: episodeIdx,
          qualities,
          skip: best.skip,
          headers: best.headers,
          sourceType: best.type,
          drm: best.drm,
          subtitles: best.subtitles,
          // Marks any Continue Watching entry this session produces as
          // having come from this Discover results view, so Home's card
          // press handler can reopen this same page-2 inspector instead of
          // the regular details screen. See openDiscoverResultFor below.
          discoverSource: resultsTarget || undefined,
          // Ids for TheIntroDB skip markers. Provider ids first, then the
          // Cinemeta meta already matched for this title (its `moviedb_id` is
          // the TMDB id), then the catalog item's own imdb id. Whatever is
          // still missing is worked out in the player from `mediaTitle`.
          tmdbId: sourceInfo?.tmdbId || sourceCinemetaMeta?.moviedb_id,
          imdbId:
            sourceInfo?.imdbId ||
            sourceCinemetaMeta?.imdb_id ||
            [resultsTarget?.imdb_id, resultsTarget?.id].find(
              (v) => typeof v === 'string' && /^tt\d+$/.test(v),
            ),
          mediaTitle: resultsTarget?.title || sourceInfo?.title,
          mediaYear: resultsTarget?.year,
        });
        };

        // Stremio addons return many servers/qualities per episode: let
        // the person choose, with release details and size.
        if (isStremioProvider(providerValue) && usableStreams.length > 1) {
          setStreamPicker({
            options: usableStreams.map((s, idx) => ({
              name: s.quality
                ? `${s.quality}p${s.server ? ` — ${s.server}` : ''}`
                : s.server || `Source ${idx + 1}`,
              detail: s.description || (Array.isArray(s.tags) ? s.tags.join(' • ') : undefined),
              size: s.size,
            })),
            onSelect: (idx: number) => {
              setStreamPicker(null);
              playStream(usableStreams[idx]);
            },
          });
          return;
        }
        playStream(defaultBest);
      } catch (err: any) {
        console.warn('[Discover] getStream error:', err);
        ToastAndroid.show(err?.message || 'Failed to extract stream link.', ToastAndroid.SHORT);
      } finally {
        setExtractingLink(false);
      }
    },
    [
      activeSourcePost,
      sourceInfo,
      episodes,
      onPlayStream,
      onSelectItem,
      resultsTarget,
      matchedAddonPosts,
      activeLinkIndex,
      excludedQualities,
      sourceCinemetaMeta,
      getSavedResumePosition,
      resumeHint,
    ],
  );

  const backToBrowse = useCallback(() => {
    if (activeSourcePost) {
      handleBackToSources();
      return;
    }
    if (resolveAbortRef.current) resolveAbortRef.current.abort();
    lastFocusedDiscoverResultsKey = null;
    lastResultsScrollY = 0;
    setScreenMode('browse');
    setResultsTarget(null);
    setMatchedAddonPosts([]);
    setActiveSourcePost(null);
    setSourceInfo(null);
    setActiveLinkIndex(0);
    setEpisodes([]);
    if (savedDiscoverState) {
      savedDiscoverState.screenMode = 'browse';
      savedDiscoverState.resultsTarget = null;
      savedDiscoverState.matchedAddonPosts = [];
      savedDiscoverState.activeSourcePost = null;
      savedDiscoverState.sourceInfo = null;
      savedDiscoverState.activeLinkIndex = 0;
      savedDiscoverState.episodes = [];
    }
  }, [activeSourcePost, handleBackToSources]);

  // Hardware Back Key: only handle this screen's own back-stack
  useEffect(() => {
    const handleBack = () => {
      if (manageVisible) {
        setManageVisible(false);
        return true;
      }
      if (screenMode === 'results') {
        backToBrowse();
        return true;
      }
      return false;
    };

    onRegisterBackHandler?.(handleBack);
    return () => onRegisterBackHandler?.(null);
  }, [screenMode, manageVisible, backToBrowse, onRegisterBackHandler]);

  useEffect(() => {
    return () => {
      if (resolveAbortRef.current) resolveAbortRef.current.abort();
    };
  }, []);

  // Show/hide one category (row) from the Catalogs popup.
  const handleToggleCategory = useCallback((cat: DiscoverCatalog) => {
    const key = catalogKey(cat);
    if (stremioCatalogStorage.getHiddenCatalogs().some((h) => h.key === key)) {
      stremioCatalogStorage.unhideCatalog(key);
    } else {
      stremioCatalogStorage.hideCatalog({
        key,
        name: catalogDisplayName(cat),
        manifestName: cat.manifestName,
      });
      // If focus was last on the row that just went away, come back to the
      // Catalogs button instead of a poster that no longer exists.
      if (lastFocusedDiscoverRowKey === key) {
        lastFocusedDiscoverBrowseKey = 'manage-btn';
        lastFocusedDiscoverRowKey = null;
      }
    }
    setHiddenCatalogs(stremioCatalogStorage.getHiddenCatalogs());
  }, []);

  const handleRowCardPress = useCallback(
    (rowKey: string, item: CatalogMediaItem) => {
      handleItemPress(item, catalogByKeyRef.current[rowKey]);
    },
    [handleItemPress],
  );
  const getBrowseKey = useCallback(() => lastFocusedDiscoverBrowseKey, []);
  const getCatalogsBtnHandle = useCallback(
    () => (manageBtnRef.current ? findNodeHandle(manageBtnRef.current) : null),
    [],
  );
  const setTopFirstCard = useCallback((node: View | null) => {
    topFirstCardRef.current = node;
  }, []);

  // Pins the Catalogs button's own focus links: Up/Right have nothing beyond
  // the button (point at itself so they are no-ops), Down goes to the first
  // poster of the first row. Left is handled natively -- see `nativeID`
  // on the button below. Safe to call repeatedly.
  const wireCatalogsBtnLinks = useCallback(() => {
    const node = manageBtnRef.current as any;
    if (!node) return;
    const selfHandle = findNodeHandle(node);
    if (selfHandle == null) return;
    const firstCard = topFirstCardRef.current;
    const downHandle = firstCard ? findNodeHandle(firstCard) : null;
    node.setNativeProps?.({
      nextFocusUp: selfHandle,
      nextFocusRight: selfHandle,
      ...(downHandle != null ? { nextFocusDown: downHandle } : {}),
    });
  }, []);

  // Stable (an inline arrow was re-created every render, so React detached and
  // re-attached the ref -- and re-fired the native bridge calls -- each time).
  const catalogsBtnRef = useCallback(
    (el: View | null) => {
      manageBtnRef.current = el;
      setItemRef('manage-btn', el);
      if (el) wireCatalogsBtnLinks();
    },
    [setItemRef, wireCatalogsBtnLinks],
  );

  // `hasTVPreferredFocus` makes Android call requestFocus() every time the prop
  // flips to true on a mounted view. Re-deriving it on every render meant that
  // a re-render landing while a key was held could drag focus back to a stale
  // item. Evaluate it only when the button is (re)mounted -- the remount nonce
  // in `keyFor` changes exactly when focus must be reclaimed.
  const manageBtnKey = keyFor('manage-btn');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const manageBtnPreferFocus = useMemo(() => shouldPreferFocus('manage-btn', false), [manageBtnKey]);

  const handleAddManifest = useCallback(async () => {
    const url = manifestInput.trim();
    if (!url) return;
    setAddingManifest(true);
    setAddError(null);
    try {
      const loaded = await loadDiscoverCatalogs([{ url }]);
      if (loaded.length === 0) {
        throw new Error('That manifest has no catalogs to show');
      }
      stremioCatalogStorage.addManifest(url, loaded[0].manifestName);
      setManifestInput('');
      await reloadCatalogs(true);
    } catch (e: any) {
      setAddError(e?.message || 'Could not add that catalog');
    } finally {
      setAddingManifest(false);
    }
  }, [manifestInput, reloadCatalogs]);

  const handleToggleManifest = useCallback(
    async (url: string, enabled: boolean) => {
      stremioCatalogStorage.setManifestEnabled(url, enabled);
      setManifests(stremioCatalogStorage.getManifests());
      // Dropping the selected catalog's source must not leave a stale tab.
      await reloadCatalogs(true);
    },
    [reloadCatalogs],
  );

  const handleRemoveManifest = useCallback(
    async (url: string) => {
      clearManifestCache(url);
      stremioCatalogStorage.removeManifest(url);
      await reloadCatalogs(true);
    },
    [reloadCatalogs],
  );

  if (installedProviders.length === 0) {
    return (
      <TVNoProviderFallback
        onInstallProviders={() => onNavigateRoute?.('addons')}
        onOpenSettings={() => onNavigateRoute?.('settings')}
      />
    );
  }

  /* ======================================================================= */
  /* SCREEN MODE: RESULTS (In-Page Dedicated Inspector & Direct Extractor)    */
  /* ======================================================================= */
  if (screenMode === 'results') {
    // See TVDiscoverResultsView.tsx: everything this page needs is
    // either existing component state/refs/callbacks passed straight
    // through, or one of the small wrapper functions defined above
    // (handleSelectLink, shouldPreferResultsFocus, noteResultsFocus,
    // handleResultsScroll) that are the only things still allowed to
    // touch the module-level saved/focus-restore state directly.
    return (
      <>
      <TVStreamPickerModal
        visible={Boolean(streamPicker)}
        options={streamPicker?.options ?? []}
        onSelect={(i) => streamPicker?.onSelect(i)}
        onCancel={() => setStreamPicker(null)}
      />
      <TVDiscoverResultsView
        resultsTarget={resultsTarget}
        selectedCatalog={selectedCatalog}
        resultsLoading={resultsLoading}
        matchedAddonPosts={matchedAddonPosts}
        activeSourcePost={activeSourcePost}
        sourceInfo={sourceInfo}
        loadingSourceInfo={loadingSourceInfo}
        activeLinkIndex={activeLinkIndex}
        chain={chain}
        episodes={episodes}
        episodesLoading={episodesLoading}
        sourceCinemetaMeta={sourceCinemetaMeta}
        extractingLink={extractingLink}
        resumeHint={resumeHint}
        excludedQualities={excludedQualities}
        resultsScrollRef={resultsScrollRef}
        sourcesRowFirstRef={sourcesRowFirstRef}
        keyFor={keyFor}
        setItemRef={setItemRef}
        shouldPreferResultsFocus={shouldPreferResultsFocus}
        noteResultsFocus={noteResultsFocus}
        onResultsScroll={handleResultsScroll}
        handleResultsContentSizeChange={handleResultsContentSizeChange}
        onSelectLink={handleSelectLink}
        backToBrowse={backToBrowse}
        handleSelectSourceCard={handleSelectSourceCard}
        handleResolveAndPlay={handleResolveAndPlay}
      />
      </>
    );
  }

  /* ======================================================================= */
  /* SCREEN MODE: BROWSE (Category Pills, Posters Grid, Hero)                */
  /* ======================================================================= */
  return (
    <View style={styles.container}>
      <View style={styles.heroWrapper}>
        <HeroHost ref={heroHostRef} initial={initialHeroRef.current} />
      </View>

      {/* Rows (one per visible catalog), laid out and navigated like Home. */}
      {catalogsLoading && catalogs.length === 0 ? (
        <View style={styles.centerLoading}>
          <ActivityIndicator size="large" color="#8A5CF6" />
        </View>
      ) : visibleCatalogs.length === 0 ? (
        <View style={styles.emptyState}>
          <MaterialCommunityIcons name="view-grid-plus-outline" size={56} color="#4B5563" />
          <Text style={styles.emptyTitle}>
            {catalogsError || (catalogs.length > 0 ? 'All categories are hidden' : 'No catalogs added yet')}
          </Text>
          <Text style={styles.emptySubtitle}>
            {catalogs.length > 0
              ? 'Show a category again from the Catalogs menu.'
              : 'Add a Stremio addon manifest URL (like Cinemeta) to populate this tab.'}
          </Text>
        </View>
      ) : (
        <View style={styles.stageViewport}>
          <Animated.View style={[styles.slidingRows, animatedRowsStyle]}>
            {browseRows.map((cat, rowIndex) => {
              const key = catalogKey(cat);
              const d = rowData[key];
              const ownsRefocus = Boolean(refocusKey && refocusKey.startsWith(`${key}@@`));
              return (
                <TVPosterRow
                  key={key}
                  rowKey={key}
                  title={catalogDisplayName(cat)}
                  sourceLabel={cat.manifestName}
                  items={d ? d.items : EMPTY_ITEMS}
                  loading={!d || d.loading || !d.loaded}
                  rowIndex={rowIndex}
                  getLastFocusedKey={getBrowseKey}
                  refocusKey={ownsRefocus ? refocusKey : null}
                  refocusNonce={ownsRefocus ? refocusNonce : 0}
                  onCardFocus={handleRowCardFocus}
                  onCardPress={handleRowCardPress}
                  registerItemRef={setItemRef}
                  onNeedMore={loadMoreRow}
                  getUpHandle={getCatalogsBtnHandle}
                  onTopFirstCard={setTopFirstCard}
                />
              );
            })}
          </Animated.View>
        </View>
      )}

      {/* The only control on this screen besides the rows. */}
      <View style={styles.catalogsBtnWrap}>
        <TVFocusablePressable
          key={manageBtnKey}
          ref={catalogsBtnRef}
          // Left from here always goes to the rail's Discover button. The
          // native DPAD_LEFT handler (NavRailManager.handleDpadLeft) honours
          // this ID before Android's geometric search can pick the Search
          // row or a poster instead.
          nativeID="rail-left-exit"
          hasTVPreferredFocus={manageBtnPreferFocus}
          scaleFocused={1.04}
          focusedBorderColor="#8A5CF6"
          borderRadius={20}
          onFocus={() => {
            lastFocusedDiscoverBrowseKey = 'manage-btn';
            lastFocusedDiscoverRowKey = null;
            registerRailLeftEdge('discover', manageBtnRef.current);
            wireCatalogsBtnLinks();
          }}
          onPress={() => setManageVisible(true)}
          style={styles.manageBtn}
        >
          {() => (
            <View style={styles.manageBtnInner}>
              <MaterialCommunityIcons name="plus" size={16} color="#FFFFFF" />
              <Text style={styles.manageBtnText}>Catalogs</Text>
            </View>
          )}
        </TVFocusablePressable>
      </View>

      <Modal
        visible={manageVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setManageVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>Catalogs</Text>
            <Text style={styles.modalSubtitle}>
              Turn catalogs on or off, show or hide their categories, or add a Stremio addon manifest URL.
            </Text>

            <View style={styles.addRow}>
              <TextInput
                value={manifestInput}
                onChangeText={setManifestInput}
                placeholder="https://.../manifest.json"
                placeholderTextColor="#6B7280"
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.addInput}
                onSubmitEditing={handleAddManifest}
                returnKeyType="done"
              />
              <TVFocusablePressable
                scaleFocused={1.04}
                focusedBorderColor="#FFFFFF"
                borderRadius={8}
                onPress={handleAddManifest}
                style={styles.addBtn}
              >
                {() =>
                  addingManifest ? (
                    <ActivityIndicator size="small" color="#FFFFFF" />
                  ) : (
                    <MaterialCommunityIcons name="plus" size={20} color="#FFFFFF" />
                  )
                }
              </TVFocusablePressable>
            </View>
            {addError && <Text style={styles.addErrorText}>{addError}</Text>}

            <ScrollView style={styles.sourcesList}>
              {manifests.map((m) => (
                <View key={m.url} style={styles.sourceItem}>
                  <View style={styles.sourceItemContent}>
                    <MaterialCommunityIcons name="movie-open-outline" size={20} color="#8A5CF6" />
                    <View style={{ flex: 1, marginLeft: 10 }}>
                      <Text style={styles.sourceProviderName}>{m.name}</Text>
                      <Text numberOfLines={1} style={styles.sourceItemTitle}>
                        {m.url}
                      </Text>
                    </View>
                    <TVFocusablePressable
                      scaleFocused={1.06}
                      focusedBorderColor={m.enabled !== false ? '#8A5CF6' : '#9CA3AF'}
                      borderRadius={8}
                      onPress={() => handleToggleManifest(m.url, m.enabled === false)}
                      style={styles.toggleBtn}
                    >
                      {() => (
                        <View style={styles.toggleInner}>
                          <MaterialCommunityIcons
                            name={m.enabled !== false ? 'toggle-switch' : 'toggle-switch-off-outline'}
                            size={30}
                            color={m.enabled !== false ? '#8A5CF6' : '#6B7280'}
                          />
                          <Text
                            style={[
                              styles.toggleText,
                              m.enabled !== false && styles.toggleTextOn,
                            ]}
                          >
                            {m.enabled !== false ? 'ON' : 'OFF'}
                          </Text>
                        </View>
                      )}
                    </TVFocusablePressable>
                    <TVFocusablePressable
                      scaleFocused={1.06}
                      focusedBorderColor="#EF4444"
                      borderRadius={8}
                      onPress={() => handleRemoveManifest(m.url)}
                      style={styles.removeBtn}
                    >
                      {() => <MaterialCommunityIcons name="trash-can-outline" size={18} color="#EF4444" />}
                    </TVFocusablePressable>
                  </View>

                  {m.enabled !== false &&
                    catalogs
                      .filter((c) => c.manifestUrl === m.url)
                      .map((cat) => {
                        const hidden = hiddenKeySet.has(catalogKey(cat));
                        return (
                          <View key={catalogKey(cat)} style={styles.categoryRow}>
                            <Text
                              numberOfLines={1}
                              style={[styles.categoryName, hidden && styles.categoryNameHidden]}
                            >
                              {catalogDisplayName(cat)}
                            </Text>
                            <TVFocusablePressable
                              scaleFocused={1.06}
                              focusedBorderColor={hidden ? '#9CA3AF' : '#8A5CF6'}
                              borderRadius={8}
                              onPress={() => handleToggleCategory(cat)}
                              style={styles.toggleBtn}
                            >
                              {() => (
                                <View style={styles.toggleInner}>
                                  <MaterialCommunityIcons
                                    name={hidden ? 'eye-off-outline' : 'eye-outline'}
                                    size={22}
                                    color={hidden ? '#6B7280' : '#8A5CF6'}
                                  />
                                  <Text style={[styles.toggleText, !hidden && styles.toggleTextOn]}>
                                    {hidden ? 'HIDDEN' : 'SHOWN'}
                                  </Text>
                                </View>
                              )}
                            </TVFocusablePressable>
                          </View>
                        );
                      })}
                </View>
              ))}
            </ScrollView>

            <TVFocusablePressable
              scaleFocused={1.04}
              focusedBorderColor="#8A5CF6"
              borderRadius={8}
              onPress={() => setManageVisible(false)}
              style={styles.closeBtn}
            >
              {() => <Text style={styles.closeBtnText}>Done</Text>}
            </TVFocusablePressable>
          </View>
        </View>
      </Modal>
    </View>
  );
};

// Exported: TVDiscoverResultsView (the extracted page-2 render) reuses
// this same StyleSheet instance rather than a duplicate, so both files
// stay pixel-identical with zero style duplication.
export const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0E',
    position: 'relative',
    paddingLeft: 0,
  },
  heroWrapper: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 380,
    zIndex: 0,
  },
  // Rows viewport + sliding stack, same geometry as Home.
  stageViewport: {
    position: 'absolute',
    top: ROW_TOP,
    bottom: 0,
    left: 0,
    right: 0,
    overflow: 'hidden',
    zIndex: 2,
  },
  slidingRows: {
    paddingLeft: CONTAINER_PADDING_LEFT,
  },
  catalogsBtnWrap: {
    position: 'absolute',
    top: 12,
    right: 24,
    zIndex: 4,
  },
  categoryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
    paddingLeft: 30,
  },
  categoryName: {
    flex: 1,
    color: '#E5E7EB',
    fontSize: 14,
    fontWeight: '600',
    marginRight: 8,
  },
  categoryNameHidden: {
    color: '#6B7280',
  },
  catalogsScroll: {
    gap: 10,
    paddingRight: CONTAINER_PADDING_RIGHT,
    alignItems: 'center',
  },
  toggleBtn: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginRight: 8,
  },
  toggleInner: {flexDirection: 'row', alignItems: 'center', gap: 4},
  toggleText: {color: '#6B7280', fontSize: 12, fontWeight: '800', minWidth: 24},
  toggleTextOn: {color: '#C4B5FD'},
  manageBtn: {
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#8A5CF6',
  },
  manageBtnInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  manageBtnText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  catalogPill: {
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.12)',
  },
  catalogPillActive: {
    // Was the same translucent black as the inactive pill, distinguished
    // only by border color -- easy to mistake for the focus ring (which
    // also draws a purple-ish border via focusedBorderColor). A filled
    // tint makes the selected category readable at a glance even when
    // focus is elsewhere.
    backgroundColor: 'rgba(138, 92, 246, 0.28)',
    borderColor: '#8A5CF6',
    borderWidth: 1.5,
  },
  catalogText: {
    color: '#D1D5DB',
    fontSize: 13,
    fontWeight: '600',
  },
  catalogTextActive: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
  gridContainer: {
    paddingLeft: CONTAINER_PADDING_LEFT,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: GRID_GAP,
    paddingBottom: 60,
    paddingRight: CONTAINER_PADDING_RIGHT,
  },
  card: {
    backgroundColor: '#16161E',
    borderRadius: 8,
  },
  cardInner: {
    flex: 1,
    borderRadius: 8,
    overflow: 'hidden',
    position: 'relative',
  },
  cardPoster: {
    width: '100%',
    height: '100%',
  },
  focusBorderGlow: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 8,
    borderWidth: 3,
    borderColor: '#FFFFFF',
  },
  loadMoreCard: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadMoreInner: {
    alignItems: 'center',
    gap: 6,
  },
  loadMoreText: {
    color: '#9CA3AF',
    fontSize: 12,
    fontWeight: '600',
  },
  centerLoading: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 40,
    gap: 10,
  },
  emptyTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
  },
  emptySubtitle: {
    color: '#9CA3AF',
    fontSize: 13,
    textAlign: 'center',
    maxWidth: 420,
  },
  emptyAddBtn: {
    marginTop: 12,
    backgroundColor: '#8A5CF6',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 10,
  },
  emptyAddBtnText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  resultsRoot: {
    flex: 1,
    backgroundColor: '#0A0A0E',
    position: 'relative',
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT,
  },
  resultsBackdropLayer: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT,
    zIndex: 0,
  },
  resultsBackdropImage: {
    width: '100%',
    height: '100%',
    opacity: 0.88,
  },
  resultsLeftGradient: {
    ...StyleSheet.absoluteFillObject,
    width: '75%',
  },
  resultsBottomGradient: {
    ...StyleSheet.absoluteFillObject,
  },
  resultsScrollView: {
    flex: 1,
    width: '100%',
    zIndex: 10,
  },
  resultsScrollContent: {
    // App no longer reserves the rail's 72dp strip on page 2 (rail is hidden
    // there), so this carries the whole left gutter itself.
    paddingLeft: RESULTS_PADDING_LEFT,
    paddingRight: CONTAINER_PADDING_RIGHT,
    paddingTop: 24,
    paddingBottom: 60,
  },
  backBtn: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.15)',
  },
  backBtnInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  backBtnText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  cleanHeaderContainer: {
    maxWidth: 720,
    marginBottom: 20,
    backgroundColor: 'transparent',
  },
  targetLogo: {
    width: 320,
    height: 100,
    marginBottom: 12,
    alignSelf: 'flex-start',
  },
  targetTitle: {
    color: '#FFFFFF',
    fontSize: 34,
    fontWeight: '900',
    marginBottom: 6,
    letterSpacing: -0.3,
    textShadowColor: 'rgba(0, 0, 0, 0.95)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 8,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 8,
  },
  ratingBadge: {
    backgroundColor: '#F59E0B',
    paddingHorizontal: 6,
    paddingVertical: 1.5,
    borderRadius: 4,
  },
  ratingText: {
    color: '#000000',
    fontSize: 12,
    fontWeight: '800',
  },
  targetMetaText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
  targetGenreText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
  targetOverview: {
    color: '#FFFFFF',
    fontSize: 13,
    lineHeight: 20,
    // Narrower than cleanHeaderContainer's 720dp cap so the synopsis wraps
    // into more, shorter rows instead of one very wide line stretching
    // across a big chunk of the screen -- the logo/title/badges above keep
    // the full width, only the paragraph text itself is narrowed.
    maxWidth: 460,
    textShadowColor: 'rgba(0, 0, 0, 0.95)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
 targetCastText: {
    color: '#DDE00B',
    fontSize: 12,
    lineHeight: 18,
    marginTop: 6,
    maxWidth: 460,
    textShadowColor: 'rgba(0, 0, 0, 0.95)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 6,
  },
  targetCastLabel: {
    color: '#DDE00B',
    fontWeight: '700',
    textShadowColor: 'rgba(0, 0, 0, 0.95)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 6,
  },
  sectionContainer: {
    marginBottom: 24,
  },
  sectionHeader: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 12,
    letterSpacing: 0.2,
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
  },
  loadingText: {
    color: '#9CA3AF',
    fontSize: 14,
  },
  sourcesRow: {
    gap: 14,
    paddingVertical: 4,
    // Was missing trailing padding entirely, unlike Home's equivalent
    // horizontal rows (see horizontalRowScroll) -- the last source card
    // ended exactly at the scroll content's edge, so focusing it and
    // triggering its scaleFocused growth pushed it straight off-screen.
    paddingRight: 40,
  },
  sourcesLoadingTail: {
    width: 44,
    height: 180,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sourceCard: {
    width: 125,
    height: 180,
    backgroundColor: '#16161E',
    borderRadius: 8,
  },
  sourceCardActive: {
    borderWidth: 2.5,
    borderColor: '#8A5CF6',
  },
  sourceCardInner: {
    flex: 1,
    borderRadius: 8,
    overflow: 'hidden',
  },
  sourcePoster: {
    width: '100%',
    height: '100%',
  },
  sourceBadge: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(10, 10, 14, 0.88)',
    paddingVertical: 4,
    paddingHorizontal: 6,
  },
  sourceBadgeText: {
    color: '#8A5CF6',
    fontSize: 11,
    fontWeight: '700',
    textAlign: 'center',
  },
  pickerSection: {
    gap: 16,
  },
  subBlock: {
    marginBottom: 12,
  },
  subHeader: {
    color: '#D1D5DB',
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 8,
  },
  // Season/quality picker trigger button + popup -- same look as
  // TVDetailsScreen's picker (0.7-opacity card, dynamic sizing, no
  // truncation).
  seasonPickerBtn: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(22, 22, 30, 0.6)',
    borderWidth: 1,
    borderColor: 'rgba(167, 139, 250, 0.35)',
    paddingHorizontal: 16,
    paddingVertical: 10,
    // Grows with the label up to this width, then the label wraps.
    maxWidth: 720,
  },
  seasonPickerBtnInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  seasonPickerBtnText: {
    color: '#FFFFFF',
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '600',
    flexShrink: 1,
  },
  pickerOverlay: {
    flex: 1,
    // Light dim so the results page stays visible behind the popup.
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  pickerBox: {
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
  pickerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  pickerHeaderText: {
    flexShrink: 1,
  },
  pickerTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '800',
  },
  pickerSubtitle: {
    color: '#B4B9C4',
    fontSize: 12,
    marginTop: 2,
  },
  pickerDivider: {
    height: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    marginTop: 14,
    marginBottom: 10,
  },
  pickerList: {
    flexGrow: 0,
    flexShrink: 1,
  },
  // Breathing room so a focused (scaled-up) row isn't clipped by the list.
  pickerListContent: {
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  // Rows inside the picker popup.
  seasonPickerOption: {
    backgroundColor: 'rgba(255, 255, 255, 0.07)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.06)',
    paddingVertical: 13,
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  seasonPickerOptionActive: {
    backgroundColor: 'rgba(138, 92, 246, 0.28)',
    borderColor: '#8A5CF6',
  },
  seasonPickerOptionInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  seasonPickerOptionText: {
    color: '#E5E7EB',
    fontSize: 15,
    lineHeight: 21,
    fontWeight: '600',
    flexShrink: 1,
  },
  seasonPickerOptionTextActive: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
  pickerOptionDetail: {
    color: '#9CA3AF',
    fontSize: 12,
    lineHeight: 17,
    marginTop: 4,
  },
  pickerSizeBadge: {
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  pickerSizeBadgeText: {
    color: '#D1D5DB',
    fontSize: 11,
    fontWeight: '700',
  },
  seasonPickerCheck: {
    flexShrink: 0,
  },
  pickerCancelBtn: {
    alignSelf: 'flex-end',
    marginTop: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 8,
  },
  pickerCancelText: {
    color: '#D1D5DB',
    fontSize: 13,
    fontWeight: '700',
  },
  chipsRow: {

    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    // Small right inset so a chip that lands flush against the row's edge
    // still has headroom for its focus scale-up instead of growing past
    // the edge of the screen.
    paddingRight: 10,
  },
  qualityChip: {
    backgroundColor: 'rgba(22, 22, 30, 0.6)',
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  qualityChipActive: {
    backgroundColor: 'rgba(138, 92, 246, 0.25)',
    borderColor: '#8A5CF6',
  },
  chipInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  chipText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
  episodesGrid: {
    flexDirection: 'column',
    gap: 10,
    // Small right inset so each full-width episode card below has headroom
    // for its focus scale-up (see episodeCard's width: '100%') instead of
    // growing past the edge of the screen when the rightmost pixel of the
    // row is already flush with the container's edge.
    paddingRight: 10,
  },
  episodeCard: {
    backgroundColor: 'rgba(22, 22, 30, 0.6)',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 8,
    width: '100%',
  },
  episodeInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  episodeText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
  episodeTextWrap: {
    flex: 1,
  },
  episodeReleaseText: {
    color: '#8A5CF6',
    fontSize: 11,
    fontWeight: '600',
    marginTop: 2,
  },
  episodeOverviewText: {
    color: '#9CA3AF',
    fontSize: 11,
    marginTop: 2,
  },
  resumeBadge: {
    color: '#A78BFA',
    fontSize: 12,
    fontWeight: '700',
    backgroundColor: 'rgba(138, 92, 246, 0.18)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    marginLeft: 8,
  },
  // Matches TVDetailsScreen's sizeBadge/sizeBadgeText exactly.
  sizeBadge: {
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    marginLeft: 8,
  },
  sizeBadgeText: {
    color: '#D1D5DB',
    fontSize: 11,
    fontWeight: '700',
  },
  sourceResumeBadge: {
    position: 'absolute',
    top: 6,
    right: 6,
    backgroundColor: 'rgba(138, 92, 246, 0.92)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  sourceResumeBadgeText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '700',
  },
  episodeThumbWrap: {
    width: 120,
    height: 68,
    borderRadius: 6,
    overflow: 'hidden',
    backgroundColor: '#1A1A22',
  },
  episodeThumb: {
    width: '100%',
    height: '100%',
  },
  episodeThumbPlayOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.25)',
  },
  // Matches TVDetailsScreen's playBtn/playBtnInner/playBtnText exactly, so
  // a movie's play button looks identical whether reached from Discover or
  // Details.
  directStreamBtn: {
    alignSelf: 'flex-start',
    backgroundColor: '#8A5CF6',
    paddingHorizontal: 28,
    paddingVertical: 14,
  },
  directBtnInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  directBtnText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '800',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.85)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalBox: {
    width: 520,
    maxHeight: 520,
    backgroundColor: '#16161E',
    borderRadius: 16,
    padding: 24,
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  modalTitle: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '800',
    marginBottom: 6,
  },
  modalSubtitle: {
    color: '#9CA3AF',
    fontSize: 14,
    marginBottom: 16,
  },
  modalActions: {
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'flex-end',
    width: '100%',
    marginTop: 14,
  },
  addRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 8,
  },
  addInput: {
    flex: 1,
    backgroundColor: '#0A0A0E',
    color: '#FFFFFF',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 8,
    fontSize: 13,
  },
  addBtn: {
    backgroundColor: '#8A5CF6',
    paddingHorizontal: 16,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 8,
  },
  addErrorText: {
    color: '#EF4444',
    fontSize: 12,
    marginBottom: 12,
  },
  sourcesList: {
    maxHeight: 260,
    marginTop: 8,
    marginBottom: 16,
  },
  hiddenSectionHeader: {
    color: '#6B7280',
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginTop: 8,
    marginBottom: 8,
  },
  sourceItem: {
    backgroundColor: '#0A0A0E',
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  sourceItemContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  sourceProviderName: {
    color: '#8A5CF6',
    fontSize: 12,
    fontWeight: '700',
  },
  sourceItemTitle: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  removeBtn: {
    padding: 8,
  },
  cancelBtn: {
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    paddingVertical: 8,
    paddingHorizontal: 18,
    borderRadius: 8,
  },
  cancelBtnText: {
    color: '#D1D5DB',
    fontSize: 13,
    fontWeight: '600',
  },
  confirmBtn: {
    backgroundColor: '#8A5CF6',
    paddingVertical: 8,
    paddingHorizontal: 18,
    borderRadius: 8,
  },
  confirmBtnText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  closeBtn: {
    alignSelf: 'flex-end',
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: 8,
  },
  closeBtnText: {
    color: '#D1D5DB',
    fontSize: 13,
    fontWeight: '600',
  },
});

export default TVDiscoverScreen;
