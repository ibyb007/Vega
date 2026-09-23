import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useReducer,
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
import { getOrFetchMetadata, prefetchMetadata } from '../../lib/services/metadataCache';
import { formatEpisodeLabel } from '../../lib/utils/episodeParsing';
import { TVRoute } from '../../components/tv/TVNavigationRail';
import { registerRailLeftEdge } from '../../lib/tv/registerRailLeftEdge';

const ROW_HEIGHT = 235;
const imdbMetaCache = new Map<string, any>();

// ---------------------------------------------------------------------------
// Performance tuning knobs (see the notes on HomeRow / HomeCard below).
// ---------------------------------------------------------------------------
// Stable empty fallback. `data: homeData = []` handed back a *new* array on
// every render while a query had no data yet, which made every `useMemo`
// downstream of it recompute on every render.
const EMPTY_ROWS: any[] = [];
// Cards mounted per row up front. More are appended as focus nears the end
// of what is mounted, so a 40-poster row only pays for ~12 posters (views +
// decoded bitmaps) until the user actually scrolls into it.
const INITIAL_CARDS_PER_ROW = 12;
const CARDS_PAGE = 10;
const CARDS_LOOKAHEAD = 5;
// Same idea vertically: rows are mounted up to this many rows below the row
// that currently holds focus, and more are appended as focus moves down.
// Rows are never unmounted again, so scroll offsets / focus memory of rows
// already visited behave exactly as before.
const ROW_LOOKAHEAD = 3;
// Quick D-pad presses only update the hero once focus has rested for a
// moment; each hero change swaps up to three (blurred) full-screen images.
const HERO_APPLY_DELAY_MS = 80;
const PREFETCH_DELAY_MS = 300;
// The secondary source's fetch waits for the primary's to finish (so two
// sources never hammer the provider sandbox at once) but never longer than this.
const SECONDARY_FETCH_MAX_DELAY_MS = 4000;

let lastFocusedKey: string | null = null;
let lastFocusedRowIndex = 0;

