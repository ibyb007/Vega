import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Image, ScrollView, StyleSheet, Text, View, findNodeHandle } from 'react-native';
import { TVFocusablePressable } from './TVFocusablePressable';
import { registerRailLeftEdge } from '../../lib/tv/registerRailLeftEdge';

/**
 * One titled, horizontally scrolling row of posters -- the Discover screen's
 * counterpart of TVHomeScreen's HomeRow, with the same behaviour:
 *  - posters are mounted a page at a time, ahead of focus;
 *  - every poster has an explicit Left/Right link to its neighbours (the last
 *    one points at itself) so a held D-pad key can never leave the row;
 *  - the focused poster scrolls itself into view;
 *  - the focus ring has room to draw (see styles.rowScroll).
 */

export const POSTER_ROW_HEIGHT = 235;
export const POSTER_CARD_WIDTH = 132;
export const POSTER_CARD_HEIGHT = 198;
const POSTER_RADIUS = 12;

const INITIAL_CARDS = 12;
// Smaller pages than before: each page is one React commit that mounts this
// many Pressables + Images, and a held D-pad key keeps moving focus while it
// is being processed. Shorter commits = shorter stalls. (Lookahead below still
// keeps several posters mounted ahead of focus.)
const CARDS_PAGE = 6;
const CARDS_LOOKAHEAD = 8;
// Within this many posters of the end of what is loaded, ask for the next page.
const LOAD_MORE_LOOKAHEAD = 10;
const SCROLL_SETTLE_MS = 2500;
const SKELETON_COUNT = 8;
// Once focus has rested on a poster for this long, the next few posters'
// images are warmed into the disk cache so they appear instantly as the row
// scrolls (instead of popping in after the card is already on screen).
const PREFETCH_SETTLE_MS = 150;
const PREFETCH_AHEAD = 8;
const prefetchedPosters = new Set<string>();

export const posterItemKey = (rowKey: string, index: number, id: string) =>
  `${rowKey}@@${index}@@${id}`;

const focusedIndexInRow = (rowKey: string, lastKey: string | null): number => {
  if (!lastKey || !lastKey.startsWith(`${rowKey}@@`)) return -1;
  const idx = Number(lastKey.slice(rowKey.length + 2).split('@@')[0]);
  return Number.isFinite(idx) ? idx : -1;
};

interface CardProps {
  item: any;
  itemKey: string;
  rowKey: string;
  rowIndex: number;
  pIndex: number;
  isTopRow: boolean;
  shouldFocus: boolean;
  refocusNonce: number | null;
  onCardFocus: (
    rowKey: string,
    rowIndex: number,
    item: any,
    itemKey: string,
    pIndex: number
  ) => boolean;
  onCardPress: (rowKey: string, item: any) => void;
  registerItemRef: (itemKey: string, el: View | null) => void;
  scrollItemIntoView: (itemKey: string) => void;
  onCardLayout: (itemKey: string, x: number) => void;
  getUpHandle?: () => number | null;
  onTopFirstCard?: (node: View | null) => void;
}

const PosterCard = memo(function PosterCard({
  item,
  itemKey,
  rowKey,
  rowIndex,
  pIndex,
  isTopRow,
  shouldFocus,
  refocusNonce,
  onCardFocus,
  onCardPress,
  registerItemRef,
  scrollItemIntoView,
  onCardLayout,
  getUpHandle,
  onTopFirstCard,
}: CardProps) {
  const isFirstInRow = pIndex === 0;
  const nodeRef = useRef<View | null>(null);

  // `hasTVPreferredFocus` makes Android call requestFocus() every time the
  // prop flips to true on an already-mounted view. `shouldFocus` follows the
  // module-level "last focused key", so any re-render of the row while a key
  // was held (a page of posters mounting, rows paging in, ...) flipped it on
  // whichever card JS had most recently *heard about* -- which is behind where
  // native focus already is -- and focus snapped back to it, producing the
  // "looping between two posters" glitch. Only evaluate it when this card's
  // focusable is (re)mounted: first mount, or the refocus-nonce remount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const preferFocus = useMemo(() => shouldFocus, [refocusNonce]);

  // Last `nextFocusUp` pushed to the native view. Every setNativeProps is a
  // full shadow-tree commit, so only issue one when the value really changed
  // (this ran on *every* focus move in the top row before).
  const appliedUpRef = useRef<number | null>(null);
  const applyUpLink = useCallback(() => {
    // Top row: Up goes to the "Catalogs" button (or nowhere) -- never to the
    // nav rail, which Android's geometric search would otherwise pick.
    const node = nodeRef.current as any;
    if (!isTopRow || !node) return;
    const self = findNodeHandle(node);
    const up = getUpHandle?.() ?? self;
    if (up == null || appliedUpRef.current === up) return;
    appliedUpRef.current = up;
    node.setNativeProps?.({ nextFocusUp: up });
  }, [isTopRow, getUpHandle]);

  const setRef = useCallback(
    (el: View | null) => {
      if (el !== nodeRef.current) appliedUpRef.current = null; // new native view
      nodeRef.current = el;
      registerItemRef(itemKey, el);
      if (!el) return;
      if (isFirstInRow) {
        registerRailLeftEdge('discover', el);
        if (isTopRow) onTopFirstCard?.(el);
      }
      applyUpLink();
    },
    [registerItemRef, itemKey, isFirstInRow, isTopRow, onTopFirstCard, applyUpLink]
  );

  const handleFocus = useCallback(() => {
    if (!onCardFocus(rowKey, rowIndex, item, itemKey, pIndex)) return;
    if (isFirstInRow) registerRailLeftEdge('discover', nodeRef.current);
    applyUpLink();
    scrollItemIntoView(itemKey);
  }, [
    onCardFocus,
    rowKey,
    rowIndex,
    item,
    itemKey,
    pIndex,
    isFirstInRow,
    applyUpLink,
    scrollItemIntoView,
  ]);

  const handleLayout = useCallback(
    (e: { nativeEvent: { layout: { x: number } } }) =>
      onCardLayout(itemKey, e.nativeEvent.layout.x),
    [onCardLayout, itemKey]
  );
  const handlePress = useCallback(() => onCardPress(rowKey, item), [onCardPress, rowKey, item]);

  return (
    <TVFocusablePressable
      key={refocusNonce != null ? `${itemKey}-r${refocusNonce}` : itemKey}
      ref={setRef}
      hasTVPreferredFocus={preferFocus}
      scaleFocused={1.05}
      focusedBorderColor="#FFFFFF"
      borderRadius={POSTER_RADIUS}
      borderWidth={3}
      onFocus={handleFocus}
      onLayout={handleLayout}
      onPress={handlePress}
      style={styles.card}
    >
      {() => (
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
      )}
    </TVFocusablePressable>
  );
});

