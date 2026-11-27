import React, {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Image, ScrollView, StyleSheet, Text, View } from 'react-native';

/**
 * One titled, horizontally scrolling row of posters for TVDiscoverScreen.
 *
 * Cards inside this row are purely presentational (not natively focusable):
 * TVDiscoverScreen holds native Android focus on a single stable host Pressable
 * and drives selection via `PosterCursorStore` + `DeviceEventEmitter('onKeyDown')`
 * (the same cursor architecture used by TVDetailsScreen, TVSettingsScreen, and
 * Extensions). Keeping native focus on one host prevents Android's focus
 * engine from dropping focus or jumping to the nav rail while a D-pad key is
 * held across scrolling cards.
 */

export const POSTER_ROW_HEIGHT = 235;
export const POSTER_CARD_WIDTH = 132;
export const POSTER_CARD_HEIGHT = 198;
const POSTER_RADIUS = 12;
const CARD_GAP = 14;
const ROW_PADDING_LEFT = 12;
const CARD_STEP = POSTER_CARD_WIDTH + CARD_GAP;

const INITIAL_CARDS = 12;
const CARDS_LOOKAHEAD = 8;
// Within this many posters of the end of what is loaded, ask for the next page.
const LOAD_MORE_LOOKAHEAD = 10;
const SCROLL_SETTLE_MS = 2500;
const SKELETON_COUNT = 8;
// Once cursor has rested on a poster for this long, the next few posters'
// images are warmed into the disk cache so they appear instantly as the row
// scrolls.
const PREFETCH_SETTLE_MS = 150;
const PREFETCH_AHEAD = 8;
const prefetchedPosters = new Set<string>();

export const posterItemKey = (rowKey: string, index: number, id: string) =>
  `${rowKey}@@${index}@@${id}`;

export interface PosterCursorStore {
  readonly key: string | null;
  readonly focused: boolean;
  setKey(key: string | null): void;
  setFocused(focused: boolean): void;
  isSelected(key: string): boolean;
  subscribeKey(key: string, listener: () => void): () => void;
}

/**
 * External store tracking which poster key currently holds the JS cursor and
 * whether the browse stage holds native focus. Indexed per poster key so moving
 * the cursor only re-renders the two affected cards.
 */
export const createPosterCursorStore = (initialKey: string | null): PosterCursorStore => {
  let key = initialKey;
  let focused = false;
  const keyListeners = new Map<string, Set<() => void>>();

  const notifyKey = (targetKey: string | null) => {
    if (!targetKey) return;
    keyListeners.get(targetKey)?.forEach((l) => l());
  };

  return {
    get key() {
      return key;
    },
    get focused() {
      return focused;
    },
    setKey(next) {
      if (next === key) return;
      const prev = key;
      key = next;
      notifyKey(prev);
      notifyKey(next);
    },
    setFocused(next) {
      if (next === focused) return;
      focused = next;
      notifyKey(key);
    },
    isSelected: (k) => focused && key === k,
    subscribeKey(targetKey, listener) {
      let set = keyListeners.get(targetKey);
      if (!set) {
        set = new Set();
        keyListeners.set(targetKey, set);
      }
      set.add(listener);
      return () => {
        set!.delete(listener);
        if (set!.size === 0) keyListeners.delete(targetKey);
      };
    },
  };
};

export interface TVPosterRowHandle {
  selectCol: (col: number) => void;
  getVisualX: (col: number) => number;
  findColNearVisualX: (visualX: number, itemCount: number) => number;
}

interface CardProps {
  item: any;
  itemKey: string;
  pIndex: number;
  cursor: PosterCursorStore;
  onCardLayout: (pIndex: number, x: number) => void;
}

const PosterCard = memo(function PosterCard({
  item,
  itemKey,
  pIndex,
  cursor,
  onCardLayout,
}: CardProps) {
  const subscribe = useCallback(
    (listener: () => void) => cursor.subscribeKey(itemKey, listener),
    [cursor, itemKey]
  );
  const getSnapshot = useCallback(() => cursor.isSelected(itemKey), [cursor, itemKey]);
  const selected = useSyncExternalStore(subscribe, getSnapshot);

  const handleLayout = useCallback(
    (e: { nativeEvent: { layout: { x: number } } }) =>
      onCardLayout(pIndex, e.nativeEvent.layout.x),
    [onCardLayout, pIndex]
  );

  return (
    <View
      collapsable={false}
      onLayout={handleLayout}
      style={[styles.card, styles.cardBase, selected && styles.cardFocused]}
    >
      <View style={styles.cardInner}>
        <Image
          source={{
            uri: item.poster || 'https://placehold.jp/24/363636/ffffff/200x300.png?text=Vega',
          }}
          style={styles.cardPoster}
          resizeMode="cover"
          resizeMethod="resize"
        />
      </View>
    </View>
  );
});