const normalizeTitle = (t: string | undefined | null): string =>
  (t || '')
    .toLowerCase()
    .replace(/\(\d{4}\)/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

// A row's *identity* -- not its current array position. Continue Watching
// gaining its first-ever poster, or losing its last one, inserts/removes a
// whole row and shifts every later row's index; keying off index alone (the
// old behaviour) made every later row's wrapper -- and every card's focus
// key inside it -- change identity too, on every such shift. `sourceLabel`
// disambiguates the same catalog `filter`/`title` fetched from two
// different providers (primary vs. the secondary provider row).
const getRowId = (row: any): string =>
  `${row?.sourceLabel || (row?.isHistory ? 'continue-watching' : 'primary')}::${row?.filter || row?.title || 'row'}`;

// A card's *identity* -- the actual title/link, not its row+column
// position. Removing one poster (or all of them) from Continue Watching
// used to change every remaining poster's key too (since it embedded its
// own array index), so the item that still had real Android focus either
// vanished outright or silently swapped identity with its neighbour.
// Keying off the item's own id means a poster that's still on screen after
// a removal keeps the exact same key it always had, and only the poster
// that was actually deleted can ever stop matching `lastFocusedKey`.
const buildItemKey = (row: any, item: any, pIndex: number = 0): string => {
  const itemId = item?.infoUrl || item?.link || item?.id;
  return `${getRowId(row)}::${itemId || `idx-${pIndex}`}`;
};

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

const tagRowsWithProvider = (rows: any[], providerValue?: string) =>
  rows.map((row) => ({
    ...row,
    Posts: (row.Posts || []).map((post: any) => ({
      ...post,
      provider: post.provider || providerValue,
    })),
  }));

// ---------------------------------------------------------------------------
// Hero host
//
// The hero (backdrop + title/synopsis) used to live in TVHomeScreen's own
// state, so *every* D-pad move -> setActiveHero -> re-rendered the whole
// screen: every row, every card. With a second source active that is twice
// as many rows. The hero state now lives here instead and TVHomeScreen
// drives it imperatively, so a focus change only re-renders this component.
// ---------------------------------------------------------------------------
type HeroSetter = React.Dispatch<React.SetStateAction<TVHeroMedia | null>>;
interface HeroHostHandle {
  set: HeroSetter;
}

const HeroHost = React.memo(
  forwardRef<HeroHostHandle>((_props, ref) => {
    const [media, setMedia] = useState<TVHeroMedia | null>(null);
    useImperativeHandle(ref, () => ({ set: setMedia }), []);
    return <TVHeroMeta media={media} />;
  })
);

// ---------------------------------------------------------------------------
// HomeCard / HomeRow
//
// Both are memoised and receive only stable callbacks, so moving focus
// between posters no longer re-renders (or re-runs ref callbacks for) every
// poster on screen -- only the two posters whose own focus state changed.
// Everything focus-related (keys, hasTVPreferredFocus, the row-0 nextFocusUp
// pin, rail left-edge registration, refocus remount nonce) is the same logic
// as before, just evaluated per card instead of inline in one giant map().
// ---------------------------------------------------------------------------
interface HomeCardProps {
  item: any;
  itemKey: string;
  rowIndex: number;
  pIndex: number;
  isHistoryRow: boolean;
  // Non-null only for the card that is the current "refocus" target; bumping
  // it remounts the card so Android hands it real focus again.
  refocusNonce: number | null;
  onCardFocus: (
    rowIndex: number,
    item: any,
    itemKey: string,
    isHistory: boolean,
    pIndex: number,
  ) => void;
  onCardPress: (rowIndex: number, item: any, itemKey: string, isHistory: boolean) => void;
  onCardLongPress: (item: any, isHistory: boolean) => void;
  registerItemRef: (itemKey: string, el: View | null) => void;
  // Imperatively brings a card into view inside its row's horizontal
  // ScrollView. See the comment on HomeRow's own `scrollItemIntoView` for
  // why this can't just be left to Android's native focus-scroll.
  scrollItemIntoView: (node: View | null) => void;
}

const HomeCard = React.memo(function HomeCard({
  item,
  itemKey,
  rowIndex,
  pIndex,
  isHistoryRow,
  refocusNonce,
  onCardFocus,
  onCardPress,
  onCardLongPress,
  registerItemRef,
  scrollItemIntoView,
}: HomeCardProps) {
  const isFirstInRow = pIndex === 0;
  const isTopRow = rowIndex === 0;
  const nodeRef = useRef<View | null>(null);

  // Fresh launch/relaunch: Explicitly defaults to row 0, card 0 (1st Continue Watching poster if exists, else 1st provider card)
  const shouldFocus = lastFocusedKey ? lastFocusedKey === itemKey : isTopRow && isFirstInRow;

  const posterImage = item.poster || item.background || item.image;
  const progressPercent =
    item.duration && item.position
      ? Math.min(100, Math.round((item.position / item.duration) * 100))
      : 0;

  // Stable per card (only changes if the card's identity/position does), so
  // React no longer detaches/re-attaches it -- and re-fires its native
  // bridge calls -- on every render of the screen.
  const setRef = useCallback(
    (el: View | null) => {
      nodeRef.current = el;
      registerItemRef(itemKey, el);
      if (!el) return;
      // Register as soon as this row mounts, not just on focus --
      // registerRailLeftEdge's bridge call to the native rail is async
      // (posts to the UI thread), so relying on onFocus alone leaves a real
      // window where the user can press Left before that write lands.
      if (isFirstInRow) {
        registerRailLeftEdge('home', el);
      }
      // The topmost row has nothing above it, but Android's default
      // geometric focus search doesn't know that. Pointing `nextFocusUp`
      // at the card's own handle makes Up a no-op for row 0 without
      // touching Left/Right/Down, which are wired separately.
      if (isTopRow) {
        const selfHandle = findNodeHandle(el);
        if (selfHandle != null) {
          (el as any).setNativeProps?.({ nextFocusUp: selfHandle });
        }
      }
    },
    [registerItemRef, itemKey, isFirstInRow, isTopRow]
  );

  const handleFocus = useCallback(() => {
    onCardFocus(rowIndex, item, itemKey, isHistoryRow, pIndex);
    // Only the first card of a row sits at the screen's left edge --
    // re-register it every time it's focused so Left always reaches the
    // Home rail button, from whichever row the user is on.
    if (isFirstInRow) {
      registerRailLeftEdge('home', nodeRef.current);
    }
    // Same re-assertion as in setRef, in case this card was focused (e.g.
    // via the refocus remount path) before the ref callback's write landed.
    if (isTopRow) {
      const node = nodeRef.current as any;
      const selfHandle = node ? findNodeHandle(node) : null;
      if (selfHandle != null) {
        node.setNativeProps?.({ nextFocusUp: selfHandle });
      }
    }
    // Don't rely on Android's own "bring focused descendant on screen"
    // behaviour -- it only reliably fires for focus changes that happen
    // while the ScrollView it lives in was already laid out and settled.
    // Restoring focus straight to (say) the 9th card of a row -- e.g. the
    // whole Home screen remounting fresh after Back from Details, which
    // drops every row's native scroll position back to 0 -- lands the
    // request before/at the same time as layout, and the row is left
    // showing its first screenful while the "selected" card sits off to
    // the right, unscrolled-to. Doing it ourselves on every focus (not
    // just this remount case) makes it deterministic either way.
    scrollItemIntoView(nodeRef.current);
  }, [
    onCardFocus,
    rowIndex,
    item,
    itemKey,
    isHistoryRow,
    pIndex,
    isFirstInRow,
    isTopRow,
    scrollItemIntoView,
  ]);

  const handlePress = useCallback(
    () => onCardPress(rowIndex, item, itemKey, isHistoryRow),
    [onCardPress, rowIndex, item, itemKey, isHistoryRow]
  );

  const handleLongPress = useCallback(
    () => onCardLongPress(item, isHistoryRow),
    [onCardLongPress, item, isHistoryRow]
  );

  return (
    <TVFocusablePressable
      key={refocusNonce != null ? `${itemKey}-r${refocusNonce}` : itemKey}
      ref={setRef}
      hasTVPreferredFocus={shouldFocus}
      scaleFocused={1.05}
      focusedBorderColor="#FFFFFF"
      borderRadius={8}
      delayLongPress={350}
      onFocus={handleFocus}
      onPress={handlePress}
      onLongPress={handleLongPress}
      style={[styles.card, isHistoryRow && styles.cardCompact]}
    >
      {({ focused }) => (
        <View style={styles.cardInner}>
          <Image
            source={{
              uri: posterImage || 'https://placehold.jp/24/363636/ffffff/200x300.png?text=Vega',
            }}
            style={styles.cardPoster}
            resizeMode="cover"
            // Remote images are otherwise decoded at their full source
            // resolution on Android; posters are ~130x190dp, so have Fresco
            // downsample them to the view size. This is a large memory (and
            // GC-pause) saver once a second source doubles the poster count.
            resizeMethod="resize"
          />

          {isHistoryRow && progressPercent > 0 && (
            <View style={styles.historyMetaOverlay}>
              <Text style={styles.historyPercentText}>{progressPercent}%</Text>
              <View style={styles.progressBarTrack}>
                <View style={[styles.progressBarFill, { width: `${progressPercent}%` }]} />
              </View>
            </View>
          )}

          {focused && <View style={styles.focusBorderGlow} />}
        </View>
      )}
    </TVFocusablePressable>
  );
});

interface HomeRowProps {
  row: any;
  rowIndex: number;
  // Only set for the row that contains the refocus target (see the refocus
  // trigger in TVHomeScreen), so other rows aren't re-rendered by it.
  refocusKey: string | null;
  refocusNonce: number;
  onCardFocus: HomeCardProps['onCardFocus'];
  onCardPress: HomeCardProps['onCardPress'];
  onCardLongPress: HomeCardProps['onCardLongPress'];
  registerItemRef: HomeCardProps['registerItemRef'];
}

const HomeRow = React.memo(function HomeRow({
  row,
  rowIndex,
  refocusKey,
  refocusNonce,
  onCardFocus,
  onCardPress,
  onCardLongPress,
  registerItemRef,
}: HomeRowProps) {
  const rowPosts: any[] = row.Posts || [];
  const isHistoryRow = Boolean(row.isHistory);
  const rowId = getRowId(row);

  const [mountedCount, setMountedCount] = useState(INITIAL_CARDS_PER_ROW);
  const totalRef = useRef(rowPosts.length);
  totalRef.current = rowPosts.length;

  // Each row owns its own horizontal ScrollView, and its native scroll
  // offset is *not* part of React's tree -- it isn't restored just because
  // the card that had focus remounts and reclaims focus. Most of the time
  // that's invisible because Android's default focus-search also nudges
  // the ScrollView to reveal whatever just got focus, but that native
  // behaviour isn't dependable the moment this row's ScrollView is freshly
  // mounted (e.g. the whole Home screen remounting after Back from
  // Details -- see App.tsx, which unmounts Home outright while Details is
  // open). So every card scrolls itself into view explicitly on focus
  // instead of hoping the OS does it.
  const scrollViewRef = useRef<ScrollView>(null);
  const scrollItemIntoView = useCallback((node: View | null) => {
    const scrollView = scrollViewRef.current;
    if (!node || !scrollView) return;
    const scrollHandle = findNodeHandle(scrollView);
    if (!scrollHandle) return;
    // measureLayout gives the card's position relative to the ScrollView's
    // own content, which is exactly what scrollTo's `x` needs -- no manual
    // width/gap math, and it stays correct however the row is styled.
    (node as any).measureLayout?.(
      scrollHandle,
      (x: number) => {
        // A little left padding so the target card doesn't land flush
        // against the row's edge.
        const targetX = Math.max(0, x - 24);
        scrollView.scrollTo({ x: targetX, y: 0, animated: false });
      },
      () => {}
    );
  }, []);

  // Whatever card holds (or last held) focus in this row must always be
  // mounted -- e.g. coming back from Details to a poster that is well past
  // the first screenful, or a refetch that reorders the row.
  let focusedIdx = -1;
  if (lastFocusedKey && lastFocusedKey.startsWith(`${rowId}::`)) {
    for (let i = 0; i < rowPosts.length; i++) {
      if (buildItemKey(row, rowPosts[i], i) === lastFocusedKey) {
        focusedIdx = i;
        break;
      }
    }
  }
  const renderCount = Math.min(
    rowPosts.length,
    Math.max(mountedCount, focusedIdx >= 0 ? focusedIdx + CARDS_PAGE : 0)
  );

  const handleCardFocus = useCallback<HomeCardProps['onCardFocus']>(
    (rIdx, item, itemKey, isHistory, pIndex) => {
      onCardFocus(rIdx, item, itemKey, isHistory, pIndex);
      // Mount the next page of posters before focus can run off the end.
      setMountedCount((c) =>
        c < totalRef.current && pIndex >= c - CARDS_LOOKAHEAD ? c + CARDS_PAGE : c
      );
    },
    [onCardFocus]
  );

  return (
    <View style={styles.rowContainer}>
      <View style={styles.rowTitleWrap}>
        <Text style={styles.rowCategoryTitle}>{row.title}</Text>
        {row.sourceLabel ? (
          <Text style={styles.rowSourceLabel} numberOfLines={1}>
            {row.sourceLabel}
          </Text>
        ) : null}
      </View>

      <ScrollView
        ref={scrollViewRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.horizontalRowScroll}
        removeClippedSubviews={false}
      >
        {rowPosts.slice(0, renderCount).map((item: any, pIndex: number) => {
          const itemKey = buildItemKey(row, item, pIndex);
          return (
            <HomeCard
              key={itemKey}
              item={item}
              itemKey={itemKey}
              rowIndex={rowIndex}
              pIndex={pIndex}
              isHistoryRow={isHistoryRow}
              refocusNonce={refocusKey === itemKey ? refocusNonce : null}
              onCardFocus={handleCardFocus}
              onCardPress={onCardPress}
              onCardLongPress={onCardLongPress}
              registerItemRef={registerItemRef}
              scrollItemIntoView={scrollItemIntoView}
            />
          );
        })}
      </ScrollView>
    </View>
  );
});

interface TVHomeScreenProps {
  onSelectItem: (item: any) => void;
  onResumeItem?: (item: any) => void;
  onOpenDiscoverItem?: (
    item: any,
    resumeHint?: {
      providerValue?: string;
      infoUrl?: string;
      episodeKey?: string;
      episodeLink?: string;
      position?: number;
    },
  ) => void;
  onNavigateRoute?: (route: TVRoute) => void;
  onRegisterBackHandler?: (handler: (() => boolean) | null) => void;
  onRegisterEntryHandleGetter?: (getter: (() => number | null) | null) => void;
  onRegisterReturnFocusTrigger?: (trigger: (() => void) | null) => void;
  resetFocusOnMount?: boolean;
}

export const TVHomeScreen: React.FC<TVHomeScreenProps> = ({
  onSelectItem,
  onResumeItem,
  onOpenDiscoverItem,
  onNavigateRoute,
  onRegisterBackHandler,
  onRegisterEntryHandleGetter,
  onRegisterReturnFocusTrigger,
  resetFocusOnMount,
}) => {
  // When the user actually leaves the Home tab for a different rail tab and
  // comes back (a real tab switch, as opposed to opening details/player and
  // returning), App.tsx passes `resetFocusOnMount=true` for this one mount.
  // Forget whatever was last focused so this mount behaves exactly like a
  // fresh app launch: focus lands on the 1st Continue Watching poster if one
  // exists, otherwise the 1st poster of the 1st row. Guarded by a ref so it
  // only runs once per mount and never disturbs normal in-tab resume
  // behaviour (e.g. going to details and back) on later re-renders.
  const resetFocusConsumedRef = useRef(false);
  if (resetFocusOnMount && !resetFocusConsumedRef.current) {
    resetFocusConsumedRef.current = true;
    lastFocusedKey = null;
    lastFocusedRowIndex = 0;
  }

  const provider = useContentStore((state) => state.provider);
  const secondaryProvider = useContentStore((state) => state.secondaryProvider);
  const installedProviders = useContentStore((state) => state.installedProviders);
  const continueWatchingItems = useContinueWatchingStore((state) => state.items) || EMPTY_ROWS;
  const removeItemFromHistory = useContinueWatchingStore((state) => state.removeItem);
  const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = useWindowDimensions();

  const [itemToDelete, setItemToDelete] = useState<any | null>(null);
  const [confirmingRemoveAll, setConfirmingRemoveAll] = useState(false);
  // How many rows are mounted (see ROW_LOOKAHEAD). Starts just far enough
  // below wherever focus will be restored to.
  const [visibleRowCount, setVisibleRowCount] = useState<number>(
    () => lastFocusedRowIndex + ROW_LOOKAHEAD + 1
  );

  const translateY = useSharedValue(-lastFocusedRowIndex * ROW_HEIGHT);

  const heroHostRef = useRef<HeroHostHandle>(null);
  const heroInitializedRef = useRef(false);
  const heroRequestIdRef = useRef(0);
  const heroApplyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heroEnrichTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The screen's callbacks come from App.tsx as fresh inline arrows on every
  // App render; read them through a ref so the memoised cards below never
  // see a changed handler because of that.
  const propsRef = useRef({ onSelectItem, onOpenDiscoverItem });
  propsRef.current = { onSelectItem, onOpenDiscoverItem };

  const hasProviders = Boolean(
    installedProviders && installedProviders.length > 0 && provider?.value
  );
  const hasSecondaryProvider = Boolean(
    secondaryProvider?.value &&
      secondaryProvider.value !== provider?.value &&
      installedProviders?.some((p) => p.value === secondaryProvider.value)
  );

  const primaryQuery = useHomePageData({
    provider,
    enabled: hasProviders,
  });
  const homeData: any[] = primaryQuery.data ?? EMPTY_ROWS;
  const isLoading = primaryQuery.isLoading;

  // Let the primary source finish its (re)fetch before the secondary one
  // starts its own; both go through the same single provider-sandbox
  // WebView, and hitting it with two full home-page fetches at once is what
  // froze input. Cached rows for the secondary source still show instantly.
  const [secondaryDelayElapsed, setSecondaryDelayElapsed] = useState(false);
  useEffect(() => {
    if (!hasSecondaryProvider) return;
    const timer = setTimeout(() => setSecondaryDelayElapsed(true), SECONDARY_FETCH_MAX_DELAY_MS);
    return () => clearTimeout(timer);
  }, [hasSecondaryProvider]);

  const secondaryQuery = useHomePageData({
    provider: secondaryProvider || provider,
    enabled: hasSecondaryProvider && (!primaryQuery.isFetching || secondaryDelayElapsed),
  });
  const secondaryHomeData: any[] = secondaryQuery.data ?? EMPTY_ROWS;

  // Hardware remote BACK: only handle this screen's own back-stack (the
  // remove/confirm dialog). If there's nothing local to close, report
  // "not handled" so App.tsx moves focus to the Home button on the rail.
  useEffect(() => {
    const handleBack = () => {
      if (itemToDelete) {
        setItemToDelete(null);
        setConfirmingRemoveAll(false);
        return true;
      }
      return false;
    };

    onRegisterBackHandler?.(handleBack);
    return () => onRegisterBackHandler?.(null);
  }, [itemToDelete, onRegisterBackHandler]);

  const watchHistory = useMemo(() => {
    return [...continueWatchingItems]
      .filter((item) => Boolean(item.providerValue || item.infoUrl))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }, [continueWatchingItems]);

  // Each source's rows are built in their own memo so a change to one of
  // them (Continue Watching updating, the secondary source finishing its
  // refetch) doesn't rebuild -- and hand new object identities to -- the
  // others. That is what lets the memoised rows below skip re-rendering.
  const historyRow = useMemo(
    () =>
      watchHistory.length > 0
        ? {
            title: 'Continue Watching',
            filter: 'continue-watching',
            Posts: watchHistory,
            isHistory: true,
          }
        : null,
    [watchHistory]
  );

  const primaryRows = useMemo(
    () =>
      tagRowsWithProvider(
        homeData.filter((r) => r.Posts && r.Posts.length > 0),
        provider?.value
      ),
    [homeData, provider?.value]
  );

  const secondaryProviderValue = secondaryProvider?.value;
  const secondaryProviderName = secondaryProvider?.display_name;
  const secondaryRows = useMemo(() => {
    if (!hasSecondaryProvider) return EMPTY_ROWS;
    return tagRowsWithProvider(
      secondaryHomeData.filter((r) => r.Posts && r.Posts.length > 0),
      secondaryProviderValue
    ).map((row) => ({
      ...row,
      sourceLabel: secondaryProviderName,
    }));
  }, [hasSecondaryProvider, secondaryHomeData, secondaryProviderValue, secondaryProviderName]);

  const displayRows = useMemo(() => {
    const rows: any[] = [];
    if (historyRow) rows.push(historyRow);
    rows.push(...primaryRows);
    rows.push(...secondaryRows);
    return rows;
  }, [historyRow, primaryRows, secondaryRows]);

  const updateHeroWithBestMetadata = useCallback(
    (item: any, isHistory: boolean = false, immediate: boolean = false) => {
      const requestId = ++heroRequestIdRef.current;
      if (heroApplyTimerRef.current) {
        clearTimeout(heroApplyTimerRef.current);
        heroApplyTimerRef.current = null;
      }
      if (heroEnrichTimerRef.current) {
        clearTimeout(heroEnrichTimerRef.current);
        heroEnrichTimerRef.current = null;
      }

      const posterImage = item.poster || item.background || item.image;
      const targetUrl = item.infoUrl || item.link;
      const targetProvider = item.providerValue || item.provider || provider?.value;

      // For Continue Watching entries resumed via the Discover screen's
      // results inspector, the real 16:9 image lives on the attached
      // `discoverSource` catalog item's own `banner` field (see
      // CatalogMediaItem) -- not on the history entry's top-level
      // background/backdrop fields, which are only ever populated for
      // entries that went through Home's own Cinemeta enrichment. Without
      // this fallback those entries always looked like they had no
      // backdrop at all, even though one was sitting right there.
      const sourceBackdrop =
        item.background || item.backdrop || item.banner || item.discoverSource?.banner || null;
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
      // "S01E02-Trust Fall" style second header line -- only meaningful
      // for a series entry (episodeTitle unset for movies), using the
      // real season/episode numbers carried on the stored episode when
      // available.
      const episodeLabel = episodeTitle
        ? formatEpisodeLabel(item.episode?.season, item.episode?.episodeNumber, episodeTitle)
        : undefined;
      // Don't show a generic "select title to browse..." placeholder before
      // the real synopsis has been fetched -- leave it blank instead and let
      // the enrichment below fill it in once actual metadata arrives.
      const baseOverview = isHistory
        ? `Resume watching (${progressPercent}%)`
        : item.extra || item.description || undefined;

      const baseHero: TVHeroMedia = {
        title: item.title,
        subtitle: isHistory ? episodeLabel : undefined,
        backdropUrl: sourceBackdrop || posterImage || undefined,
        posterUrl: posterImage,
        overview: baseOverview,
        year: item.year ? String(item.year) : undefined,
        rating: item.rating ? String(item.rating) : undefined,
        runtime: item.runtime || undefined,
        genres: item.genres?.length ? item.genres : undefined,
        hasLandscapeBackdrop: hasSourceBackdrop,
        isPosterFallback: !hasSourceBackdrop,
      };

      const applyBaseHero = () => {
        heroApplyTimerRef.current = null;
        if (requestId !== heroRequestIdRef.current) return;
        heroHostRef.current?.set(baseHero);
      };

      if (immediate) {
        applyBaseHero();
      } else {
        heroApplyTimerRef.current = setTimeout(applyBaseHero, HERO_APPLY_DELAY_MS);
      }

      if (hasSourceBackdrop || !targetUrl || !targetProvider) return;

      heroEnrichTimerRef.current = setTimeout(async () => {
        if (requestId !== heroRequestIdRef.current) return;

        let backdrop: string | null = null;
        let description = '';
        let rating: string | null = null;
        let year: string | null = null;
        let genres: string[] = [];
        let cast: string[] = [];

        try {
          const info = await getOrFetchMetadata(targetUrl, targetProvider);
          if (requestId !== heroRequestIdRef.current) return;

          if (info) {
            if (info.synopsis) description = info.synopsis;
            if (info.rating) rating = String(info.rating);

            if (info.populateMeta === true && info.imdbId && info.type) {
              const cineMeta = await fetchCinemetaByImdb(info.imdbId, info.type);
              if (requestId !== heroRequestIdRef.current) return;

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
                // Same "Cast: Name1, Name2, Name3" data the Discover
                // screen's pages already pull from Cinemeta, now surfaced
                // under the Home hero's synopsis too.
                if (cineMeta.cast?.length && titleMatches) cast = cineMeta.cast.slice(0, 3);
              }
            }
          }
        } catch {}

        if (requestId !== heroRequestIdRef.current) return;
        if (!backdrop && !description && !rating && !year && genres.length === 0 && cast.length === 0) return;

        heroHostRef.current?.set((prev) =>
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
                cast: cast.length > 0 ? cast : prev.cast,
              }
            : prev
        );
      }, 250);
    },
    [provider?.value]
  );

  useEffect(() => {
    // The hero host only exists once the real screen (not the loading /
    // no-provider fallback) is on screen; wait for it before seeding.
    if (heroInitializedRef.current || !heroHostRef.current) return;
    if (displayRows.length > 0) {
      const firstRow = displayRows[0];
      if (firstRow?.Posts?.length > 0) {
        heroInitializedRef.current = true;
        updateHeroWithBestMetadata(firstRow.Posts[0], Boolean(firstRow.isHistory), true);
      }
    }
  }, [displayRows, updateHeroWithBestMetadata, hasProviders, isLoading]);

  useEffect(() => {
    return () => {
      heroRequestIdRef.current += 1;
      if (heroApplyTimerRef.current) {
        clearTimeout(heroApplyTimerRef.current);
        heroApplyTimerRef.current = null;
      }
      if (heroEnrichTimerRef.current) {
        clearTimeout(heroEnrichTimerRef.current);
        heroEnrichTimerRef.current = null;
      }
      if (prefetchTimerRef.current) {
        clearTimeout(prefetchTimerRef.current);
        prefetchTimerRef.current = null;
      }
    };
  }, []);

  const focusedHistoryItemRef = useRef<any>(null);
  const selectHoldStreakRef = useRef(0);
  const selectHoldTriggeredRef = useRef(false);
  const lastSelectKeyTimeRef = useRef(0);
  const itemRefsRef = useRef<Record<string, View | null>>({});

  const registerItemRef = useCallback((itemKey: string, el: View | null) => {
    itemRefsRef.current[itemKey] = el;
  }, []);

  useEffect(() => {
    onRegisterEntryHandleGetter?.(() => {
      const node = lastFocusedKey ? itemRefsRef.current[lastFocusedKey] : null;
      return node ? findNodeHandle(node) : null;
    });
    return () => onRegisterEntryHandleGetter?.(null);
  }, [onRegisterEntryHandleGetter]);

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

      // Mount more rows below before focus can reach the last mounted one.
      // Bails out (no re-render) unless focus actually moved near the end.
      setVisibleRowCount((count) =>
        rowIndex + ROW_LOOKAHEAD + 1 > count ? rowIndex + ROW_LOOKAHEAD + 1 : count
      );

      focusedHistoryItemRef.current = isHistory ? item : null;
      selectHoldStreakRef.current = 0;
      selectHoldTriggeredRef.current = false;

      translateY.value = withTiming(-rowIndex * ROW_HEIGHT, {
        duration: 160,
        easing: Easing.out(Easing.quad),
      });

      updateHeroWithBestMetadata(item, isHistory);

      // Warm the details cache only once focus has settled -- firing a
      // provider sandbox call for every poster a held D-pad key sweeps
      // across is pure overhead.
      if (prefetchTimerRef.current) {
        clearTimeout(prefetchTimerRef.current);
        prefetchTimerRef.current = null;
      }
      const targetUrl = item.infoUrl || item.link;
      const targetProvider = item.providerValue || item.provider || provider?.value;
      if (targetUrl && targetProvider) {
        prefetchTimerRef.current = setTimeout(() => {
          prefetchTimerRef.current = null;
          prefetchMetadata(targetUrl, targetProvider);
        }, PREFETCH_DELAY_MS);
      }
    },
    [translateY, updateHeroWithBestMetadata, provider?.value]
  );

  const handleCardPress = useCallback(
    (rowIndex: number, item: any, itemKey: string, isHistoryRow: boolean) => {
      lastFocusedKey = itemKey;
      lastFocusedRowIndex = rowIndex;

      if (selectHoldTriggeredRef.current) {
        selectHoldTriggeredRef.current = false;
        return;
      }

      const { onSelectItem: selectItem, onOpenDiscoverItem: openDiscoverItem } = propsRef.current;
      const posterImage = item.poster || item.background || item.image;

      if (isHistoryRow) {
        if (item.discoverSource && openDiscoverItem) {
          // Thread the resume position/episode identity
          // along with the discoverSource payload so the
          // Discover results view can land on the same
          // source/episode and actually resume playback
          // instead of opening a blank results browser.
          openDiscoverItem(item.discoverSource, {
            providerValue: item.providerValue,
            infoUrl: item.infoUrl,
            episodeKey: item.episodeKey,
            episodeLink: item.episode?.link,
            position: item.position,
          });
          return;
        }
        selectItem({
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
        selectItem(item);
      }
    },
    []
  );

  const handleCardLongPress = useCallback((item: any, isHistoryRow: boolean) => {
    if (isHistoryRow) {
      setConfirmingRemoveAll(false);
      setItemToDelete(item);
    }
  }, []);

  // Continue Watching can change shape while Home is already mounted and
  // focused: gaining its first-ever poster shifts every later row down by
  // one, and removing a poster -- or the whole row via "Remove"/"Remove
  // All" -- can delete the exact card that currently holds real Android
  // focus. Once that happens Android has no focused view left to search
  // from, so D-pad navigation goes dead until the tab is left and
  // re-entered. Whenever the visible rows change, check whether whatever
  // was last focused still actually exists among them; if not, re-target
  // focus at the first poster of the new first row (Continue Watching's
  // first poster if it still exists, otherwise the first row's first
  // poster -- the same "relaunch" default a fresh mount uses) and force a
  // real focus() via the same remount-nonce trick the nav rail's return
  // trigger uses.
  useEffect(() => {
    if (!lastFocusedKey) return;

    const stillExists = displayRows.some((row: any) =>
      (row.Posts || []).some((item: any, pIndex: number) => buildItemKey(row, item, pIndex) === lastFocusedKey)
    );
    if (stillExists) return;

    const fallbackRow = displayRows[0];
    const fallbackItem = fallbackRow?.Posts?.[0];
    if (!fallbackItem) return;

    const fallbackKey = buildItemKey(fallbackRow, fallbackItem, 0);
    lastFocusedKey = fallbackKey;
    lastFocusedRowIndex = 0;
    translateY.value = withTiming(0, { duration: 160, easing: Easing.out(Easing.quad) });
    refocusRef.current = { key: fallbackKey, nonce: refocusRef.current.nonce + 1 };
    forceRerenderForRefocus();
  }, [displayRows, translateY]);

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
    return (
      <View style={styles.centerLoading}>
        <ActivityIndicator size="large" color="#8A5CF6" />
        <Text style={styles.loadingText}>
          Loading {provider?.displayTitle || provider?.name} catalog...
        </Text>
      </View>
    );
  }

  const refocusKey = refocusRef.current.key;
  const refocusNonce = refocusRef.current.nonce;
  const renderedRows =
    displayRows.length > visibleRowCount ? displayRows.slice(0, visibleRowCount) : displayRows;

  return (
    <View style={styles.container}>
      <View style={[styles.fixedHeroContainer, { width: SCREEN_WIDTH, height: SCREEN_HEIGHT }]}>
        <HeroHost ref={heroHostRef} />
      </View>

      <View style={styles.stageViewport}>
        <Animated.View style={[styles.slidingRowsContainer, animatedRowsStyle]}>
          {renderedRows.map((row: any, rowIndex: number) => {
            if (!row.Posts || row.Posts.length === 0) return null;
            const rowId = getRowId(row);
            const rowRefocusKey =
              refocusKey && refocusKey.startsWith(`${rowId}::`) ? refocusKey : null;

            return (
              <HomeRow
                key={rowId}
                row={row}
                rowIndex={rowIndex}
                refocusKey={rowRefocusKey}
                refocusNonce={rowRefocusKey ? refocusNonce : 0}
                onCardFocus={handleCardFocus}
                onCardPress={handleCardPress}
                onCardLongPress={handleCardLongPress}
                registerItemRef={registerItemRef}
              />
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
                scaleFocused={1.04}
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
                  scaleFocused={1.04}
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
                    scaleFocused={1.04}
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
                    scaleFocused={1.04}
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
    // Trimmed from 84 -- the shared viewport wrapper in App.tsx already
    // reserves the rail's collapsed width (72dp) via paddingLeft, so this
    // only needs to be a small breathing margin on top of that, not a
    // near-duplicate of the rail's own width.
    paddingLeft: 20,
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
    borderRadius: 8,
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
    borderRadius: 8,
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
    borderRadius: 8,
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

export default TVHomeScreen;