export interface TVPosterRowProps {
  rowKey: string;
  title: string;
  sourceLabel?: string;
  items: any[];
  loading: boolean;
  rowIndex: number;
  getLastFocusedKey: () => string | null;
  // Only set for the row that holds the refocus target, so other rows are not
  // re-rendered by it.
  refocusKey: string | null;
  refocusNonce: number;
  onCardFocus: CardProps['onCardFocus'];
  onCardPress: CardProps['onCardPress'];
  registerItemRef: CardProps['registerItemRef'];
  // Asks the screen for the next page of this row's catalog.
  onNeedMore: (rowKey: string) => void;
  getUpHandle?: () => number | null;
  onTopFirstCard?: (node: View | null) => void;
}

export const TVPosterRow = memo(function TVPosterRow({
  rowKey,
  title,
  sourceLabel,
  items,
  loading,
  rowIndex,
  getLastFocusedKey,
  refocusKey,
  refocusNonce,
  onCardFocus,
  onCardPress,
  registerItemRef,
  onNeedMore,
  getUpHandle,
  onTopFirstCard,
}: TVPosterRowProps) {
  const isTopRow = rowIndex === 0;
  const lastKey = getLastFocusedKey();

  const [mountedCount, setMountedCount] = useState(INITIAL_CARDS);
  const totalRef = useRef(items.length);
  totalRef.current = items.length;

  // --- explicit Left/Right chain (see file comment) -----------------------
  const nodesRef = useRef<Record<string, View | null>>({});
  const orderRef = useRef<string[]>([]);
  const wireTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Links already pushed to each card's native view, so a page of new posters
  // only touches the new cards (+ the previous last card) instead of
  // re-committing every card in the row.
  const appliedLinksRef = useRef<Record<string, { l?: number; r: number }>>({});

  const wireLinks = useCallback(() => {
    wireTimerRef.current = null;
    const order = orderRef.current;
    const handles = order.map((k) => {
      const n = nodesRef.current[k];
      return n ? findNodeHandle(n) : null;
    });
    for (let i = 0; i < order.length; i++) {
      const node = nodesRef.current[order[i]] as any;
      const self = handles[i];
      if (!node || self == null) continue;
      const next = i < order.length - 1 ? handles[i + 1] : null;
      const right = next ?? self;
      const left = i > 0 ? handles[i - 1] ?? self : undefined;
      const applied = appliedLinksRef.current[order[i]];
      const props: Record<string, number> = {};
      if (!applied || applied.r !== right) props.nextFocusRight = right;
      if (left !== undefined && (!applied || applied.l !== left)) props.nextFocusLeft = left;
      if (Object.keys(props).length === 0) continue;
      appliedLinksRef.current[order[i]] = { l: left ?? applied?.l, r: right };
      node.setNativeProps?.(props);
    }
  }, []);
  const scheduleWire = useCallback(() => {
    if (wireTimerRef.current) return;
    wireTimerRef.current = setTimeout(wireLinks, 0);
  }, [wireLinks]);
  const registerRowItemRef = useCallback(
    (itemKey: string, el: View | null) => {
      // A different native view under the same key (remount) has none of the
      // links the cache thinks it has.
      if (el !== nodesRef.current[itemKey]) delete appliedLinksRef.current[itemKey];
      nodesRef.current[itemKey] = el;
      registerItemRef(itemKey, el);
      if (el) scheduleWire();
    },
    [registerItemRef, scheduleWire]
  );
  useEffect(
    () => () => {
      if (wireTimerRef.current) clearTimeout(wireTimerRef.current);
    },
    []
  );

  // --- scrolling the focused poster into view -----------------------------
  const scrollViewRef = useRef<ScrollView>(null);
  const cardXRef = useRef<Record<string, number>>({});
  const scrollTargetKeyRef = useRef<string | null>(null);
  const scrollPendingUntilRef = useRef(0);

  const applyPendingScroll = useCallback(() => {
    if (Date.now() > scrollPendingUntilRef.current) return;
    const key = scrollTargetKeyRef.current;
    const sv = scrollViewRef.current;
    if (!key || !sv) return;
    const x = cardXRef.current[key];
    if (x == null) return; // its onLayout will call us once it is placed
    sv.scrollTo({ x: Math.max(0, x - 36), y: 0, animated: false });
  }, []);
  const scrollItemIntoView = useCallback(
    (itemKey: string) => {
      scrollTargetKeyRef.current = itemKey;
      scrollPendingUntilRef.current = Date.now() + SCROLL_SETTLE_MS;
      applyPendingScroll();
    },
    [applyPendingScroll]
  );
  const handleCardLayout = useCallback(
    (itemKey: string, x: number) => {
      cardXRef.current[itemKey] = x;
      if (scrollTargetKeyRef.current === itemKey) applyPendingScroll();
    },
    [applyPendingScroll]
  );
  useEffect(() => {
    // Coming back from the details page remounts the row: keep re-applying
    // the scroll while layout settles.
    const timers = [60, 200, 450, 900, 1500, 2200].map((ms) =>
      setTimeout(applyPendingScroll, ms)
    );
    return () => timers.forEach(clearTimeout);
  }, [applyPendingScroll]);

  // The poster that holds (or last held) focus must always be mounted.
  const focusedIdx = focusedIndexInRow(rowKey, lastKey);
  const renderCount = Math.min(
    items.length,
    Math.max(mountedCount, focusedIdx >= 0 ? focusedIdx + CARDS_PAGE : 0)
  );

  const keys = items
    .slice(0, renderCount)
    .map((item, i) => posterItemKey(rowKey, i, String(item?.id ?? i)));
  orderRef.current = keys;
  useEffect(() => {
    scheduleWire();
  }, [renderCount, items, refocusNonce, scheduleWire]);

  const itemsRef = useRef(items);
  itemsRef.current = items;
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

  const handleCardFocus = useCallback<CardProps['onCardFocus']>(
    (rKey, rIdx, item, itemKey, pIndex) => {
      if (!onCardFocus(rKey, rIdx, item, itemKey, pIndex)) return false;
      schedulePrefetch(pIndex);
      setMountedCount((c) =>
        c < totalRef.current && pIndex >= c - CARDS_LOOKAHEAD ? c + CARDS_PAGE : c
      );
      if (pIndex >= totalRef.current - LOAD_MORE_LOOKAHEAD) onNeedMore(rKey);
      return true;
    },
    [onCardFocus, onNeedMore, schedulePrefetch]
  );

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
        showsHorizontalScrollIndicator={false}
        style={styles.rowScroll}
        contentContainerStyle={styles.rowContent}
        removeClippedSubviews={false}
        onContentSizeChange={applyPendingScroll}
        onLayout={applyPendingScroll}
      >
        {items.length === 0 && loading
          ? Array.from({ length: SKELETON_COUNT }).map((_, i) => (
              <View key={`sk-${i}`} style={[styles.card, styles.skeleton]} />
            ))
          : items.slice(0, renderCount).map((item, pIndex) => {
              const itemKey = keys[pIndex];
              return (
                <PosterCard
                  key={itemKey}
                  item={item}
                  itemKey={itemKey}
                  rowKey={rowKey}
                  rowIndex={rowIndex}
                  pIndex={pIndex}
                  isTopRow={isTopRow}
                  shouldFocus={lastKey ? lastKey === itemKey : isTopRow && pIndex === 0}
                  refocusNonce={refocusKey === itemKey ? refocusNonce : null}
                  onCardFocus={handleCardFocus}
                  onCardPress={onCardPress}
                  registerItemRef={registerRowItemRef}
                  scrollItemIntoView={scrollItemIntoView}
                  onCardLayout={handleCardLayout}
                  getUpHandle={getUpHandle}
                  onTopFirstCard={onTopFirstCard}
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
  // The focused poster is scaled up and has a ring; both overflow the poster's
  // box and a ScrollView clips to its bounds. Grow the scroll area with the
  // padding below and pull it back with equal negative margins so posters sit
  // exactly where they would without it.
  rowScroll: {
    marginLeft: -12,
    marginTop: -10,
    marginBottom: -10,
    flexGrow: 0,
  },
  rowContent: {
    paddingLeft: 12,
    paddingRight: 60,
    gap: 14,
    paddingVertical: 10,
  },
  card: {
    width: POSTER_CARD_WIDTH,
    height: POSTER_CARD_HEIGHT,
    backgroundColor: '#16161E',
    borderRadius: POSTER_RADIUS,
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
