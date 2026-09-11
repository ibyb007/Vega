import React, { useState, useEffect, useCallback, useMemo, useRef, useReducer } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Image,
  ActivityIndicator,
  Modal,
  ToastAndroid,
  useWindowDimensions,
  findNodeHandle,
} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import KeyEvent from 'react-native-keyevent';
import { TVHeroMeta, TVHeroMedia } from '../../components/tv/TVHeroMeta';
import { TVFocusablePressable } from '../../components/tv/TVFocusablePressable';
import { TVNoProviderFallback } from '../../components/tv/TVNoProviderFallback';
import useContentStore from '../../lib/zustand/contentStore';
import useContinueWatchingStore from '../../lib/zustand/continueWatchingStore';
import { useHomePageData } from '../../lib/hooks/useHomePageData';
import { getCachedMetadata, getOrFetchMetadata, prefetchMetadata } from '../../lib/services/metadataCache';
import { providerManager } from '../../lib/services/ProviderManager';
import { TVRoute } from '../../components/tv/TVNavigationRail';

const ROW_HEIGHT = 235;
const imdbMetaCache = new Map<string, any>();

let lastFocusedKey: string | null = null;
let lastFocusedRowIndex = 0;

// Normalizes a title for loose equality checks (strip punctuation/case/
// year suffixes) so we can sanity-check a Cinemeta match before trusting
// its artwork, without being thrown off by "The Movie (2019)" vs "the movie".
const normalizeTitle = (t: string | undefined | null): string =>
  (t || '')
    .toLowerCase()
    .replace(/\(\d{4}\)/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const fetchCinemetaByImdb = async (imdbId: string, type: string = 'movie'): Promise<any | null> => {
  if (!imdbId || !imdbId.startsWith('tt')) return null;

  if (imdbMetaCache.has(imdbId)) {
    return imdbMetaCache.get(imdbId);
  }

  try {
    const mediaType = type === 'series' ? 'series' : 'movie';
    const res = await fetch(`https://v3-cinemeta.strem.io/meta/${mediaType}/${imdbId}.json`);
    const data = await res.json();
    if (data?.meta) {
      imdbMetaCache.set(imdbId, data.meta);
      return data.meta;
    }
  } catch {}

  return null;
};

interface TVHomeScreenProps {
  onSelectItem: (item: any) => void;
  // Called instead of onSelectItem when a Continue Watching card is
  // pressed -- resolves the saved episode/movie link directly and starts
  // playback at the stored position, without detouring through the details
  // screen (which would restart from 0:00).
  onResumeItem?: (item: any) => void;
  onNavigateRoute?: (route: TVRoute) => void;
  // Native node handle of the currently-active nav rail button (Home's, in
  // this screen's case) -- wired as `nextFocusLeft` on the first card of
  // each row so pressing Left from the leftmost poster returns to the rail
  // instead of Android's default nearest-neighbor focus search.
  navFocusTarget?: number | null;
  // Lets the rail look up the native node handle of whichever card this
  // screen's content last had focus on, so it can keep the Home button's
  // `nextFocusRight` pointed at that exact card -- refreshed at the moment
  // the button receives focus. That handle can change many times while the
  // user browses without this screen re-rendering at all, so it has to be
  // fetched on demand rather than passed down as a prop value.
  onRegisterEntryHandleGetter?: (getter: (() => number | null) | null) => void;
  // Lets the rail ask this screen to hand focus back to whichever card was
  // last focused, for when OK is pressed on the Home button while Home is
  // already the active tab (a no-op route change, so nothing was moving
  // focus off the rail button the way Right does). Deliberately NOT done
  // by remounting the whole screen (that was the first fix attempted here,
  // and it visibly "refreshed" the screen and made the rail feel laggy
  // right after, since it re-ran every hook on the screen including the
  // catalog data fetch) -- this only force-remounts the one poster
  // component that needs its `hasTVPreferredFocus` to re-fire, which is
  // enough to pull focus back without touching anything else on screen.
  onRegisterReturnFocusTrigger?: (trigger: (() => void) | null) => void;
}

export const TVHomeScreen: React.FC<TVHomeScreenProps> = ({
  onSelectItem,
  onResumeItem,
  onNavigateRoute,
  navFocusTarget,
  onRegisterEntryHandleGetter,
  onRegisterReturnFocusTrigger,
}) => {
  const provider = useContentStore((state) => state.provider);
  const secondaryProvider = useContentStore((state) => state.secondaryProvider);
  const installedProviders = useContentStore((state) => state.installedProviders);
  const continueWatchingItems = useContinueWatchingStore((state) => state.items) || [];
  const removeItemFromHistory = useContinueWatchingStore((state) => state.removeItem);
  // Explicit pixel width/height (not top/left/right/bottom: 0) for the
  // full-bleed hero container below -- on this device/RN build, an
  // absolutely-positioned box relying on all-four-edges-zero to fill its
  // flex parent was resolving to zero size (solid black, no backdrop
  // image at all) instead of filling the screen. Explicit pixel sizing is
  // the version confirmed to actually render.
  const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = useWindowDimensions();

  const [activeHero, setActiveHero] = useState<TVHeroMedia | null>(null);
  const [activeRowIndex, setActiveRowIndex] = useState<number>(lastFocusedRowIndex);
  const [itemToDelete, setItemToDelete] = useState<any | null>(null);
  const [confirmingRemoveAll, setConfirmingRemoveAll] = useState(false);

  const translateY = useSharedValue(-lastFocusedRowIndex * ROW_HEIGHT);

  // Bumped on every focus change; an in-flight metadata resolution checks
  // this before calling setActiveHero so a slow/late response for a poster
  // the user has already navigated away from can never clobber the
  // currently-focused item's hero (fixes the "wrong banner" race).
  const heroRequestIdRef = useRef(0);
  // Debounces the network-bound phase (real detail-page fetch + Cinemeta)
  // so rapidly scrolling through a row doesn't fire a scrape per poster --
  // only the item the user actually pauses on triggers it.
  const heroEnrichTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hasProviders = Boolean(
    installedProviders && installedProviders.length > 0 && provider?.value
  );
  // Secondary source is optional and must be a different addon than the
  // primary one (the store already guards against them matching, but a
  // stale persisted value from before an addon was uninstalled is also
  // possible -- double check it's still actually installed).
  const hasSecondaryProvider = Boolean(
    secondaryProvider?.value &&
      secondaryProvider.value !== provider?.value &&
      installedProviders?.some((p) => p.value === secondaryProvider.value)
  );

  const { data: homeData = [], isLoading } = useHomePageData({
    provider,
    enabled: hasProviders,
  });

  // `useHomePageData` needs a concrete provider object even when disabled
  // (it reads `.value` for the query key before checking `enabled`), so
  // fall back to the primary provider -- the query itself never actually
  // runs unless `hasSecondaryProvider` is true.
  const { data: secondaryHomeData = [], isLoading: isSecondaryLoading } = useHomePageData({
    provider: secondaryProvider || provider,
    enabled: hasSecondaryProvider,
  });

  const watchHistory = useMemo(() => {
    return [...continueWatchingItems]
      .filter((item) => Boolean(item.providerValue || item.infoUrl))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }, [continueWatchingItems]);

  // Stamps every post in a set of rows with the addon it actually came
  // from (only if a row/provider module hasn't already set one itself),
  // so pressing a card later resolves metadata/streams against the right
  // addon regardless of whether it landed in a primary or secondary row.
  // Cloned rather than mutated in place since the underlying arrays are
  // shared react-query cache data.
  const tagRowsWithProvider = (rows: any[], providerValue?: string) =>
    rows.map((row) => ({
      ...row,
      Posts: (row.Posts || []).map((post: any) => ({
        ...post,
        provider: post.provider || providerValue,
      })),
    }));

  const displayRows = useMemo(() => {
    const rows: any[] = [];
    if (watchHistory.length > 0) {
      rows.push({
        title: 'Continue Watching',
        filter: 'continue-watching',
        Posts: watchHistory,
        isHistory: true,
      });
    }

    const primaryRows = tagRowsWithProvider(
      homeData.filter((r) => r.Posts && r.Posts.length > 0),
      provider?.value,
    );
    rows.push(...primaryRows);

    if (hasSecondaryProvider) {
      const secondaryRows = tagRowsWithProvider(
        secondaryHomeData.filter((r) => r.Posts && r.Posts.length > 0),
        secondaryProvider!.value,
      ).map((row) => ({
        ...row,
        // Distinguishes bottom rows sourced from the 2nd addon without
        // disturbing the primary rows' plain titles.
        sourceLabel: secondaryProvider!.display_name,
      }));
      rows.push(...secondaryRows);
    }

    return rows;
  }, [
    watchHistory,
    homeData,
    provider?.value,
    hasSecondaryProvider,
    secondaryHomeData,
    secondaryProvider,
  ]);

  const updateHeroWithBestMetadata = useCallback(
    (item: any, isHistory: boolean = false) => {
      // Claim this focus. Both the instant paint below and the delayed
      // enrichment phase check this before touching state, so a slow
      // response for a poster the user has since moved off of can never
      // clobber whatever is now correctly on screen.
      const requestId = ++heroRequestIdRef.current;
      if (heroEnrichTimerRef.current) {
        clearTimeout(heroEnrichTimerRef.current);
        heroEnrichTimerRef.current = null;
      }

      const posterImage = item.poster || item.background || item.image;
      const targetUrl = item.infoUrl || item.link;
      const targetProvider = item.providerValue || item.provider || provider?.value;

      // The source's own backdrop is authoritative when present -- this
      // covers Continue Watching items (`ContinueWatchingItem.background`,
      // resolved back when the details screen originally fetched them)
      // as well as any catalog item that already carries `backdrop`/
      // `banner`. Cinemeta is only ever used to *fill a gap*, never to
      // override it, and only after confirming the match is the same title.
      const sourceBackdrop = item.background || item.backdrop || item.banner || null;
      const hasSourceBackdrop = Boolean(sourceBackdrop);

      const progressPercent =
        item.duration && item.position
          ? Math.min(100, Math.round((item.position / item.duration) * 100))
          : 0;
      const episodeTitle =
        item.episodeTitle ||
        (item.episode?.title && item.episode.title !== item.title
          ? item.episode.title
          : undefined);
      const baseOverview = isHistory
        ? episodeTitle
          ? `${episodeTitle} • Resume (${progressPercent}%)`
          : `Resume watching (${progressPercent}%)`
        : item.extra || item.description || 'Select title to browse stream links and episodes.';

      // Phase 1 -- instant paint, purely from data already on `item`.
      // No network round trip, so this never lags no matter how fast
      // focus is moving across the row.
      setActiveHero({
        title: item.title,
        backdropUrl: sourceBackdrop || posterImage || undefined,
        posterUrl: posterImage,
        overview: baseOverview,
        year: item.year ? String(item.year) : undefined,
        rating: item.rating ? String(item.rating) : undefined,
        runtime: item.runtime || undefined,
        genres: item.genres?.length ? item.genres : undefined,
        hasLandscapeBackdrop: hasSourceBackdrop,
        isPosterFallback: !hasSourceBackdrop,
      });

      // Continue Watching items already carry a real backdrop -- nothing
      // to enrich, and no need to hit the network for them.
      if (hasSourceBackdrop || !targetUrl || !targetProvider) return;

      // Phase 2 -- after a short pause on this item (so fast scrolling
      // through a row doesn't fire a detail-page scrape per poster),
      // fetch the real metadata (imdbId/type/populateMeta) and, if
      // eligible, Cinemeta's landscape fanart, then upgrade the hero.
      heroEnrichTimerRef.current = setTimeout(async () => {
        if (requestId !== heroRequestIdRef.current) return; // focus moved on

        let backdrop: string | null = null;
        let description = '';
        let rating: string | null = null;
        let year: string | null = null;
        let genres: string[] = [];

        try {
          const info = await getOrFetchMetadata(targetUrl, targetProvider);
          if (requestId !== heroRequestIdRef.current) return; // focus moved on

          if (info) {
            if (info.synopsis) description = info.synopsis;
            if (info.rating) rating = String(info.rating);

            // Only trust an imdbId that came from this item's own
            // detail-page scrape AND that this provider has explicitly
            // opted in to Cinemeta enrichment for (same gate
            // TVDetailsScreen/useHeroMetadata use) -- a raw list item's
            // guessed id is what caused wrong banners before.
            if (info.populateMeta === true && info.imdbId && info.type) {
              const cineMeta = await fetchCinemetaByImdb(info.imdbId, info.type);
              if (requestId !== heroRequestIdRef.current) return; // focus moved on

              if (cineMeta) {
                const titleMatches =
                  !item.title ||
                  !cineMeta.name ||
                  normalizeTitle(cineMeta.name) === normalizeTitle(item.title);

                if (cineMeta.background && titleMatches) {
                  backdrop = cineMeta.background;
                }
                if (!description && cineMeta.description) description = cineMeta.description;
                if (!rating && (cineMeta.imdbRating || cineMeta.rating)) {
                  rating = String(cineMeta.imdbRating || cineMeta.rating);
                }
                if (cineMeta.releaseInfo || cineMeta.year) {
                  year = String(cineMeta.releaseInfo || cineMeta.year);
                }
                if (cineMeta.genres?.length) genres = cineMeta.genres;
              }
            }
          }
        } catch {}

        if (requestId !== heroRequestIdRef.current) return; // focus moved on
        if (!backdrop && !description && !rating && !year && genres.length === 0) return;

        setActiveHero((prev) =>
          prev
            ? {
                ...prev,
                backdropUrl: backdrop || prev.backdropUrl,
                hasLandscapeBackdrop: backdrop ? true : prev.hasLandscapeBackdrop,
                isPosterFallback: backdrop ? false : prev.isPosterFallback,
                overview: isHistory ? prev.overview : description || prev.overview,
                rating: rating || prev.rating,
                year: year || prev.year,
                genres: genres.length > 0 ? genres : prev.genres,
              }
            : prev
        );
      }, 250);
    },
    [provider?.value]
  );

  useEffect(() => {
    if (!activeHero && displayRows.length > 0) {
      const firstRow = displayRows[0];
      if (firstRow?.Posts?.length > 0) {
        updateHeroWithBestMetadata(firstRow.Posts[0], Boolean(firstRow.isHistory));
      }
    }
  }, [displayRows, activeHero, updateHeroWithBestMetadata]);

  // Prevent the debounced enrichment fetch from resolving into a
  // setState call after this screen has unmounted.
  useEffect(() => {
    return () => {
      heroRequestIdRef.current += 1;
      if (heroEnrichTimerRef.current) {
        clearTimeout(heroEnrichTimerRef.current);
        heroEnrichTimerRef.current = null;
      }
    };
  }, []);

  // Tracks whichever history-row card currently has focus, and the state
  // for detecting a D-pad OK/select "hold" on it -- see the key listener
  // effect below for why this exists instead of just `onLongPress`.
  const focusedHistoryItemRef = useRef<any>(null);
  const selectHoldStreakRef = useRef(0);
  const selectHoldTriggeredRef = useRef(false);
  const lastSelectKeyTimeRef = useRef(0);
  // Keyed by the same `itemKey` used for `lastFocusedKey` below, so we can
  // look up the actual native node for "whichever card was last focused"
  // on demand, and resolve it to a node handle for `nextFocusRight`.
  const itemRefsRef = useRef<Record<string, View | null>>({});

  useEffect(() => {
    onRegisterEntryHandleGetter?.(() => {
      const node = lastFocusedKey ? itemRefsRef.current[lastFocusedKey] : null;
      return node ? findNodeHandle(node) : null;
    });
    return () => onRegisterEntryHandleGetter?.(null);
  }, [onRegisterEntryHandleGetter]);

  // Which poster's `key` prop should carry a remount suffix, and a nonce to
  // actually change that suffix each time. Deliberately a ref, not state
  // keyed directly off `lastFocusedKey` -- if the suffix were derived from
  // "is this the currently-last-focused item" on every render, it would
  // *revert* (and force an unwanted remount) the moment focus moved to a
  // different poster during ordinary browsing, which is its own glitch.
  // Only updating this ref in response to an explicit trigger, and forcing
  // a render with a separate reducer, keeps a poster's key stable through
  // normal use and only bumps the one poster the rail actually asked for.
  const refocusRef = useRef<{ key: string | null; nonce: number }>({ key: null, nonce: 0 });
  const [, forceRerenderForRefocus] = useReducer((n) => n + 1, 0);

  useEffect(() => {
    onRegisterReturnFocusTrigger?.(() => {
      if (!lastFocusedKey) return;
      refocusRef.current = { key: lastFocusedKey, nonce: refocusRef.current.nonce + 1 };
      forceRerenderForRefocus();
    });
    return () => onRegisterReturnFocusTrigger?.(null);
  }, [onRegisterReturnFocusTrigger]);

  const handleCardFocus = useCallback(
    (rowIndex: number, item: any, itemKey: string, isHistory: boolean = false) => {
      lastFocusedKey = itemKey;
      lastFocusedRowIndex = rowIndex;
      setActiveRowIndex(rowIndex);

      focusedHistoryItemRef.current = isHistory ? item : null;
      selectHoldStreakRef.current = 0;
      selectHoldTriggeredRef.current = false;

      translateY.value = withTiming(-rowIndex * ROW_HEIGHT, {
        duration: 220,
        easing: Easing.out(Easing.quad),
      });

      updateHeroWithBestMetadata(item, isHistory);

      const targetUrl = item.infoUrl || item.link;
      const targetProvider = item.providerValue || item.provider || provider?.value;
      if (targetUrl && targetProvider) {
        prefetchMetadata(targetUrl, targetProvider);
      }
    },
    [translateY, updateHeroWithBestMetadata, provider?.value]
  );

  // `onLongPress`/`delayLongPress` (still left in place on the card below
  // as a harmless fallback) rely on React Native's touch-responder timing
  // pipeline, which a hardware remote's D-pad OK/select button frequently
  // never enters on Android TV -- the key event is dispatched as a
  // click, not a touch-down-hold-release gesture, so no long-press timer
  // ever starts. `react-native-keyevent` (already used by the TV player
  // for the same underlying reason) sees the raw key stream instead:
  // Android auto-repeats a held key's key-down event at a steady cadence,
  // so a short run of repeats on OK/select IS a hold, independent of
  // whatever gesture-timing RN's Pressable does or doesn't manage on this
  // device.
  useEffect(() => {
    const KEYCODE_DPAD_CENTER = 23;
    const KEYCODE_ENTER = 66;
    const HOLD_STREAK_THRESHOLD = 3;
    const RELEASE_GAP_MS = 400;

    const handleKeyDown = (e: { keyCode?: number }) => {
      if (e?.keyCode !== KEYCODE_DPAD_CENTER && e?.keyCode !== KEYCODE_ENTER) return;
      if (!focusedHistoryItemRef.current) return;

      const now = Date.now();
      if (now - lastSelectKeyTimeRef.current > RELEASE_GAP_MS) {
        selectHoldStreakRef.current = 0;
        selectHoldTriggeredRef.current = false;
      }
      lastSelectKeyTimeRef.current = now;
      selectHoldStreakRef.current += 1;

      if (selectHoldStreakRef.current >= HOLD_STREAK_THRESHOLD && !selectHoldTriggeredRef.current) {
        selectHoldTriggeredRef.current = true;
        setConfirmingRemoveAll(false);
        setItemToDelete(focusedHistoryItemRef.current);
      }
    };

    KeyEvent.onKeyDownListener(handleKeyDown);
    return () => KeyEvent.removeKeyDownListener();
  }, []);

  const confirmDeleteFromHistory = () => {
    if (!itemToDelete) return;
    const identifier = itemToDelete.id || itemToDelete.infoUrl || itemToDelete.link;
    if (identifier) {
      removeItemFromHistory(identifier);
      ToastAndroid.show('Removed from Continue Watching', ToastAndroid.SHORT);
    }
    setItemToDelete(null);
    setConfirmingRemoveAll(false);
  };

  const confirmRemoveAllHistory = () => {
    watchHistory.forEach((histItem: any) => {
      const identifier = histItem.id || histItem.infoUrl || histItem.link;
      if (identifier) removeItemFromHistory(identifier);
    });
    ToastAndroid.show('Cleared Continue Watching', ToastAndroid.SHORT);
    setItemToDelete(null);
    setConfirmingRemoveAll(false);
  };

  const animatedRowsStyle = useAnimatedStyle(() => {
    return {
      transform: [{ translateY: translateY.value }],
    };
  });

  if (!hasProviders) {
    return (
      <TVNoProviderFallback
        onInstallProviders={() => onNavigateRoute?.('addons')}
        onOpenSettings={() => onNavigateRoute?.('settings')}
      />
    );
  }

  if (isLoading && displayRows.length === 0) {
    // Unlike the `!hasProviders` branch above (whose fallback ships its own
    // hasTVPreferredFocus button), this loading state has never had any
    // focusable descendant -- it's just a spinner and some text. That's a
    // real problem whenever this screen is reached by *selecting something
    // focused elsewhere* (e.g. picking a provider on TVSourceSelectScreen,
    // which navigates straight here on press): the node that was focused a
    // moment ago gets unmounted along with that screen, and with nothing
    // focusable anywhere in this one to catch the handoff, Android's focus
    // engine falls back to whatever else is on screen -- which is always
    // the nav rail, since it's the one thing that never unmounts. The rail
    // then expands (any focus lands there) over what looks like a blank
    // screen, even though the user never touched the rail.
    // Wrapping the spinner in a focusable (but inert -- no onPress, no
    // visible focus styling) claims focus deterministically for the
    // duration of the load, exactly the way TVNoProviderFallback's button
    // already does for its own branch. Once real content arrives, the
    // first poster's own hasTVPreferredFocus takes over from here.
    return (
      <TVFocusablePressable
        hasTVPreferredFocus={true}
        scaleFocused={1}
        focusedBorderColor="transparent"
        style={styles.centerLoading}
      >
        {() => (
          <>
            <ActivityIndicator size="large" color="#8A5CF6" />
            <Text style={styles.loadingText}>
              Loading {provider?.displayTitle || provider?.name} catalog...
            </Text>
          </>
        )}
      </TVFocusablePressable>
    );
  }

  return (
    <View style={styles.container}>
      <View style={[styles.fixedHeroContainer, { width: SCREEN_WIDTH, height: SCREEN_HEIGHT }]}>
        <TVHeroMeta media={activeHero} />
      </View>

      <View style={styles.stageViewport}>
        <Animated.View style={[styles.slidingRowsContainer, animatedRowsStyle]}>
          {displayRows.map((row: any, rowIndex: number) => {
            const rowPosts = row.Posts || [];
            if (rowPosts.length === 0) return null;
            const isHistoryRow = Boolean(row.isHistory);

            return (
              <View key={`${row.filter || row.title}-${rowIndex}`} style={styles.rowContainer}>
                <View style={styles.rowTitleWrap}>
                  <Text style={styles.rowCategoryTitle}>{row.title}</Text>
                  {row.sourceLabel ? (
                    <Text style={styles.rowSourceLabel} numberOfLines={1}>
                      {row.sourceLabel}
                    </Text>
                  ) : null}
                </View>

                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.horizontalRowScroll}
                  removeClippedSubviews={false}
                >
                  {rowPosts.map((item: any, pIndex: number) => {
                    const itemKey = `${item.infoUrl || item.link || item.id}-${rowIndex}-${pIndex}`;
                    const isFirstInRow = pIndex === 0;
                    const shouldFocus = lastFocusedKey
                      ? lastFocusedKey === itemKey
                      : rowIndex === 0 && isFirstInRow;

                    const posterImage = item.poster || item.background || item.image;
                    const progressPercent =
                      item.duration && item.position
                        ? Math.min(100, Math.round((item.position / item.duration) * 100))
                        : 0;

                    return (
                      <TVFocusablePressable
                        key={refocusRef.current.key === itemKey ? `${itemKey}-r${refocusRef.current.nonce}` : itemKey}
                        ref={(el) => {
                          itemRefsRef.current[itemKey] = el;
                        }}
                        hasTVPreferredFocus={shouldFocus}
                        scaleFocused={1.06}
                        focusedBorderColor="#FFFFFF"
                        borderRadius={8}
                        delayLongPress={350}
                        {...(isFirstInRow && navFocusTarget
                          ? { nextFocusLeft: navFocusTarget }
                          : { trapFocusLeft: !isFirstInRow })}
                        onFocus={() => handleCardFocus(rowIndex, item, itemKey, isHistoryRow)}
                        onPress={() => {
                          lastFocusedKey = itemKey;
                          lastFocusedRowIndex = rowIndex;

                          if (selectHoldTriggeredRef.current) {
                            // Already handled as a hold (remove-from-history
                            // prompt just opened) -- swallow the release
                            // tap so it doesn't also navigate in underneath
                            // the modal.
                            selectHoldTriggeredRef.current = false;
                            return;
                          }

                          if (isHistoryRow) {
                            // Route through the same details/episode-picker
                            // screen a fresh poster press uses, instead of
                            // re-resolving the old stored stream link
                            // directly. Providers' resolved stream links
                            // (and sometimes even their info-page links)
                            // are often short-lived, so silently replaying
                            // one from continue-watching later tends to
                            // fail with a "provider link invalid" error.
                            // Going through the picker re-fetches
                            // everything fresh; `resumeHint` lets
                            // `TVDetailsScreen` recognize when the episode
                            // picked is the one being resumed and seek to
                            // the saved position instead of starting over.
                            onSelectItem({
                              link: item.infoUrl || item.link,
                              provider: item.providerValue || item.provider,
                              image: posterImage,
                              title: item.title,
                              resumeHint: {
                                episodeLink: item.episode?.link,
                                episodeKey: item.episodeKey,
                                position: item.position,
                              },
                            });
                          } else {
                            onSelectItem(item);
                          }
                        }}
                        onLongPress={() => {
                          if (isHistoryRow) {
                            setConfirmingRemoveAll(false);
                            setItemToDelete(item);
                          }
                        }}
                        style={[styles.card, isHistoryRow && styles.cardCompact]}
                      >
                        {({ focused }) => (
                          <View style={styles.cardInner}>
                            <Image
                              source={{
                                uri:
                                  posterImage ||
                                  'https://placehold.jp/24/363636/ffffff/200x300.png?text=Vega',
                              }}
                              style={styles.cardPoster}
                              resizeMode="cover"
                            />

                            {isHistoryRow && progressPercent > 0 && (
                              <View style={styles.historyMetaOverlay}>
                                <Text style={styles.historyPercentText}>{progressPercent}%</Text>
                                <View style={styles.progressBarTrack}>
                                  <View
                                    style={[
                                      styles.progressBarFill,
                                      { width: `${progressPercent}%` },
                                    ]}
                                  />
                                </View>
                              </View>
                            )}

                            {focused && <View style={styles.focusBorderGlow} />}
                          </View>
                        )}
                      </TVFocusablePressable>
                    );
                  })}
                </ScrollView>
              </View>
            );
          })}
        </Animated.View>
      </View>

      <Modal
        visible={Boolean(itemToDelete)}
        transparent={true}
        animationType="fade"
        onRequestClose={() => {
          setItemToDelete(null);
          setConfirmingRemoveAll(false);
        }}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <MaterialCommunityIcons
              name={confirmingRemoveAll ? 'playlist-remove' : 'movie-remove-outline'}
              size={38}
              color="#EF4444"
            />
            <Text style={styles.modalTitle}>
              {confirmingRemoveAll ? 'Clear Continue Watching?' : 'Remove From History?'}
            </Text>
            {confirmingRemoveAll ? (
              <Text style={styles.modalDescription}>
                This will remove all {watchHistory.length} title
                {watchHistory.length === 1 ? '' : 's'} and their resume progress from your
                Continue Watching row.
              </Text>
            ) : (
              <>
                <Text numberOfLines={2} style={styles.modalSubtitle}>
                  {itemToDelete?.title}
                </Text>
                <Text style={styles.modalDescription}>
                  This will remove the title and its resume progress from your Continue Watching
                  row.
                </Text>
              </>
            )}

            <View style={styles.modalActions}>
              <TVFocusablePressable
                hasTVPreferredFocus={true}
                scaleFocused={1.05}
                focusedBorderColor="#8A5CF6"
                borderRadius={8}
                onPress={() => {
                  setItemToDelete(null);
                  setConfirmingRemoveAll(false);
                }}
                style={styles.cancelBtn}
              >
                {() => <Text style={styles.cancelBtnText}>Cancel</Text>}
              </TVFocusablePressable>

              {confirmingRemoveAll ? (
                <TVFocusablePressable
                  scaleFocused={1.05}
                  focusedBorderColor="#FFFFFF"
                  borderRadius={8}
                  onPress={confirmRemoveAllHistory}
                  style={styles.removeBtn}
                >
                  {() => <Text style={styles.removeBtnText}>Clear All</Text>}
                </TVFocusablePressable>
              ) : (
                <>
                  <TVFocusablePressable
                    scaleFocused={1.05}
                    focusedBorderColor="#8A5CF6"
                    borderRadius={8}
                    onPress={() => setConfirmingRemoveAll(true)}
                    style={styles.selectAllBtn}
                  >
                    {() => (
                      <View style={styles.selectAllBtnInner}>
                        <MaterialIcons name="select-all" size={16} color="#D1D5DB" />
                        <Text style={styles.selectAllBtnText}>Remove All</Text>
                      </View>
                    )}
                  </TVFocusablePressable>

                  <TVFocusablePressable
                    scaleFocused={1.05}
                    focusedBorderColor="#FFFFFF"
                    borderRadius={8}
                    onPress={confirmDeleteFromHistory}
                    style={styles.removeBtn}
                  >
                    {() => (
                      <View style={styles.selectAllBtnInner}>
                        <MaterialCommunityIcons
                          name="trash-can-outline"
                          size={16}
                          color="#FFFFFF"
                        />
                        <Text style={styles.removeBtnText}>Remove</Text>
                      </View>
                    )}
                  </TVFocusablePressable>
                </>
              )}
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0E',
    overflow: 'hidden',
  },
  fixedHeroContainer: {
    // Full-bleed: fills the entire screen behind the row stage instead of
    // being boxed into a short top band. Width/height are applied inline
    // from useWindowDimensions() at the call site (explicit pixel sizing,
    // not top/right/bottom/left: 0) -- see the comment in the component
    // body for why. TVHeroMeta's own gradient fades it to solid
    // background color by the time the rows start (top: 220 below), so
    // the image reads as an edge-to-edge screen backdrop rather than a
    // small cropped/zoomed banner.
    position: 'absolute',
    top: 0,
    left: 0,
    zIndex: 0,
  },
  stageViewport: {
    position: 'absolute',
    top: 220,
    bottom: 0,
    left: 0,
    right: 0,
    overflow: 'hidden',
    zIndex: 2,
  },
  slidingRowsContainer: {
    paddingLeft: 84,
    paddingTop: 0,
  },
  rowContainer: {
    height: ROW_HEIGHT,
  },
  rowTitleWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  rowCategoryTitle: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '800',
    letterSpacing: 0.2,
  },
  rowSourceLabel: {
    color: '#8A5CF6',
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    backgroundColor: 'rgba(138, 92, 246, 0.12)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    overflow: 'hidden',
  },
  horizontalRowScroll: {
    paddingRight: 60,
    gap: 14,
    paddingVertical: 2,
  },
  card: {
    width: 130,
    height: 190,
    backgroundColor: '#16161E',
    borderRadius: 8,
  },
  cardCompact: {
    width: 125,
    height: 180,
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
    borderRadius: 8,
  },
  historyMetaOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(5, 5, 8, 0.85)',
    paddingHorizontal: 6,
    paddingTop: 3,
    paddingBottom: 3,
  },
  historyPercentText: {
    color: '#D1D5DB',
    fontSize: 10,
    fontWeight: '700',
    marginBottom: 2,
  },
  progressBarTrack: {
    width: '100%',
    height: 3,
    backgroundColor: 'rgba(255, 255, 255, 0.25)',
    borderRadius: 1.5,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#8A5CF6',
  },
  focusBorderGlow: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 8,
    borderWidth: 3,
    borderColor: '#FFFFFF',
  },
  centerLoading: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#0A0A0E',
  },
  loadingText: {
    color: '#9CA3AF',
    fontSize: 16,
    marginTop: 16,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalBox: {
    width: 440,
    backgroundColor: '#16161E',
    borderRadius: 14,
    padding: 22,
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  modalTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '800',
    marginTop: 10,
    marginBottom: 4,
  },
  modalSubtitle: {
    color: '#D1D5DB',
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 6,
  },
  modalDescription: {
    color: '#9CA3AF',
    fontSize: 12,
    textAlign: 'center',
    lineHeight: 18,
    marginBottom: 20,
  },
  modalActions: {
    flexDirection: 'row',
    gap: 14,
    width: '100%',
    justifyContent: 'center',
  },
  cancelBtn: {
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    paddingVertical: 10,
    paddingHorizontal: 22,
  },
  cancelBtnText: {
    color: '#D1D5DB',
    fontSize: 13,
    fontWeight: '600',
  },
  removeBtn: {
    backgroundColor: '#EF4444',
    paddingVertical: 10,
    paddingHorizontal: 22,
  },
  removeBtnText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  selectAllBtn: {
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    paddingVertical: 10,
    paddingHorizontal: 18,
  },
  selectAllBtnInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  selectAllBtnText: {
    color: '#D1D5DB',
    fontSize: 13,
    fontWeight: '600',
  },
});