export interface TVPosterRowProps {
  rowKey: string;
  title: string;
  sourceLabel?: string;
  items: any[];
  loading: boolean;
  cursor: PosterCursorStore;
  initialCol?: number;
  onNeedMore: (rowKey: string) => void;
  registerRowHandle: (rowKey: string, handle: TVPosterRowHandle | null) => void;
}

export const TVPosterRow = memo(function TVPosterRow({
  rowKey,
  title,
  sourceLabel,
  items,
  loading,
  cursor,
  initialCol = 0,
  onNeedMore,
  registerRowHandle,
}: TVPosterRowProps) {
  const [mountedCount, setMountedCount] = useState(() =>
    Math.max(INITIAL_CARDS, initialCol > 0 ? initialCol + CARDS_LOOKAHEAD + 1 : 0)
  );
  const totalRef = useRef(items.length);
  totalRef.current = items.length;

  const itemsRef = useRef(items);
  itemsRef.current = items;

  // --- scrolling the selected poster into view ----------------------------
  const scrollViewRef = useRef<ScrollView>(null);
  const cardXRef = useRef<Record<number, number>>({});
  const scrollXRef = useRef(0);
  const viewportWidthRef = useRef(0);
  const contentWidthRef = useRef(0);
  const scrollTargetColRef = useRef<number | null>(initialCol > 0 ? initialCol : null);
  const scrollPendingUntilRef = useRef(initialCol > 0 ? Date.now() + SCROLL_SETTLE_MS : 0);

  const cardXForCol = (col: number): number =>
    cardXRef.current[col] ?? ROW_PADDING_LEFT + col * CARD_STEP;

  const applyPendingScroll = useCallback(() => {
    if (Date.now() > scrollPendingUntilRef.current) return;
    const col = scrollTargetColRef.current;
    const sv = scrollViewRef.current;
    if (col == null || !sv) return;
    const x = cardXRef.current[col];
    if (x == null) return;
    let targetX = Math.max(0, x - 36);
    if (viewportWidthRef.current > 0 && contentWidthRef.current > 0) {
      targetX = Math.min(targetX, Math.max(0, contentWidthRef.current - viewportWidthRef.current));
    }
    scrollXRef.current = targetX;
    sv.scrollTo({ x: targetX, y: 0, animated: false });
  }, []);

  const scrollColIntoView = useCallback(
    (col: number) => {
      scrollTargetColRef.current = col;
      scrollPendingUntilRef.current = Date.now() + SCROLL_SETTLE_MS;
      applyPendingScroll();
    },
    [applyPendingScroll]
  );

  const handleCardLayout = useCallback(
    (pIndex: number, x: number) => {
      cardXRef.current[pIndex] = x;
      if (scrollTargetColRef.current === pIndex) applyPendingScroll();
    },
    [applyPendingScroll]
  );

  useEffect(() => {
    if (initialCol <= 0) return;
    const timers = [60, 200, 450, 900].map((ms) => setTimeout(applyPendingScroll, ms));
    return () => timers.forEach(clearTimeout);
  }, [applyPendingScroll, initialCol]);

  // --- image prefetch -----------------------------------------------------
  const prefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (prefetchTimerRef.current) clearTimeout(prefetchTimerRef.current);
    },
    []
  );
  const schedulePrefetch = useCallback((fromIndex: number) => {
    if (prefetchTimerRef.current) clearTimeout(prefetchTimerRef.current);
    prefetchTimerRef.current = setTimeout(() => {
      prefetchTimerRef.current = null;
      const list = itemsRef.current;
      const end = Math.min(list.length, fromIndex + 1 + PREFETCH_AHEAD);
      for (let i = fromIndex + 1; i < end; i++) {
        const uri = list[i]?.poster;
        if (!uri || prefetchedPosters.has(uri)) continue;
        prefetchedPosters.add(uri);
        Image.prefetch(uri).catch(() => prefetchedPosters.delete(uri));
      }
    }, PREFETCH_SETTLE_MS);
  }, []);

  // --- imperative handle for TVDiscoverScreen's cursor --------------------
  const handleRef = useRef<TVPosterRowHandle>(null);
  useImperativeHandle(
    handleRef,
    () => ({
      selectCol(col: number) {
        schedulePrefetch(col);
        setMountedCount((c) => {
          if (c >= totalRef.current || col < c - CARDS_LOOKAHEAD) return c;
          return Math.min(totalRef.current, col + CARDS_LOOKAHEAD + 1);
        });
        if (col >= totalRef.current - LOAD_MORE_LOOKAHEAD) onNeedMore(rowKey);
        scrollColIntoView(col);
      },
      getVisualX(col: number) {
        return cardXForCol(col) - scrollXRef.current;
      },
      findColNearVisualX(visualX: number, itemCount: number) {
        if (itemCount <= 0) return 0;
        let bestCol = 0;
        let bestDist = Infinity;
        // Search mounted cards (or at least visible range); unmounted cards
        // sit well off-screen to the right anyway.
        const limit = Math.min(itemCount, Math.max(INITIAL_CARDS, mountedCount));
        for (let c = 0; c < limit; c++) {
          const vx = cardXForCol(c) - scrollXRef.current;
          const dist = Math.abs(vx - visualX);
          if (dist < bestDist) {
            bestDist = dist;
            bestCol = c;
          }
        }
        return bestCol;
      },
    }),
    [mountedCount, onNeedMore, rowKey, schedulePrefetch, scrollColIntoView]
  );

  useEffect(() => {
    registerRowHandle(rowKey, handleRef.current);
    return () => registerRowHandle(rowKey, null);
  }, [registerRowHandle, rowKey]);

  const renderCount = Math.min(items.length, mountedCount);

  return (
    <View style={styles.rowContainer}>
      <View style={styles.rowTitleWrap}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {title}
        </Text>
        {sourceLabel ? (
          <Text style={styles.rowSourceLabel} numberOfLines={1}>
            {sourceLabel}
          </Text>
        ) : null}
      </View>

      <ScrollView
        ref={scrollViewRef}
        horizontal
        scrollEnabled={false}
        scrollsToTop={false}
        showsHorizontalScrollIndicator={false}
        style={styles.rowScroll}
        contentContainerStyle={styles.rowContent}
        removeClippedSubviews={false}
        onScroll={(e) => {
          scrollXRef.current = e.nativeEvent.contentOffset.x;
        }}
        scrollEventThrottle={16}
        onContentSizeChange={(w) => {
          contentWidthRef.current = w;
          applyPendingScroll();
        }}
        onLayout={(e) => {
          viewportWidthRef.current = e.nativeEvent.layout.width;
          applyPendingScroll();
        }}
      >
        {items.length === 0 && loading
          ? Array.from({ length: SKELETON_COUNT }).map((_, i) => (
              <View key={`sk-${i}`} style={[styles.card, styles.skeleton]} />
            ))
          : items.slice(0, renderCount).map((item, pIndex) => {
              const itemKey = posterItemKey(rowKey, pIndex, String(item?.id ?? pIndex));
              return (
                <PosterCard
                  key={itemKey}
                  item={item}
                  itemKey={itemKey}
                  pIndex={pIndex}
                  cursor={cursor}
                  onCardLayout={handleCardLayout}
                />
              );
            })}
      </ScrollView>
    </View>
  );
});

const styles = StyleSheet.create({
  rowContainer: {
    height: POSTER_ROW_HEIGHT,
  },
  rowTitleWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  rowTitle: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '800',
    letterSpacing: 0.2,
    flexShrink: 1,
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
  // The selected poster is scaled up and has a ring; both overflow the
  // poster's box and a ScrollView clips to its bounds. Grow the scroll area
  // with the padding below and pull it back with equal negative margins so
  // posters sit exactly where they would without it.
  rowScroll: {
    marginLeft: -12,
    marginTop: -10,
    marginBottom: -10,
    flexGrow: 0,
  },
  rowContent: {
    paddingLeft: ROW_PADDING_LEFT,
    paddingRight: 60,
    gap: CARD_GAP,
    paddingVertical: 10,
  },
  card: {
    width: POSTER_CARD_WIDTH,
    height: POSTER_CARD_HEIGHT,
    backgroundColor: '#16161E',
    borderRadius: POSTER_RADIUS,
  },
  cardBase: {
    borderRadius: POSTER_RADIUS,
    borderWidth: 3,
    borderColor: 'transparent',
  },
  cardFocused: {
    borderColor: '#FFFFFF',
    transform: [{ scale: 1.05 }],
    zIndex: 99,
  },
  skeleton: {
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
  },
  cardInner: {
    flex: 1,
    borderRadius: POSTER_RADIUS - 3,
    overflow: 'hidden',
  },
  cardPoster: {
    width: '100%',
    height: '100%',
    borderRadius: POSTER_RADIUS - 3,
  },
});
