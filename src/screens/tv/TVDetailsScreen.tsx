import { getPlaybackPrefs, pickPreferredStream } from '../../lib/zustand/playbackPrefsStore';
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Image,
  useWindowDimensions,
  ActivityIndicator,
  ToastAndroid,
  Modal,
  Pressable,
  DeviceEventEmitter,
  findNodeHandle,
} from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { TVFocusablePressable } from '../../components/tv/TVFocusablePressable';
import useContentStore from '../../lib/zustand/contentStore';
import { providerManager } from '../../lib/services/ProviderManager';
import {
  isStremioProvider,
  prefetchStremioStreams,
  scheduleStremioStreamPrefetch,
} from '../../lib/services/stremioAddon';
import { getCachedMetadata, getOrFetchMetadata } from '../../lib/services/metadataCache';
import {
  resolveCinemetaMeta,
  prewarmCinemetaForTitle,
  findCinemetaEpisode,
  formatCinemetaRuntime,
  formatEpisodeReleaseDate,
  CinemetaMeta,
} from '../../lib/services/cinemetaService';
import { settingsStorage } from '../../lib/storage';
import { getTmdbApiKey } from '../../lib/hooks/useTmdbStory';
import {
  CreditPerson,
  TmdbCredits,
  TmdbEpisodeInfo,
  TmdbIdentityLite,
  fetchTmdbCredits,
  fetchTmdbRating,
  fetchTmdbSeasonEpisodes,
  resolveTmdbIdentityLite,
} from '../../lib/services/tmdbDetailsService';
import { launchVideo, PlayerChoice } from '../../lib/services/PlayerLauncher';
import { parseSeasonNumber, parseEpisodeNumber, sortEpisodesChronologically, formatEpisodeLabel, isBareEpisodeLabel } from '../../lib/utils/episodeParsing';
import { buildEpisodeRanges, rangeForIndex } from '../../lib/utils/episodeRanges';
import { getFileSizeLabel, stripFileSize } from '../../lib/utils/fileSize';
import {
  DetailsReturnState,
  clearDetailsReturnState,
  episodeRowKey,
  peekDetailsReturnState,
  saveDetailsReturnState,
  sourceRowKey,
} from '../../lib/tv/detailsReturnState';
import type { Info, Link, EpisodeLink, TextTracks, StreamDrm } from '../../lib/providers/types';

// The TV settings screen's 'exo' | 'vlc' | 'system' options map onto
// `PlayerLauncher`'s choices ('exoplayer' being the internal player).
const toPlayerChoice = (pref: 'exo' | 'vlc' | 'system'): PlayerChoice =>
  pref === 'vlc' ? 'vlc' : pref === 'system' ? 'external' : 'exoplayer';

// Provider tags for a stream (mirrors the mobile app's server list): the
// `tags` array or a single `tag`, minus anything that just repeats the quality.
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

// Check against Settings' excluded qualities (Settings -> Quality). Handles
// "1080", "1080p", "4k", "2160p" etc. -- same helper used by
// TVDiscoverScreen/TVPlayerScreen so a quality excluded there is excluded
// everywhere.
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

// Vertical breathing room kept above a row when scrolling it back into view
// after returning from the player, so the "Episodes" header and the row
// before it stay visible instead of the target sitting flush at the top.
const RESTORE_SCROLL_MARGIN = 140;

type DirectLink = NonNullable<Link['directLinks']>[number];

// One line of the episode / source list, fully resolved for display. Both
// list flavours -- a real per-season episode list, and the flat "direct
// links" list providers without season grouping fall back to -- are turned
// into these, so they render (and restore focus) identically.
interface DetailRow {
  // Unique focus identity (see episodeRowKey / sourceRowKey).
  key: string;
  index: number;
  link: string;
  isEpisode: boolean;
  // Stable "S{season}E{episode}" for episode rows; also the resume/restore identity.
  stableKey?: string;
  title: string;
  thumb?: string;
  overview?: string;
  releaseDate?: string;
  sizeLabel?: string;
  // Horizontal episode card extras.
  episodeNumber?: number;
  // Clean episode name (no "S01E01-" prefix).
  cardTitle?: string;
  runtimeLabel?: string;
  ratingLabel?: string;
  ratingSource?: 'IMDb' | 'TMDB';
  isResumeTarget: boolean;
  // What the pre-existing rules would focus on a normal (non-restore) entry.
  isDefaultFocus: boolean;
  playTitle: string;
  playType: string;
  episodesOverride?: EpisodeLink[];
}

// Extracted out of the main component and wrapped in React.memo so that,
// on a long episode list, an unrelated re-render of TVDetailsScreen (a
// season/quality switch, the picker opening, a scroll-position side effect,
// etc.) doesn't force every single row to re-run its render function --
// only the row(s) whose own props actually changed do. `row` itself is a
// stable object reference (from the `rows` useMemo below) as long as the
// underlying data hasn't changed, so the default shallow prop comparison is
// enough; `onPress`/`onLayout` are passed down as the single stable
// callbacks the parent already memoizes, rather than a fresh closure per
// row, so they never trip that comparison either.
const formatRemainingLabel = (seconds: number): string => {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes}m left`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m left` : `${hours}h left`;
};

const KEYCODE_DPAD_UP = 19;
const KEYCODE_DPAD_DOWN = 20;
const KEYCODE_DPAD_LEFT = 21;
const KEYCODE_DPAD_RIGHT = 22;
// Row the cursor sits on is held this far down the viewport while paging
// (vertical source lists only).
const LIST_FOCUS_ANCHOR = 0.4;

// Action row (season / quality picker + resume pill).
const PAGE_PAD_H = 48;
const ACTION_ROW_GAP = 12;
const PILL_MAX_COLLAPSED = 460;
// Width the picker shrinks to while the resume pill is focused.
const PICKER_COMPACT_W = 210;

// Horizontal episode card geometry. Explicit pixel sizes on purpose: Fabric
// collapses percentage / absoluteFill-sized containers on this device.
const EPISODE_CARD_W = 300;
const EPISODE_CARD_H = 176;
const EPISODE_CARD_GAP = 14;
// Space kept around the focused (scaled) card so it is never clipped.
const EPISODE_ROW_PAD_V = 12;
const EPISODE_ROW_PAD_H = 8;
// Credits strip: photo size and the strip's explicit height.
const CREDIT_PHOTO = 104;
const CREDIT_ROW_H = 190;
// Title fanart / clearlogo bounds -- matches TVDiscoverResultsView's targetLogo.
const LOGO_MAX_W = 320;
const LOGO_MAX_H = 100;

// "125" -> "2h 5m", "59" -> "59m".
const formatMinutes = (min: number | undefined): string | undefined => {
  if (!min || min <= 0) return undefined;
  const total = Math.round(min);
  if (total < 60) return `${total}m`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
};

// Cinemeta runtimes come as "60 min", "1h 2min" or a bare number.
const parseRuntimeMinutes = (value: string | number | undefined | null): number | undefined => {
  if (value === undefined || value === null) return undefined;
  const s = String(value);
  const h = /(\d+)\s*h/i.exec(s);
  const m = /(\d+)\s*m/i.exec(s);
  if (h || m) return (h ? parseInt(h[1], 10) * 60 : 0) + (m ? parseInt(m[1], 10) : 0);
  const n = parseInt(s, 10);
  return n > 0 ? n : undefined;
};

// Episodes are horizontal cards (thumbnail, synopsis, runtime, rating); a
// plain server/quality row is used for non-episode lists. Purely
// presentational: rows are NOT focusable. The whole list is one native focus
// target (see `EpisodeList`), and the highlighted row is JS state.
const EpisodeRow = React.memo(function EpisodeRow({
  row,
  selected,
  resumePosition,
  onLayout,
}: {
  row: DetailRow;
  selected: boolean;
  resumePosition?: number;
  onLayout: (key: string, x: number, y: number, w: number, h: number) => void;
}) {
  const focused = selected;
  const handleLayout = (e: any) => {
    const l = e.nativeEvent.layout;
    onLayout(row.key, l.x, l.y, l.width, l.height);
  };

  if (row.isEpisode) {
    return (
      <View onLayout={handleLayout} style={[styles.hCard, selected && styles.hCardSelected]}>
        {row.thumb ? (
          <Image
            source={{ uri: row.thumb }}
            style={styles.hCardImage}
            resizeMode="cover"
            // Skips the fade-in transition on Android -- adds up across a
            // long row of thumbs mounting in quick succession.
            fadeDuration={0}
          />
        ) : null}
        <LinearGradient
          colors={['rgba(10, 10, 14, 0.10)', 'rgba(10, 10, 14, 0.72)', 'rgba(10, 10, 14, 0.96)']}
          locations={[0, 0.42, 1]}
          style={styles.hCardScrim}
        />
        {row.isResumeTarget && resumePosition ? (
          <Text style={styles.hResumeBadge}>
            Resume {Math.floor(resumePosition / 60)}:
            {String(Math.floor(resumePosition % 60)).padStart(2, '0')}
          </Text>
        ) : null}
        <View style={styles.hCardBody}>
          {row.episodeNumber != null ? (
            <View style={styles.hBadge}>
              <Text style={styles.hBadgeText}>EPISODE {row.episodeNumber}</Text>
            </View>
          ) : null}
          <Text numberOfLines={1} style={styles.hTitle}>
            {row.cardTitle || row.title}
          </Text>
          {row.overview ? (
            <Text numberOfLines={3} style={styles.hOverview}>
              {row.overview}
            </Text>
          ) : null}
          <View style={styles.hMetaRow}>
            {row.runtimeLabel ? (
              <View style={styles.hMetaItem}>
                <MaterialCommunityIcons name="clock-outline" size={13} color="#D1D5DB" />
                <Text style={styles.hMetaText}>{row.runtimeLabel}</Text>
              </View>
            ) : null}
            {row.ratingLabel ? (
              <View style={styles.hMetaItem}>
                <View style={styles.hRatingTag}>
                  <Text style={styles.hRatingTagText}>{row.ratingSource || 'IMDb'}</Text>
                </View>
                <Text style={styles.hRatingValue}>{row.ratingLabel}</Text>
              </View>
            ) : null}
            {row.sizeLabel ? (
              <View style={styles.hMetaItem}>
                <MaterialCommunityIcons name="harddisk" size={13} color="#D1D5DB" />
                <Text style={styles.hMetaText}>{row.sizeLabel}</Text>
              </View>
            ) : null}
            <View style={styles.hMetaSpacer} />
            {row.releaseDate ? (
              <Text numberOfLines={1} style={styles.hMetaText}>
                {row.releaseDate}
              </Text>
            ) : null}
          </View>
        </View>
      </View>
    );
  }

  return (
    <View
      onLayout={handleLayout}
      style={[
        styles.sourceRow,
        styles.rowFrame,
        { borderRadius: 10 },
        selected && styles.rowSelected,
      ]}
    >
      <View style={styles.episodeInner}>
        <View style={[styles.playCircle, focused && styles.playCircleFocused]}>
          <MaterialCommunityIcons name="play" size={18} color="#FFFFFF" />
        </View>
        <View style={styles.episodeTextWrap}>
          <Text numberOfLines={1} style={styles.sourceText}>
            {row.title}
          </Text>
        </View>
        {!!row.sizeLabel && (
          <View style={styles.sizeBadge}>
            <Text style={styles.sizeBadgeText}>{row.sizeLabel}</Text>
          </View>
        )}
        {row.isResumeTarget && resumePosition ? (
          <Text style={styles.resumeBadge}>
            Resume {Math.floor(resumePosition / 60)}:
            {String(Math.floor(resumePosition % 60)).padStart(2, '0')}
          </Text>
        ) : null}
      </View>
    </View>
  );
});

// The episode / source list as ONE native focus target. Episodes are a
// horizontal row: Left/Right never move native focus between cards, the
// cursor is JS state advanced from the raw key stream (every repeat of a held
// key arrives) and the row scrolls under it. Server/quality lists keep the
// original vertical behaviour (Up/Down, page scroll). A transparent Pressable
// sits over the cursor row and is what actually holds focus (and receives OK).
const EpisodeList = React.memo(function EpisodeList({
  rows,
  targetKey,
  focusNonce,
  paused,
  resumeHint,
  onPressRow,
  onRowLayout,
  onWrapperLayout,
  scrollToRow,
  onFocusList,
  onCursorRow,
}: {
  rows: DetailRow[];
  // Row that should take focus when the list mounts / is refocused (or null).
  targetKey: string | null;
  focusNonce: number;
  // A modal (season picker, server picker) is open: ignore keys.
  paused: boolean;
  resumeHint?: { position?: number };
  onPressRow: (row: DetailRow) => void;
  onRowLayout: (key: string, y: number, h: number) => void;
  onWrapperLayout: (y: number) => void;
  // Vertical (source list) page scroll.
  scrollToRow: (key: string) => boolean;
  // The horizontal episode row took focus: bring the page back to the top so
  // the whole row is on screen.
  onFocusList?: () => void;
  // The cursor came to rest on a row (with the row after it, if any).
  onCursorRow?: (row: DetailRow, next?: DetailRow) => void;
}) {
  const { width: windowWidth } = useWindowDimensions();
  const horizontal = rows[0]?.isEpisode === true;
  const firstKey = rows[0]?.key ?? null;
  const [selectedKey, setSelectedKey] = useState<string | null>(targetKey ?? firstKey);
  const selectedKeyRef = useRef<string | null>(targetKey ?? firstKey);
  const [listFocused, setListFocused] = useState(false);
  const listFocusedRef = useRef(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const pendingScrollKeyRef = useRef<string | null>(null);
  const layoutsRef = useRef<Record<string, { x: number; y: number; w: number; h: number }>>({});
  const [, setLayoutTick] = useState(0);
  const [hostHandle, setHostHandle] = useState<number | null>(null);
  const onFocusListRef = useRef(onFocusList);
  onFocusListRef.current = onFocusList;
  const onCursorRowRef = useRef(onCursorRow);
  onCursorRowRef.current = onCursorRow;

  // Horizontal row scroll state. The ScrollView's own scrolling is off, so
  // `hOffsetRef` is the single source of truth for its offset.
  const hScrollRef = useRef<ScrollView | null>(null);
  const hOffsetRef = useRef(0);
  const hViewportRef = useRef(0);

  // Focus preference is decided when the host mounts and never flipped later
  // (re-applying hasTVPreferredFocus calls requestFocus() again, which is what
  // pulled focus around under a held key). A new nonce remounts the host.
  const hostKey = `ep-host${targetKey ? `-f${focusNonce}` : ''}`;
  const preferredMemoRef = useRef<Record<string, boolean>>({});
  if (!(hostKey in preferredMemoRef.current)) {
    preferredMemoRef.current[hostKey] = targetKey != null;
  }
  const preferFocus = preferredMemoRef.current[hostKey];

  // Keep the cursor on a row that exists (block chips / season switch).
  const effectiveKey =
    selectedKey && rows.some((r) => r.key === selectedKey) ? selectedKey : firstKey;
  const selectedIndex = effectiveKey ? rows.findIndex((r) => r.key === effectiveKey) : -1;
  useEffect(() => {
    if (effectiveKey !== selectedKeyRef.current) {
      selectedKeyRef.current = effectiveKey;
      setSelectedKey(effectiveKey);
    }
  }, [effectiveKey]);

  // Tell the screen where the cursor is (it warms that episode's streams).
  // The screen debounces, so a held key sweeping the row costs nothing.
  useEffect(() => {
    if (!listFocused || !effectiveKey) return;
    const list = rowsRef.current;
    const idx = list.findIndex((r) => r.key === effectiveKey);
    if (idx >= 0) onCursorRowRef.current?.(list[idx], list[idx + 1]);
  }, [listFocused, effectiveKey]);

  // Brings the cursor row into view. Horizontal: scrolls the row only when
  // the card is not fully visible. Vertical: the page-level scroll. Returns
  // false when layouts are not known yet (caller retries once they are).
  const scrollToKey = useCallback(
    (key: string): boolean => {
      if (!horizontal) return scrollToRow(key);
      const l = layoutsRef.current[key];
      const viewport = hViewportRef.current;
      if (!l || !viewport) return false;
      const margin = 24;
      const offset = hOffsetRef.current;
      let next = offset;
      if (l.x - margin < offset) next = Math.max(0, l.x - margin);
      else if (l.x + l.w + margin > offset + viewport) next = l.x + l.w + margin - viewport;
      if (next !== offset) {
        hOffsetRef.current = next;
        hScrollRef.current?.scrollTo({ x: next, y: 0, animated: true });
      }
      return true;
    },
    [horizontal, scrollToRow],
  );

  // A new focus target (restore, season/quality pick) moves the cursor to it.
  useEffect(() => {
    if (!targetKey) return;
    selectedKeyRef.current = targetKey;
    setSelectedKey(targetKey);
    pendingScrollKeyRef.current = scrollToKey(targetKey) ? null : targetKey;
  }, [targetKey, focusNonce, scrollToKey]);

  const handleLayout = useCallback(
    (key: string, x: number, y: number, w: number, h: number) => {
      const prev = layoutsRef.current[key];
      if (!prev || prev.x !== x || prev.y !== y || prev.w !== w || prev.h !== h) {
        layoutsRef.current[key] = { x, y, w, h };
        if (key === selectedKeyRef.current) setLayoutTick((t) => t + 1);
      }
      onRowLayout(key, y, h);
      if (pendingScrollKeyRef.current === key && scrollToKey(key)) {
        pendingScrollKeyRef.current = null;
      }
    },
    [onRowLayout, scrollToKey],
  );

  const moveSelection = useCallback(
    (delta: number) => {
      const list = rowsRef.current;
      if (list.length === 0) return;
      const current = Math.max(0, list.findIndex((r) => r.key === selectedKeyRef.current));
      const next = Math.min(list.length - 1, Math.max(0, current + delta));
      const nextKey = list[next].key;
      if (nextKey === selectedKeyRef.current) return;
      selectedKeyRef.current = nextKey;
      pendingScrollKeyRef.current = scrollToKey(nextKey) ? null : nextKey;
      setSelectedKey(nextKey);
    },
    [scrollToKey],
  );

  useEffect(() => {
    const nextCode = horizontal ? KEYCODE_DPAD_RIGHT : KEYCODE_DPAD_DOWN;
    const prevCode = horizontal ? KEYCODE_DPAD_LEFT : KEYCODE_DPAD_UP;
    const sub = DeviceEventEmitter.addListener('onKeyDown', (e: { keyCode?: number }) => {
      if (!listFocusedRef.current || pausedRef.current) return;
      if (e?.keyCode === nextCode) moveSelection(1);
      else if (e?.keyCode === prevCode) moveSelection(-1);
    });
    return () => sub.remove();
  }, [moveSelection, horizontal]);

  const handleFocus = useCallback(() => {
    listFocusedRef.current = true;
    setListFocused(true);
    const key = selectedKeyRef.current ?? rowsRef.current[0]?.key ?? null;
    // Horizontal row: always back to the top. Vertical list: only when the
    // cursor is on the first row (deeper rows keep their anchored scroll).
    if (horizontal || key === rowsRef.current[0]?.key) onFocusListRef.current?.();
    if (key) {
      selectedKeyRef.current = key;
      setSelectedKey(key);
      pendingScrollKeyRef.current = scrollToKey(key) ? null : key;
    }
  }, [scrollToKey, horizontal]);

  const handleBlur = useCallback(() => {
    listFocusedRef.current = false;
    setListFocused(false);
  }, []);

  const handlePress = useCallback(() => {
    const row = rowsRef.current.find((r) => r.key === selectedKeyRef.current);
    if (row) onPressRow(row);
  }, [onPressRow]);

  const hostRef = useCallback((el: View | null) => {
    if (el) {
      const handle = findNodeHandle(el);
      setHostHandle((prev) => (prev === handle ? prev : handle));
    } else {
      listFocusedRef.current = false;
      setListFocused(false);
    }
  }, []);

  // Moving along the list is swallowed natively (the cursor moves instead).
  // Horizontal episode row: Left/Right always point at the host itself, so
  // at the first / last card the key is consumed and focus stays put --
  // there is nothing beside those cards, and the default search would jump
  // to the credits strip below. (Vertical source list: at either end the key
  // keeps its default search.) Nothing is wired across the other axis:
  // Up/Down fall through to the default search.
  const hostLinks: { nextFocusUp?: number; nextFocusLeft?: number; nextFocusRight?: number } = {};
  if (hostHandle != null) {
    if (horizontal) {
      hostLinks.nextFocusLeft = hostHandle;
      hostLinks.nextFocusRight = hostHandle;
    } else if (selectedIndex > 0) {
      hostLinks.nextFocusUp = hostHandle;
    }
  }

  const sel = effectiveKey ? layoutsRef.current[effectiveKey] : undefined;

  const items = rows.map((row) => (
    <EpisodeRow
      key={`row-${row.key}-${row.index}`}
      row={row}
      selected={listFocused && row.key === effectiveKey}
      resumePosition={row.isResumeTarget ? resumeHint?.position : undefined}
      onLayout={handleLayout}
    />
  ));

  if (horizontal) {
    return (
      <View onLayout={(e) => onWrapperLayout(e.nativeEvent.layout.y)}>
        <ScrollView
          ref={hScrollRef}
          horizontal
          // Off on purpose, like the page ScrollView: the cursor drives it.
          scrollEnabled={false}
          showsHorizontalScrollIndicator={false}
          removeClippedSubviews={false}
          // Cards run off the right edge of the screen (the page has 48 of
          // horizontal padding), so the width is explicit.
          style={{ width: windowWidth - 48, height: EPISODE_CARD_H + EPISODE_ROW_PAD_V * 2 }}
          contentContainerStyle={styles.hRowContent}
          onLayout={(e) => {
            hViewportRef.current = e.nativeEvent.layout.width;
            const pending = pendingScrollKeyRef.current;
            if (pending && scrollToKey(pending)) pendingScrollKeyRef.current = null;
          }}
        >
          {items}
          <Pressable
            key={hostKey}
            ref={hostRef}
            focusable
            hasTVPreferredFocus={preferFocus}
            onFocus={handleFocus}
            onBlur={handleBlur}
            onPress={handlePress}
            {...(hostLinks as any)}
            style={[
              styles.listHost,
              {
                left: sel ? sel.x : EPISODE_ROW_PAD_H,
                top: sel ? sel.y : EPISODE_ROW_PAD_V,
                width: sel ? sel.w : EPISODE_CARD_W,
                height: sel ? sel.h : EPISODE_CARD_H,
              },
            ]}
          />
        </ScrollView>
      </View>
    );
  }

  return (
    <View onLayout={(e) => onWrapperLayout(e.nativeEvent.layout.y)}>
      {items}
      <Pressable
        key={hostKey}
        ref={hostRef}
        focusable
        hasTVPreferredFocus={preferFocus}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onPress={handlePress}
        {...(hostLinks as any)}
        style={[
          styles.listHost,
          { left: 0, right: 0, top: sel ? sel.y : 0, height: sel ? sel.h : 48 },
        ]}
      />
    </View>
  );
});

// One director / cast member: round photo (initials when there is none),
// name and role. Focusable only so D-pad Down from the episode row can reach
// the section and scroll it into view.
const CreditItem = React.memo(function CreditItem({
  person,
  onFocus,
}: {
  person: CreditPerson;
  onFocus: () => void;
}) {
  const [photoFailed, setPhotoFailed] = useState(false);
  const initials = person.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');
  return (
    <TVFocusablePressable
      scaleFocused={1.06}
      focusedBorderColor="#8A5CF6"
      borderRadius={14}
      onFocus={onFocus}
      style={styles.creditItem}
    >
      {() => (
        <View style={styles.creditInner}>
          {person.photo && !photoFailed ? (
            <Image
              source={{ uri: person.photo }}
              style={styles.creditPhoto}
              resizeMode="cover"
              fadeDuration={0}
              onError={() => setPhotoFailed(true)}
            />
          ) : (
            <View style={[styles.creditPhoto, styles.creditPhotoFallback]}>
              <Text style={styles.creditInitials}>{initials}</Text>
            </View>
          )}
          <Text numberOfLines={2} style={styles.creditName}>
            {person.name}
          </Text>
          {person.role ? (
            <Text numberOfLines={1} style={styles.creditRole}>
              {person.role}
            </Text>
          ) : null}
        </View>
      )}
    </TVFocusablePressable>
  );
});

interface ResumeHint {
  episodeLink?: string;
  // Stable "S{season}E{episode}" key -- see ContinueWatchingItem.episodeKey.
  // Preferred over `episodeLink` when present; `episodeLink` stays as a
  // fallback for entries saved before this key existed.
  episodeKey?: string;
  position?: number;
  // Length of that episode (seconds), when known -- drives the resume card's
  // progress bar and the "Up next" switch near the end.
  duration?: number;
  // Exact label of the season/quality/dub dropdown entry (`activeLink.title`)
  // that was active when this episode was played -- see
  // ContinueWatchingItem.linkTitle. Lets a Continue Watching press land back
  // on the same entry instead of always defaulting to the first one. Absent
  // on entries saved before this field existed.
  linkTitle?: string;
}

interface TVDetailsScreenProps {
  item: any;
  onBack: () => void;
  onPlayStream: (
    streamUrl: string,
    title?: string,
    extraMeta?: {
      posterUrl?: string;
      itemLink?: string;
      episodeId?: string;
      providerValue?: string;
      episodes?: any[];
      currentEpisodeIndex?: number;
      // Passed straight through to TVPlayerScreen's TheIntroDB lookup.
      tmdbId?: number | string;
      imdbId?: string;
      // Clean title + year so the player can work out a tmdbId when the
      // provider has none (see lib/services/tmdbIdResolver.ts).
      mediaTitle?: string;
      mediaYear?: string | number;
      servers?: { name: string; url: string; headers?: Record<string, string>; sourceType?: string; drm?: StreamDrm; server?: string; quality?: string; tags?: string[] }[];
      qualities?: { name: string; url: string; headers?: Record<string, string>; sourceType?: string; drm?: StreamDrm; server?: string; quality?: string; tags?: string[] }[];
      headers?: Record<string, string>;
      sourceType?: string;
      drm?: StreamDrm;
      subtitles?: TextTracks;
      startPosition?: number;
      // Exact dropdown label active when this stream was launched -- see
      // ResumeHint.linkTitle.
      linkTitle?: string;
    }
  ) => void;
}

export const TVDetailsScreen: React.FC<TVDetailsScreenProps> = ({
  item,
  onBack,
  onPlayStream,
}) => {
  const activeStoreProvider = useContentStore((state) => state.provider);
  const providerId = item?.provider || activeStoreProvider?.value || '';
  // Sizes the season/quality picker popup (see `pickerBoxDynamic` below).
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();

  // ---- Return-from-player restore -----------------------------------------
  // App.tsx unmounts this screen while the player is open, so what the
  // person had set up (dropdown selection, the episode they pressed, the
  // loaded list) has to be carried across in a module-level store -- see
  // lib/tv/detailsReturnState. Read once, synchronously, so the very first
  // render already shows the restored state (no flash of season 1 / a
  // spinner); the store itself is cleared from a mount effect below, since
  // a render-phase read has to stay repeatable.
  const restoredRef = useRef<DetailsReturnState | null | undefined>(undefined);
  if (restoredRef.current === undefined) {
    restoredRef.current = peekDetailsReturnState(item?.link, providerId) ?? null;
  }
  const restored = restoredRef.current;
  // True while focus should be steered to the restored target. Cleared as
  // soon as the person picks a different season/quality, which makes the
  // restored target moot and hands focus back to the normal default rules.
  const restoreModeRef = useRef<boolean>(Boolean(restored));
  useEffect(() => {
    clearDetailsReturnState();
  }, []);

  const [info, setInfo] = useState<Info | null>(() =>
    item?.link && providerId ? getCachedMetadata(item.link, providerId) || null : null
  );
  const [loading, setLoading] = useState(!info);
  const [error, setError] = useState<string | null>(null);
  const [extractingStreams, setExtractingStreams] = useState(false);

  const [seasonIndex, setSeasonIndex] = useState(restored?.seasonIndex ?? 0);
  const [rawEpisodes, setEpisodes] = useState<EpisodeLink[]>(restored?.rawEpisodes ?? []);
  const [episodesLoading, setEpisodesLoading] = useState(false);

  // ---- Movieboxweb: split its all-seasons-in-one-list dubs into a real
  // season picker ----------------------------------------------------------
  // Movieboxweb's dropdown normally has one entry per audio dub ("Original",
  // "Hindi", ...), and each dub's episode fetch returns *every* season
  // flattened into one list instead of a per-season one. `movieBoxSeasons`
  // holds the distinct season numbers found in that flattened list, once
  // known (null = not detected yet for this title); `linkList` below uses it
  // to expand the dropdown into one entry per dub+season ("Original S01",
  // "Original S02", "Hindi S01", ...) -- same grouping the fetched episode
  // list already sorts into, just made pickable. Provider-specific by
  // design: other providers with a similarly flattened list are left alone.
  const isMovieBoxWeb = providerId === 'movieBoxWeb';
  const [movieBoxSeasons, setMovieBoxSeasons] = useState<number[] | null>(
    restored?.movieBoxSeasons ?? null,
  );

  // This whole screen is one flat ScrollView, and the season/quality
  // picker now lives in its own Modal (see `seasonPickerVisible` below)
  // instead of an inline chip row -- so the picker itself is never
  // scrolled off-screen mid-press. Picking an option there still swaps
  // out the episode list underneath, though, and that section briefly
  // collapses to a small spinner while the new list fetches (see
  // `stillResolving` below). `scrollRef` + `episodeFocusNonce` explicitly
  // scroll the (now-reloaded) episode section into view and force a real
  // refocus onto its first/resume row once it's ready, rather than
  // relying on the page's incidental scroll position or on
  // `hasTVPreferredFocus`'s "only fires on a fresh mount" behavior (which
  // a quality switch returning the exact same episode ids/links would
  // never trigger on its own).
  const scrollRef = useRef<ScrollView | null>(null);
  // y-offset (within the ScrollView's content) of the section holding the
  // episode/source list -- captured via that section's `onLayout` below.
  // Stable across the spinner <-> loaded-list swap since it only depends
  // on the (unchanged) siblings above it, not on the section's own height.
  const listSectionYRef = useRef(0);
  // y-offset of each row within that section, by row key -- lets a return
  // from the player scroll straight to the right row even though its
  // position depends on how tall the rows above it turned out to be.
  const rowLayoutsRef = useRef<Record<string, { y: number; h: number }>>({});
  // y of the rows' wrapper within the list section, and the page ScrollView's
  // viewport / content heights -- inputs to `scrollToEpisodeRow`.
  const episodeWrapperYRef = useRef(0);
  const pageViewportHRef = useRef(0);
  const pageContentHRef = useRef(0);
  // Armed by a season/quality pick in the modal; consumed the next time
  // loading finishes (see the effect below), so an ordinary initial page
  // load (nothing picked) never triggers an unwanted scroll/refocus.
  const pendingEpisodeFocusRef = useRef(false);
  // True when the list below is the horizontal episode row (as opposed to a
  // vertical server/quality list). Kept in a ref so the mount-only restore
  // pass and the focus effects can read the current value.
  const horizontalListRef = useRef(false);
  // y of the director / cast section inside the page ScrollView.
  const creditsYRef = useRef(0);
  // Bumped to force exactly the target episode/source row (index 0, or
  // the resume target) to remount -- same "nonce in the key" trick used
  // for programmatic focus elsewhere in this app (TVNavigationRail,
  // TVDiscoverScreen), since plain React Native doesn't wire up a real
  // `ref.focus()` for arbitrary Views on Android.
  const [episodeFocusNonce, setEpisodeFocusNonce] = useState(0);
  // Controls the season/quality picker modal.
  const [seasonPickerVisible, setSeasonPickerVisible] = useState(false);

  // Cinemeta enrichment -- canonical title, logo, 16:9 backdrop, cast,
  // runtime, genres and, for series, per-episode names/stills/synopses/
  // release dates (the provider's own data almost never has these).
  // Resolved by the provider's IMDb id when it gave one, otherwise by
  // matching its title the same way Discover does -- see
  // `resolveCinemetaMeta`. `cinemetaSettled` flips once that lookup is
  // finished (match or not) so a return from the player knows whether it
  // can trust the restored result as final.
  const [cinemetaMeta, setCinemetaMeta] = useState<CinemetaMeta | null>(restored?.cinemeta ?? null);
  const [cinemetaSettled, setCinemetaSettled] = useState<boolean>(restored?.cinemetaSettled ?? false);
  const [logoFailed, setLogoFailed] = useState(false);
  const [logoAspect, setLogoAspect] = useState<number | null>(null);

  // When the default player is set to something other than the inbuilt
  // one, `resolveAndPlay` stops short of launching anything and instead
  // populates this so the person can pick which resolved server to open
  // externally -- mirroring the mobile app's SeasonList server-picker
  // modal instead of blindly handing off `streams[0]`.
  const [serverPicker, setServerPicker] = useState<{
    title: string;
    player: PlayerChoice;
    options: { name: string; detail?: string; size?: string; url: string; headers?: Record<string, string> }[];
    // Set for the in-app picker (Stremio addons): plays the chosen option
    // in the built-in player instead of handing it to an external one.
    onSelect?: (index: number) => void;
  } | null>(null);

  const resumeHint: ResumeHint | undefined = item?.resumeHint;

  // 1. Fetch real metadata (title/synopsis/image/linkList) for this title.
  //    If the home screen already warmed the cache for this title while it
  //    was focused, this resolves instantly and never shows a spinner.
  const itemKey = `${providerId}::${item?.link ?? ''}`;
  const initialItemKeyRef = useRef(itemKey);
  useEffect(() => {
    let isMounted = true;

    // The dropdown goes back to its first entry only when a *different*
    // title is loaded into this screen -- not on the first load, which
    // may be a return from the player with a selection to keep.
    const resetSeasonIfNewItem = () => {
      if (initialItemKeyRef.current !== itemKey) {
        initialItemKeyRef.current = itemKey;
        setSeasonIndex(0);
        setMovieBoxSeasons(null);
      }
    };

    async function fetchMetadata() {
      if (!providerId || !item?.link) {
        setError('No active provider found for this media');
        setLoading(false);
        return;
      }

      const cached = getCachedMetadata(item.link, providerId);
      if (cached) {
        setInfo(cached);
        resetSeasonIfNewItem();
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);
      try {
        const res = await getOrFetchMetadata(item.link, providerId);
        if (isMounted) {
          setInfo(res);
          resetSeasonIfNewItem();
        }
      } catch (err: any) {
        console.warn('[TVDetailsScreen] getMetaData error:', err);
        if (isMounted) setError(err?.message || 'Failed to load details');
      } finally {
        if (isMounted) setLoading(false);
      }
    }

    fetchMetadata();
    return () => {
      isMounted = false;
    };
  }, [item, providerId, itemKey]);

  // Start the Cinemeta search (and pull the best hits' full meta) as soon as
  // the screen opens, using the title of the post that was clicked, instead
  // of waiting for the provider's details request to finish first. Without
  // this the episode names/synopses trailed the episode list by a full
  // search -> meta round trip after the provider had already answered.
  // Purely a cache warm-up; the resolve effect below still does the real
  // (and, by then, near-instant) lookup.
  useEffect(() => {
    if (restored?.cinemetaSettled) return;
    const postTitle = item?.title;
    if (postTitle) prewarmCinemetaForTitle(postTitle, item?.type);
  }, [item?.title, item?.type]);

  // Release year handed over outside the title text -- most providers put
  // it in `tags` (e.g. MovieBox Web: [country, year, ...genres]). Used to
  // tell same-titled shows apart when the scraped title carries no year.
  const providerYear = useMemo(
    () =>
      (info?.tags || [])
        .map((t) => String(t).trim())
        .find((t) => /^(19|20)\d{2}$/.test(t)),
    [info?.tags],
  );

  // Resolve the Cinemeta meta for this title once real metadata is in.
  const hasEpisodesLinkAnywhere = (info?.linkList || []).some((l) => Boolean(l?.episodesLink));
  const hasInfo = Boolean(info);
  // True only for the first run after a return from the player whose
  // lookup had already finished: keep the restored result instead of
  // blanking it and re-resolving, so the first layout matches the one the
  // person left (no blank -> refetch -> grow) -- same idea as Discover's
  // `restoredCinemetaRef`.
  const keepRestoredCinemetaRef = useRef<boolean>(Boolean(restored?.cinemetaSettled));
  useEffect(() => {
    let isMounted = true;
    if (keepRestoredCinemetaRef.current && info) {
      keepRestoredCinemetaRef.current = false;
      return () => {
        isMounted = false;
      };
    }

    setCinemetaMeta(null);
    setCinemetaSettled(false);
    const providerTitle = info?.title || item?.title;
    if (!info || !providerTitle) {
      return () => {
        isMounted = false;
      };
    }

    resolveCinemetaMeta({
      imdbId: info.imdbId,
      tmdbId: info.tmdbId,
      populateMeta: info.populateMeta,
      // Season links are the one reliable sign of a show, whatever `type`
      // the provider left at its default.
      type: hasEpisodesLinkAnywhere ? 'series' : info.type,
      title: providerTitle,
      year: providerYear,
      // Scraped titles like "The Boys [Hindi] S1-S5" carry no year and
      // several same-named shows exist; fall back to Cinemeta's top-ranked
      // series instead of leaving every episode unnamed.
      preferTopRanked: true,
    })
      .then((result) => {
        if (!isMounted) return;
        setCinemetaMeta(result?.meta ?? null);
        setCinemetaSettled(true);
      })
      .catch(() => {
        if (isMounted) setCinemetaSettled(true);
      });

    return () => {
      isMounted = false;
    };
  }, [
    info?.imdbId,
    info?.tmdbId,
    info?.populateMeta,
    info?.type,
    info?.title,
    item?.title,
    providerYear,
    hasEpisodesLinkAnywhere,
    hasInfo,
  ]);

  const excludedQualities = useMemo(
    () => settingsStorage.getExcludedQualities() || [],
    [],
  );

  // Filter season/quality tabs against excluded settings -- falls back to
  // the unfiltered list if every entry would otherwise be excluded, so
  // there's always something pickable.
  const rawLinkList: Link[] = info?.linkList || [];
  const dubLinkList: Link[] = useMemo(() => {
    if (!excludedQualities.length) return rawLinkList;
    const filtered = rawLinkList.filter(
      (l) =>
        !isQualityExcluded(l?.quality, excludedQualities) &&
        !isQualityExcluded(l?.title, excludedQualities),
    );
    return filtered.length > 0 ? filtered : rawLinkList;
  }, [rawLinkList, excludedQualities]);
  // Movieboxweb only, and only once a flattened multi-season list has
  // actually been detected (see the effect below) -- expands each dub entry
  // into one per season it contains, in "<dub> S01, <dub> S02, ..." order,
  // dub by dub. Every other provider (and a single-season Movieboxweb show)
  // passes `dubLinkList` straight through unchanged.
  const linkList: (Link & { __movieBoxSeason?: number })[] = useMemo(() => {
    if (!isMovieBoxWeb || !movieBoxSeasons || movieBoxSeasons.length <= 1) return dubLinkList;
    const expanded: (Link & { __movieBoxSeason?: number })[] = [];
    for (const dub of dubLinkList) {
      if (!dub.episodesLink) {
        expanded.push(dub);
        continue;
      }
      for (const season of movieBoxSeasons) {
        expanded.push({
          ...dub,
          title: `${dub.title} S${String(season).padStart(2, '0')}`,
          __movieBoxSeason: season,
        });
      }
    }
    return expanded;
  }, [dubLinkList, isMovieBoxWeb, movieBoxSeasons]);
  // A restored selection can only be out of range if the provider's list
  // changed underneath us -- fall back to the last entry rather than none.
  const activeIndex = Math.min(seasonIndex, Math.max(linkList.length - 1, 0));
  const activeLink = linkList[activeIndex];
  const hasEpisodesLink = !!activeLink?.episodesLink;

  // Detects Movieboxweb's flattened multi-season list the first time a dub's
  // episodes come back, and expands the dropdown above accordingly. Runs
  // once per title (guarded by `movieBoxSeasons !== null`) -- switching dubs
  // afterwards reuses the already-known season count instead of
  // re-detecting. On a fresh (non-restored) detection, nudges `seasonIndex`
  // from "dub index" to "that dub's first season" so the list expanding
  // underneath doesn't leave the picker pointing at an unrelated entry; a
  // restored session already has a seasonIndex scaled for the expanded list,
  // so it's left untouched.
  useEffect(() => {
    if (!isMovieBoxWeb || movieBoxSeasons !== null || rawEpisodes.length === 0) return;
    const seasons = Array.from(
      new Set(rawEpisodes.map((ep) => parseSeasonNumber(ep.title) ?? 1)),
    ).sort((a, b) => a - b);
    setMovieBoxSeasons(seasons);
    if (seasons.length > 1 && !restored) {
      setSeasonIndex((prev) => prev * seasons.length);
    }
  }, [isMovieBoxWeb, movieBoxSeasons, rawEpisodes, restored]);

  // Only the episodes for the currently-picked season, when the active
  // dropdown entry is one of Movieboxweb's expanded per-season virtual
  // entries; every other case (including plain Movieboxweb before
  // expansion) passes the fetched list straight through.
  const seasonFilteredEpisodes = useMemo(() => {
    const season = activeLink?.__movieBoxSeason;
    if (season == null) {
      // Movieboxweb returns every season in one list (20 seasons can be
      // 2000+ rows). Until the per-season split is detected (next effect),
      // show only the first season instead of mounting every row twice.
      if (isMovieBoxWeb && movieBoxSeasons === null && rawEpisodes.length > 0) {
        let first = Infinity;
        for (const ep of rawEpisodes) {
          const n = parseSeasonNumber(ep.title) ?? 1;
          if (n < first) first = n;
        }
        return rawEpisodes.filter((ep) => (parseSeasonNumber(ep.title) ?? 1) === first);
      }
      return rawEpisodes;
    }
    return rawEpisodes.filter((ep) => (parseSeasonNumber(ep.title) ?? 1) === season);
  }, [rawEpisodes, activeLink, isMovieBoxWeb, movieBoxSeasons]);

  // Ready to trust `linkList` for a one-time resume-hint match below: either
  // this isn't a Movieboxweb series at all (nothing to expand), or the
  // expansion above has already run.
  const linkListReady = !isMovieBoxWeb || !hasEpisodesLinkAnywhere || movieBoxSeasons !== null;
  // Applies at most once per mount: if this screen was opened from Continue
  // Watching (not a return-from-player restore, which already knows its own
  // seasonIndex), land the dropdown on the exact entry that episode was
  // played from -- see ResumeHint.linkTitle.
  const resumeLinkAppliedRef = useRef(false);
  useEffect(() => {
    if (resumeLinkAppliedRef.current || !linkListReady) return;
    resumeLinkAppliedRef.current = true;
    if (restored || !resumeHint?.linkTitle) return;
    const idx = linkList.findIndex((l) => l.title === resumeHint.linkTitle);
    if (idx >= 0) setSeasonIndex(idx);
  }, [linkList, linkListReady, resumeHint?.linkTitle, restored]);

  // 2. Once we know which season/link is selected, fetch its episode list
  //    (series) -- movies use `directLinks` directly, no extra fetch needed.
  const keepRestoredEpisodesRef = useRef<boolean>(Boolean(restored && restored.rawEpisodes.length > 0));
  useEffect(() => {
    let isMounted = true;

    async function fetchEpisodes() {
      if (!hasEpisodesLink || !activeLink?.episodesLink) {
        setEpisodes([]);
        return;
      }
      setEpisodesLoading(true);
      try {
        const eps = await providerManager.getEpisodes({
          url: activeLink.episodesLink,
          providerValue: providerId,
        });
        // Some sources list episodes newest-first (or otherwise out of
        // order) -- re-sort chronologically so the grid, the resume/next-
        // episode index, and the Cinemeta lookup below all agree on which
        // entry is "episode 1".
        if (isMounted) setEpisodes(sortEpisodesChronologically(eps || []));
      } catch (err) {
        console.warn('[TVDetailsScreen] getEpisodes error:', err);
        if (isMounted) setEpisodes([]);
      } finally {
        if (isMounted) setEpisodesLoading(false);
      }
    }

    // Returning from the player: the list was restored with the rest of
    // the saved state and nothing it depends on has changed, so skip the
    // re-fetch. Re-fetching swaps the list for a "Loading episodes..." row,
    // which unmounts the very card that is supposed to get focus back.
    if (keepRestoredEpisodesRef.current) {
      keepRestoredEpisodesRef.current = false;
      if (rawEpisodes.length > 0) {
        return () => {
          isMounted = false;
        };
      }
    }

    fetchEpisodes();
    return () => {
      isMounted = false;
    };
  }, [activeLink?.episodesLink, hasEpisodesLink, providerId]);

  const directItems = activeLink?.directLinks || [];

  // Filter fetched episodes/direct-links against excluded settings -- a
  // few providers tag quality directly on the episode/source title (e.g.
  // "Episode 5 [1080p]"), so check both a `quality` field (if the source
  // sets one) and the title text. Falls back to the unfiltered list if
  // everything would otherwise be excluded.
  const episodes: EpisodeLink[] = useMemo(() => {
    if (!excludedQualities.length) return seasonFilteredEpisodes;
    const filtered = seasonFilteredEpisodes.filter(
      (ep: any) =>
        !isQualityExcluded(ep?.quality, excludedQualities) &&
        !isQualityExcluded(ep?.title, excludedQualities),
    );
    return filtered.length > 0 ? filtered : seasonFilteredEpisodes;
  }, [seasonFilteredEpisodes, excludedQualities]);

  // Providers without a TMDB/IMDb id often can't group a show into proper
  // season tabs + an `episodesLink` fetch, so each episode ends up as a flat
  // "direct link" entry instead of going through a real episode list.
  // Whether that flat list is actually a set of distinct episodes (needing
  // per-item resume matching) or just several servers/qualities for one
  // movie (where every entry legitimately shares the same resume badge)
  // can't be read off `d.type` alone -- most providers never bother setting
  // it. `info.type` is set from basic scraping regardless of TMDB/IMDb
  // enrichment, so -- matching the convention already used elsewhere in
  // this app (TVInfoScreen, TVDiscoverScreen) -- treat anything not
  // explicitly `'movie'` as episodes. Computed off the raw `directItems`
  // (not the filtered/sorted list below) so it isn't affected by either.
  const directItemsAreEpisodes =
    directItems.some((d) => d.type === 'series') || (info?.type || 'series') !== 'movie';

  // Some providers (e.g. 4khdhub) never expose a real `episodesLink` at
  // all -- every episode of a season is scraped straight into this link's
  // `directLinks`, in whatever order the page lists them (often
  // newest-first). Discover already re-sorts this exact flat list with
  // `sortEpisodesChronologically`; do the same here so a season shows
  // S01E01 -> S01E02 -> ... regardless of provider order, matching the
  // real per-season `episodes` list above. Only applies when these direct
  // links actually represent distinct episodes -- a flat list of
  // servers/qualities for a single movie is left in the provider's own
  // order.
  const sortedDirectItems = useMemo(
    () => (directItemsAreEpisodes ? sortEpisodesChronologically(directItems) : directItems),
    [directItems, directItemsAreEpisodes],
  );

  const usableDirectItems = useMemo(() => {
    if (!excludedQualities.length) return sortedDirectItems;
    const filtered = sortedDirectItems.filter(
      (d: any) =>
        !isQualityExcluded(d?.title, excludedQualities) &&
        !isQualityExcluded(d?.quality, excludedQualities),
    );
    return filtered.length > 0 ? filtered : sortedDirectItems;
  }, [sortedDirectItems, excludedQualities]);

  // Closes the race that caused a "flash" of the wrong screen: there is one
  // render frame after `getMetaData` resolves but before the episodes
  // effect has had a chance to flip `episodesLoading` to true, during which
  // `episodes` is still `[]`. Without this derived check, that single frame
  // fell through to the movie "Play Stream" button before snapping to the
  // real episode list a moment later.
  const isAwaitingEpisodes = hasEpisodesLink && episodes.length === 0 && !error;
  const stillResolving = loading || isAwaitingEpisodes || episodesLoading || extractingStreams;

  // Consumes the flag a season/quality chip press armed, once the new
  // list has actually finished loading (`stillResolving` back to false):
  // scroll the (now correctly laid out) episode/source section into view,
  // then force a real refocus onto its target row a beat later. Both
  // steps happen every time a chip is pressed, not just when a scroll or
  // a fresh mount would have handled it on their own -- see the comment
  // by `scrollRef` above for why neither can be relied on alone.
  useEffect(() => {
    if (stillResolving) return;
    if (!pendingEpisodeFocusRef.current) return;
    pendingEpisodeFocusRef.current = false;
    // The horizontal episode row is always fully on screen at the top of the
    // page; a vertical source list still scrolls to its section.
    scrollRef.current?.scrollTo({
      x: 0,
      y: horizontalListRef.current ? 0 : Math.max(listSectionYRef.current - 16, 0),
      animated: false,
    });
    setTimeout(() => setEpisodeFocusNonce((n) => n + 1), 60);
  }, [stillResolving]);

  // ---- Episode / source rows -----------------------------------------------
  // Prefer real season/episode numbers parsed from the source's own labels
  // (handles S01/s1/Season01/Season 1 etc. on the season entry, and
  // E12/Episode 12/leading "12." etc. on the episode title); fall back to
  // positional order only when a number genuinely can't be found. The file
  // size token is stripped first so "1.4GB" can't be mistaken for episode 1.
  const seasonNumber = parseSeasonNumber(activeLink?.title) ?? activeIndex + 1;
  const episodeNumberFor = (title: string | undefined, index: number): number =>
    parseEpisodeNumber(stripFileSize(title)) ?? index + 1;
  // Some providers (e.g. one that lists every season's episodes in a single
  // flattened call) never expose separate per-season tabs -- every episode
  // instead carries its own "S01 E01" / "S02 E01" style title. For those,
  // trust the number in the episode's own title over the tab-level guess
  // above; otherwise two different episodes (say S01E01 and S02E01) would
  // both get forced onto the same `seasonNumber` and render as the exact
  // same "S01E01" label, looking like the same episode listed twice.
  const seasonNumberFor = (title: string | undefined): number =>
    parseSeasonNumber(title) ?? seasonNumber;

  // Episode payload actually handed to TVPlayerScreen -- same list as
  // `episodes` above, but enriched with each episode's real season/episode
  // number plus Cinemeta's name/still/synopsis/release date (falling back
  // to whatever the provider itself returned). Powers the player's
  // "Videos" episode picker and "Up Next" popup. Mirrors what Discover
  // hands the player, so both entry points look the same there.
  const playerEpisodes: EpisodeLink[] = useMemo(() => {
    return episodes.map((ep, index) => {
      const episodeNum = parseEpisodeNumber(stripFileSize(ep.title)) ?? index + 1;
      const epSeasonNumber = seasonNumberFor(ep.title);
      const cinemetaEp = findCinemetaEpisode(cinemetaMeta, epSeasonNumber, episodeNum);
      return {
        ...ep,
        // Real episode name (Cinemeta) over the provider's own bare/numeric
        // label -- feeds the player's "Videos" list and "Up Next" popup.
        title: cinemetaEp?.name || cinemetaEp?.title || ep.title || `Episode ${index + 1}`,
        image: cinemetaEp?.thumbnail || ep.image,
        synopsis: ep.description || cinemetaEp?.overview,
        season: epSeasonNumber,
        episodeNumber: episodeNum,
        releaseDate: formatEpisodeReleaseDate(cinemetaEp?.released),
      } as EpisodeLink & { synopsis?: string; season?: number; episodeNumber?: number; releaseDate?: string };
    });
  }, [episodes, cinemetaMeta, seasonNumber]);

  // ---- Director / cast + per-episode runtime & rating ------------------------
  // Photos: Cinemeta's own `app_extras` (no key needed) when it carries them,
  // otherwise TMDB credits (needs a TMDB key -- the same one the rest of the
  // app uses). Episode runtime / rating come from TMDB season data when
  // available; Cinemeta's per-episode rating (IMDb) wins when it has one.
  const isSeriesTitle = hasEpisodesLinkAnywhere || directItemsAreEpisodes;
  const [tmdbIdentity, setTmdbIdentity] = useState<TmdbIdentityLite | null>(null);
  const [tmdbCredits, setTmdbCredits] = useState<TmdbCredits | null>(null);
  // The resume / up-next pill has D-pad focus: it then shows its full text and
  // the season / quality picker beside it shrinks to make room.
  const [resumeFocused, setResumeFocused] = useState(false);
  const [tmdbEpisodeInfo, setTmdbEpisodeInfo] = useState<Record<string, TmdbEpisodeInfo>>({});
  const [tmdbRating, setTmdbRating] = useState<string | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    if (!info || !cinemetaSettled || !getTmdbApiKey()) {
      return () => {
        alive = false;
      };
    }
    resolveTmdbIdentityLite({
      tmdbId: info.tmdbId || cinemetaMeta?.moviedb_id,
      imdbId: info.imdbId || cinemetaMeta?.imdb_id,
      title: cinemetaMeta?.name || info.title || item?.title,
      year: providerYear,
      kind: isSeriesTitle ? 'series' : 'movie',
    }).then((identity) => {
      if (alive && identity) setTmdbIdentity(identity);
    });
    return () => {
      alive = false;
    };
  }, [
    info?.tmdbId,
    info?.imdbId,
    info?.title,
    item?.title,
    cinemetaMeta?.moviedb_id,
    cinemetaMeta?.imdb_id,
    cinemetaMeta?.name,
    providerYear,
    isSeriesTitle,
    cinemetaSettled,
  ]);

  // Title-level rating from TMDB, only used when nothing else supplied one.
  useEffect(() => {
    let alive = true;
    setTmdbRating(undefined);
    if (!tmdbIdentity) {
      return () => {
        alive = false;
      };
    }
    fetchTmdbRating(tmdbIdentity).then((value) => {
      if (alive) setTmdbRating(value);
    });
    return () => {
      alive = false;
    };
  }, [tmdbIdentity?.tmdbId, tmdbIdentity?.mediaType]);

  // Credits row: one horizontal strip (directors / creators, then
  // cast). Its own scrolling is off; focusing a person scrolls it.
  const { width: creditsWidth } = useWindowDimensions();
  const creditsScrollRef = useRef<ScrollView | null>(null);
  const creditsOffsetRef = useRef(0);
  const creditLayoutsRef = useRef<Record<string, { x: number; w: number }>>({});

  const cinemetaCredits: TmdbCredits = useMemo(() => {
    const extras = (cinemetaMeta as any)?.app_extras;
    const toPerson = (p: any, fallbackRole?: string): CreditPerson | null =>
      p && typeof p.name === 'string' && p.name.trim()
        ? {
            id: p.id,
            name: p.name.trim(),
            role: (typeof p.character === 'string' && p.character.trim()) || fallbackRole,
            photo: typeof p.photo === 'string' && p.photo ? p.photo : undefined,
          }
        : null;
    // Cinemeta's `director` field lists directors, never series creators, so
    // they are labelled as directors even for a series. (Real creators come
    // from TMDB's `created_by`, below.)
    const directorRole = 'Director';
    let cast = (Array.isArray(extras?.cast) ? extras.cast : [])
      .map((p: any) => toPerson(p))
      .filter(Boolean) as CreditPerson[];
    let directors = (Array.isArray(extras?.directors) ? extras.directors : [])
      .map((p: any) => toPerson(p, directorRole))
      .filter(Boolean) as CreditPerson[];
    // No structured credits: names only (initials stand in for photos).
    if (cast.length === 0) {
      const names: string[] = cinemetaMeta?.cast?.length ? cinemetaMeta.cast : info?.cast || [];
      cast = names.filter(Boolean).map((name) => ({ name }));
    }
    if (directors.length === 0) {
      const raw = (cinemetaMeta as any)?.director;
      const names: string[] = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
      directors = names.filter(Boolean).map((name) => ({ name, role: directorRole }));
    }
    return { directors: directors.slice(0, 2), writers: [], cast: cast.slice(0, 15) };
  }, [cinemetaMeta, info?.cast]);

  useEffect(() => {
    let alive = true;
    setTmdbCredits(null);
    if (!tmdbIdentity) {
      return () => {
        alive = false;
      };
    }
    fetchTmdbCredits(tmdbIdentity, 15).then((result) => {
      if (alive) setTmdbCredits(result);
    });
    return () => {
      alive = false;
    };
  }, [tmdbIdentity?.tmdbId, tmdbIdentity?.mediaType]);

  const credits: TmdbCredits = useMemo(
    () => ({
      directors: (tmdbCredits?.directors.length ? tmdbCredits.directors : cinemetaCredits.directors).slice(0, 2),
      writers: [],
      cast: (tmdbCredits?.cast.length ? tmdbCredits.cast : cinemetaCredits.cast).slice(0, 15),
    }),
    [tmdbCredits, cinemetaCredits],
  );

  // Season numbers present in the current list (usually exactly one).
  const seasonsKey = useMemo(() => {
    const set = new Set<number>();
    if (episodes.length > 0) episodes.forEach((ep) => set.add(seasonNumberFor(ep.title)));
    else if (directItemsAreEpisodes) usableDirectItems.forEach((d) => set.add(seasonNumberFor(d.title)));
    return Array.from(set)
      .filter((n) => Number.isFinite(n) && n >= 0)
      .sort((a, b) => a - b)
      .slice(0, 8)
      .join(',');
  }, [episodes, usableDirectItems, directItemsAreEpisodes, seasonNumber]);

  useEffect(() => {
    if (!tmdbIdentity || tmdbIdentity.mediaType !== 'tv' || !seasonsKey) return;
    let alive = true;
    const tmdbId = tmdbIdentity.tmdbId;
    Promise.all(
      seasonsKey
        .split(',')
        .map(Number)
        .map((season) => fetchTmdbSeasonEpisodes(tmdbId, season).then((map) => ({ season, map }))),
    ).then((list) => {
      if (!alive) return;
      setTmdbEpisodeInfo((prev) => {
        const next = { ...prev };
        list.forEach(({ season, map }) => {
          Object.entries(map).forEach(([ep, value]) => {
            next[`${tmdbId}:${season}:${ep}`] = value;
          });
        });
        return next;
      });
    });
    return () => {
      alive = false;
    };
  }, [tmdbIdentity?.tmdbId, tmdbIdentity?.mediaType, seasonsKey]);

  const rows: DetailRow[] = useMemo(() => {
    const hasResumeIdentity = Boolean(resumeHint?.episodeKey || resumeHint?.episodeLink);
    const seenKeys = new Set<string>();
    // Two entries parsing to the same episode number (e.g. one per quality)
    // must still get distinct focus keys.
    const uniqueKey = (base: string, index: number): string => {
      const key = seenKeys.has(base) ? `${base}#${index}` : base;
      seenKeys.add(key);
      return key;
    };
    const cleanLabel = (title: string | undefined, sizeLabel: string | undefined): string =>
      sizeLabel ? stripFileSize(title) || title || '' : title || '';
    // TMDB's data for one episode (still, synopsis, runtime, ...) -- fills
    // whatever Cinemeta / the provider left out.
    const tmdbEpisodeFor = (epSeason: number, epNum: number): TmdbEpisodeInfo | undefined =>
      tmdbIdentity ? tmdbEpisodeInfo[`${tmdbIdentity.tmdbId}:${epSeason}:${epNum}`] : undefined;
    // Everything the horizontal episode card shows beyond the basics.
    const episodeExtras = (
      cinemetaEp: any,
      epSeason: number,
      epNum: number,
      providerTitle: string | undefined,
      sizeLabel: string | undefined,
    ) => {
      const cleaned = cleanLabel(providerTitle, sizeLabel);
      const tmdbInfo = tmdbEpisodeFor(epSeason, epNum);
      const cinemetaRating = parseFloat(String(cinemetaEp?.rating ?? ''));
      let ratingLabel: string | undefined;
      let ratingSource: 'IMDb' | 'TMDB' | undefined;
      if (Number.isFinite(cinemetaRating) && cinemetaRating > 0) {
        ratingLabel = cinemetaRating.toFixed(1);
        ratingSource = 'IMDb';
      } else if (tmdbInfo?.rating) {
        ratingLabel = tmdbInfo.rating.toFixed(1);
        ratingSource = 'TMDB';
      }
      return {
        episodeNumber: epNum,
        cardTitle:
          cinemetaEp?.name ||
          cinemetaEp?.title ||
          (cleaned && !isBareEpisodeLabel(cleaned) ? cleaned : tmdbInfo?.name || `Episode ${epNum}`),

        runtimeLabel: formatMinutes(tmdbInfo?.runtime ?? parseRuntimeMinutes(cinemetaMeta?.runtime)),
        ratingLabel,
        ratingSource,
      };
    };

    // Real per-season episode list.
    if (episodes.length > 0) {
      return episodes.map((ep, index): DetailRow => {
        const episodeNum = parseEpisodeNumber(stripFileSize(ep.title)) ?? index + 1;
        const epSeasonNumber = seasonNumberFor(ep.title);
        const stableKey = `S${epSeasonNumber}E${episodeNum}`;
        const cinemetaEp = findCinemetaEpisode(cinemetaMeta, epSeasonNumber, episodeNum);
        const sizeLabel = getFileSizeLabel(ep);
        // Stable key match is authoritative; raw link match is only a
        // fallback for continue-watching entries saved before this key
        // existed.
        const isResumeTarget = resumeHint?.episodeKey
          ? resumeHint.episodeKey === stableKey
          : !!resumeHint?.episodeLink && ep.link === resumeHint.episodeLink;
        return {
          key: uniqueKey(episodeRowKey(stableKey), index),
          index,
          link: ep.link,
          isEpisode: true,
          stableKey,
          title: formatEpisodeLabel(
            epSeasonNumber,
            episodeNum,
            cinemetaEp?.name || cinemetaEp?.title || cleanLabel(ep.title, sizeLabel),
            `Episode ${index + 1}`,
          ),
          // Cinemeta's per-episode still is the real image for that
          // episode; providers without a TMDB/IMDb id typically only ever
          // return the show's own poster for every episode. Same
          // precedence as Discover.
          // Cinemeta first, then TMDB's still / synopsis, and only then
          // the provider's own (often just the show poster).
          thumb: cinemetaEp?.thumbnail || tmdbEpisodeFor(epSeasonNumber, episodeNum)?.still || ep.image,
          overview: ep.description || cinemetaEp?.overview || tmdbEpisodeFor(epSeasonNumber, episodeNum)?.overview,
          releaseDate: formatEpisodeReleaseDate(cinemetaEp?.released),
          sizeLabel,
          ...episodeExtras(cinemetaEp, epSeasonNumber, episodeNum, ep.title, sizeLabel),
          isResumeTarget,
          isDefaultFocus: hasResumeIdentity ? isResumeTarget : index === 0,
          playTitle: info?.title || item?.title || ep.title || `Episode ${index + 1}`,
          playType: 'series',
        };
      });
    }

    // Flat direct-link list. A season/quality pick with only one direct
    // link is still a proper episode row (not a "movie") whenever the
    // overall title is a series -- e.g. a season whose only episode
    // released so far is S02E01. Only fall through to the single-source
    // "Play Movie / Stream" button below when this really is a movie.
    if (usableDirectItems.length > 1 || (usableDirectItems.length === 1 && directItemsAreEpisodes)) {
      const episodesForPlayer: EpisodeLink[] | undefined = directItemsAreEpisodes
        ? usableDirectItems.map((d: DirectLink, index) => {
            const episodeNum = episodeNumberFor(d.title, index);
            const epSeasonNumber = seasonNumberFor(d.title);
            const cinemetaEp = findCinemetaEpisode(cinemetaMeta, epSeasonNumber, episodeNum);
            return {
              title: cinemetaEp?.name || cinemetaEp?.title || d.title,
              link: d.link,
              description: d.description,
              image: cinemetaEp?.thumbnail || d.image,
              synopsis: d.description || cinemetaEp?.overview,
              season: epSeasonNumber,
              episodeNumber: episodeNum,
              releaseDate: formatEpisodeReleaseDate(cinemetaEp?.released),
              quickDownload: d.quickDownload,
              skip: d.skip,
            } as EpisodeLink & { synopsis?: string; season?: number; episodeNumber?: number; releaseDate?: string };
          })
        : undefined;

      return usableDirectItems.map((d: DirectLink, index): DetailRow => {
        const episodeNum = episodeNumberFor(d.title, index);
        const epSeasonNumber = seasonNumberFor(d.title);
        const cinemetaEp = directItemsAreEpisodes
          ? findCinemetaEpisode(cinemetaMeta, epSeasonNumber, episodeNum)
          : null;
        const stableKey = directItemsAreEpisodes ? `S${epSeasonNumber}E${episodeNum}` : undefined;
        const sizeLabel = getFileSizeLabel(d);
        const isResumeTarget = stableKey
          ? resumeHint?.episodeKey
            ? resumeHint.episodeKey === stableKey
            : !!resumeHint?.episodeLink && d.link === resumeHint.episodeLink
          : true;
        const baseTitle = cleanLabel(d.title, sizeLabel);
        return {
          key: stableKey ? uniqueKey(episodeRowKey(stableKey), index) : sourceRowKey(index),
          index,
          link: d.link,
          isEpisode: directItemsAreEpisodes,
          stableKey,
          title: directItemsAreEpisodes
            ? formatEpisodeLabel(
                epSeasonNumber,
                episodeNum,
                cinemetaEp?.name || cinemetaEp?.title || baseTitle,
                `Episode ${index + 1}`,
              )
            : baseTitle || `Source ${index + 1}`,
          thumb: directItemsAreEpisodes
            ? cinemetaEp?.thumbnail || tmdbEpisodeFor(epSeasonNumber, episodeNum)?.still || d.image
            : undefined,
          overview: directItemsAreEpisodes
            ? d.description || cinemetaEp?.overview || tmdbEpisodeFor(epSeasonNumber, episodeNum)?.overview
            : undefined,
          releaseDate: directItemsAreEpisodes ? formatEpisodeReleaseDate(cinemetaEp?.released) : undefined,
          sizeLabel,
          ...(directItemsAreEpisodes
            ? episodeExtras(cinemetaEp, epSeasonNumber, episodeNum, d.title, sizeLabel)
            : {}),
          isResumeTarget,
          isDefaultFocus: directItemsAreEpisodes && hasResumeIdentity ? isResumeTarget : index === 0,
          playTitle: info?.title || item?.title,
          playType: d.type || info?.type || 'movie',
          episodesOverride: episodesForPlayer,
        };
      });
    }

    return [];
  }, [
    episodes,
    usableDirectItems,
    cinemetaMeta,
    seasonNumber,
    directItemsAreEpisodes,
    resumeHint,
    info?.title,
    info?.type,
    item?.title,
    tmdbEpisodeInfo,
    tmdbIdentity?.tmdbId,
  ]);

  const resolveAndPlay = useCallback(
    async (
      link: string,
      streamTitle: string,
      type: string,
      episodeIdx: number = 0,
      episodeKey?: string,
      // Overrides the component-level `episodes` state (populated only via
      // the `episodesLink` fetch) with a caller-supplied list. The flat
      // "Select Source" list below is itself the episode list for shows
      // whose provider never exposed a proper `episodesLink` -- without
      // this, TVPlayerScreen falls back to an empty episode array, which
      // is exactly what stops it from ever saving a matchable per-episode
      // link/key (see `syncProgressToStore`), and *that*, not just the
      // rendering below, is what let every entry appear as "the" resume
      // target.
      episodesOverride?: EpisodeLink[],
      // Focus key of the row that was pressed -- remembered so returning
      // from the player can put focus back on it.
      rowKey?: string,
    ) => {
      if (!providerId || !link) {
        ToastAndroid.show('No active provider found for this media', ToastAndroid.SHORT);
        return;
      }

      setExtractingStreams(true);
      try {
        const rawStreams = await providerManager.getStream({
          link,
          type,
          providerValue: providerId,
        });

        if (!rawStreams || rawStreams.length === 0) {
          ToastAndroid.show('No valid stream links found from this source.', ToastAndroid.LONG);
          return;
        }

        // Filter out qualities excluded in Settings -- falls back to the
        // unfiltered list if every stream would otherwise be excluded, so
        // playback never dead-ends.
        const filteredStreams = rawStreams.filter(
          (s) =>
            !isQualityExcluded(s?.quality, excludedQualities) &&
            !isQualityExcluded(s?.server, excludedQualities),
        );
        const streams = filteredStreams.length > 0 ? filteredStreams : rawStreams;

        // Resume matching: a series episode is only the one continue-
        // watching was tracking if its *stable* season/episode key matches
        // (raw provider links can differ across quality picks or separate
        // fetches even for the exact same episode, so they're only used as
        // a fallback for entries saved before this key existed). A movie
        // has nothing else to disambiguate -- if we got here with a
        // resumeHint at all, this *is* the title it's for, regardless of
        // which quality/source was just picked.
        const isSeriesEpisode = !!episodeKey;
        const startPosition = isSeriesEpisode
          ? resumeHint?.episodeKey === episodeKey ||
            (resumeHint?.episodeLink && resumeHint.episodeLink === link)
            ? resumeHint?.position
            : undefined
          : resumeHint?.position;

        const playerPref = settingsStorage.getDefaultPlayer();
        // DRM-protected streams (ClearKey/Widevine) can only be played by the
        // built-in player, so external players are skipped for them.
        if (playerPref !== 'exo' && !streams.every((s) => s.drm)) {
          // Mirrors the mobile app's SeasonList server-picker modal: show
          // every resolved server/quality and let the person choose which
          // one actually gets handed off to the external player, instead
          // of silently always using `streams[0]` (which is frequently
          // the one most likely to be dead/rate-limited).
          setServerPicker({
            title: streamTitle,
            player: toPlayerChoice(playerPref),
            options: streams.filter((s) => !s.drm).map((s, idx) => ({
              name: s.quality ? `${s.quality}p${s.server ? ` — ${s.server}` : ''}` : s.server || `Source ${idx + 1}`,
              detail: isStremioProvider(providerId) ? extractStreamTags(s).join(' • ') || undefined : undefined,
              url: s.link,
              headers: s.headers,
            })),
          });
          return;
        }

        // Same server/quality the viewer last chose for this title.
        const defaultBest = pickPreferredStream(streams, getPlaybackPrefs(item?.link)) || streams[0];
        const qualities = streams.map((s, idx) => ({
          name: s.quality ? `${s.quality}p` : s.server || `Source ${idx + 1}`,
          url: s.link,
          headers: s.headers,
          sourceType: s.type,
          drm: s.drm,
          // Shown in the player's quality picker (server name, quality and
          // provider tags), like the mobile app's server list.
          server: s.server,
          quality: s.quality,
          tags: extractStreamTags(s),
        }));

        const playStream = (best: any) => {
        // This screen is about to be unmounted by the player -- leave
        // behind everything needed to rebuild it exactly as it is now
        // (see the "Return-from-player restore" note at the top).
        if (item?.link) {
          saveDetailsReturnState({
            itemLink: item.link,
            providerId,
            seasonIndex: activeIndex,
            rawEpisodes,
            cinemeta: cinemetaMeta,
            cinemetaSettled,
            movieBoxSeasons,
            rowKey,
            episodeKey,
            episodeLink: link,
          });
        }

        onPlayStream(best.link, streamTitle, {
          // Providers that supply an IMDb id (TMDB-style metadata) put a
          // landscape backdrop in `info.image` and the real portrait
          // poster in `info.poster` / the listing item. Continue Watching
          // shows this as a poster card, so prefer the poster for them;
          // other providers keep their previous `image`-first order.
          posterUrl: info?.imdbId
            ? info?.poster || item?.image || info?.image
            : info?.image || info?.poster || item?.image,
          itemLink: item?.link,
          episodeId: episodeKey,
          providerValue: providerId,
          linkTitle: activeLink?.title,
          episodes: episodesOverride ?? playerEpisodes,
          currentEpisodeIndex: episodeIdx,
          // Provider ids first; otherwise whatever the Cinemeta match this
          // screen already resolved knows (its `moviedb_id` is the TMDB id).
          // Anything still missing is worked out in the player by
          // lib/services/tmdbIdResolver.ts from `mediaTitle`/`mediaYear`.
          tmdbId: info?.tmdbId || cinemetaMeta?.moviedb_id,
          imdbId: info?.imdbId || cinemetaMeta?.imdb_id,
          mediaTitle: cinemetaMeta?.name || info?.title || item?.title,
          mediaYear: providerYear,
          qualities,
          skip: best.skip,
          headers: best.headers,
          sourceType: best.type,
          drm: best.drm,
          subtitles: best.subtitles,
          startPosition,
        });
        };

        // Stremio addons usually return many streams (different servers,
        // qualities, releases): let the person choose instead of auto-picking.
        if (isStremioProvider(providerId) && streams.length > 1) {
          setServerPicker({
            title: streamTitle,
            player: toPlayerChoice(playerPref),
            options: streams.map((s, idx) => ({
              name: s.quality
                ? `${s.quality}p${s.server ? ` — ${s.server}` : ''}`
                : s.server || `Source ${idx + 1}`,
              detail: s.description || extractStreamTags(s).join(' • ') || undefined,
              size: s.size,
              url: s.link,
              headers: s.headers,
            })),
            onSelect: (idx: number) => playStream(streams[idx]),
          });
          return;
        }
        playStream(defaultBest);
      } catch (e: any) {
        console.warn('[TVDetailsScreen] Stream extraction failed:', e);
        ToastAndroid.show(e?.message || 'Failed to extract playback stream', ToastAndroid.LONG);
      } finally {
        setExtractingStreams(false);
      }
    },
    [
      providerId,
      info,
      item,
      playerEpisodes,
      onPlayStream,
      resumeHint,
      excludedQualities,
      activeIndex,
      rawEpisodes,
      cinemetaMeta,
      cinemetaSettled,
      movieBoxSeasons,
      providerYear,
    ],
  );

  const handlePickServer = async (option: { url: string; headers?: Record<string, string> }, index: number) => {
    if (!serverPicker) return;
    if (serverPicker.onSelect) {
      const select = serverPicker.onSelect;
      setServerPicker(null);
      select(index);
      return;
    }
    const opened = await launchVideo(option.url, serverPicker.title, serverPicker.player, option.headers);
    setServerPicker(null);
    if (!opened) {
      ToastAndroid.show('External player unavailable.', ToastAndroid.SHORT);
    }
  };

  // ---- Focus restore after the player closes -------------------------------
  // Priority: the row that was last played -> failing that (it is gone, e.g.
  // the provider's list changed) the season/quality dropdown -> failing that
  // (no dropdown on this title) the normal default focus.
  const restoredRow: DetailRow | undefined = useMemo(() => {
    if (!restored || !restoreModeRef.current || rows.length === 0) return undefined;
    return (
      (restored.episodeLink ? rows.find((r) => r.link === restored.episodeLink) : undefined) ||
      (restored.rowKey ? rows.find((r) => r.key === restored.rowKey) : undefined) ||
      (restored.episodeKey ? rows.find((r) => r.stableKey === restored.episodeKey) : undefined)
    );
  }, [rows, restored]);
  const restoreActive = Boolean(restored) && restoreModeRef.current;
  // A list exists but the row we were on is not in it: land on the dropdown.
  const restoreToPicker = restoreActive && !restoredRow && rows.length > 0 && linkList.length > 1;

  // What the post-mount restore pass should scroll to / refocus.
  const restoreTargetRef = useRef<{ kind: 'row'; key: string } | { kind: 'top' } | null>(null);
  restoreTargetRef.current = !restoreActive
    ? null
    : restoredRow
    ? { kind: 'row', key: restoredRow.key }
    : { kind: 'top' };

  // ---- Episode ranges (blocks of 50) -----------------------------------------
  // Long lists (a 20-season show) are shown 50 rows at a time: mounting every
  // row is what made this screen crawl. `rangeStart === null` means "pick the
  // block holding the episode focus will land on" (restored / resume / first).
  const [rangeStart, setRangeStart] = useState<number | null>(null);
  const episodeRanges = useMemo(
    () => (rows.length > 0 && rows[0].isEpisode ? buildEpisodeRanges(rows.length) : []),
    [rows],
  );
  const activeRange = useMemo(() => {
    if (episodeRanges.length === 0) return undefined;
    if (rangeStart !== null) {
      return episodeRanges.find((r) => r.start === rangeStart) || episodeRanges[0];
    }
    const focusIdx = restoreActive && restoredRow
      ? rows.findIndex((r) => r.key === restoredRow.key)
      : rows.findIndex((r) => r.isDefaultFocus);
    return rangeForIndex(episodeRanges, Math.max(focusIdx, 0));
  }, [episodeRanges, rangeStart, rows, restoreActive, restoredRow]);
  const visibleRowsRef = useRef<DetailRow[]>([]);
  const visibleRows = useMemo(
    () => (activeRange ? rows.slice(activeRange.start, activeRange.end) : rows),
    [rows, activeRange],
  );
  visibleRowsRef.current = visibleRows;
  // A different season/quality entry starts over on its own default block.
  useEffect(() => {
    setRangeStart(null);
  }, [activeIndex]);

  // Instant, JS-driven page scroll that holds the cursor row at a fixed spot
  // in the viewport. The page ScrollView's own scrolling is off, so this is the
  // only thing that moves it while the list is being walked.
  const scrollToEpisodeRow = useCallback((key: string): boolean => {
    const layout = rowLayoutsRef.current[key];
    const viewportH = pageViewportHRef.current;
    const contentH = pageContentHRef.current;
    if (!layout || !viewportH || !contentH) return false;
    const maxY = Math.max(0, contentH - viewportH);
    const center = listSectionYRef.current + episodeWrapperYRef.current + layout.y + layout.h / 2;
    const y = Math.min(maxY, Math.max(0, center - viewportH * LIST_FOCUS_ANCHOR));
    scrollRef.current?.scrollTo({ x: 0, y, animated: false });
    return true;
  }, []);

  horizontalListRef.current = Boolean(rows[0]?.isEpisode);

  // Page scroll helpers for the horizontal episode layout: the episode row
  // lives at the top of the page (no scrolling needed to reach it); the
  // director / cast section below it is scrolled into view when focused.
  const scrollPageToTop = useCallback(() => {
    scrollRef.current?.scrollTo({ x: 0, y: 0, animated: false });
  }, []);
  const scrollToCredits = useCallback(() => {
    scrollRef.current?.scrollTo({ x: 0, y: Math.max(creditsYRef.current - 24, 0), animated: false });
  }, []);

  const focusCredit = useCallback(
    (key: string) => {
      scrollToCredits();
      const l = creditLayoutsRef.current[key];
      const viewport = creditsWidth - 48;
      if (!l) return;
      const margin = 24;
      const offset = creditsOffsetRef.current;
      let next = offset;
      if (l.x - margin < offset) next = Math.max(0, l.x - margin);
      else if (l.x + l.w + margin > offset + viewport) next = l.x + l.w + margin - viewport;
      if (next !== offset) {
        creditsOffsetRef.current = next;
        creditsScrollRef.current?.scrollTo({ x: next, y: 0, animated: true });
      }
    },
    [scrollToCredits, creditsWidth],
  );

  // ---- Resume / Up next / Start card ------------------------------------------
  const resumeTarget = useMemo(() => {
    if (rows.length === 0 || !rows[0].isEpisode) return null;
    const idx = rows.findIndex((r) => r.isResumeTarget);
    const position = resumeHint?.position || 0;
    const duration = resumeHint?.duration || 0;
    if (idx >= 0) {
      const fraction = duration > 0 ? position / duration : 0;
      if (duration > 0 && fraction > 0.85 && rows[idx + 1]) {
        return { mode: 'next' as const, row: rows[idx + 1], title: rows[idx + 1].title };
      }
      return {
        mode: 'resume' as const,
        row: rows[idx],
        title: rows[idx].title,
        progress: fraction > 0 ? fraction : undefined,
        remaining: duration > position ? duration - position : undefined,
      };
    }
    // Played from another dropdown entry (season/dub): go back to it.
    if (resumeHint?.linkTitle && resumeHint.linkTitle !== activeLink?.title) {
      const target = linkList.findIndex((l) => l.title === resumeHint.linkTitle);
      if (target >= 0) {
        return {
          mode: 'resume' as const,
          title: resumeHint.episodeKey || 'Last episode',
          seasonTitle: resumeHint.linkTitle,
          switchTo: target,
          episodeKey: resumeHint.episodeKey,
          remaining: duration > position ? duration - position : undefined,
          progress: duration > 0 ? position / duration : undefined,
        };
      }
    }
    if (!resumeHint?.episodeKey && !resumeHint?.episodeLink && rows.length > 1) {
      return { mode: 'start' as const, row: rows[0], title: rows[0].title };
    }
    return null;
  }, [rows, resumeHint, activeLink, linkList]);

  // The pill can vanish while focused (list reloads) without a blur event.
  useEffect(() => {
    if ((!resumeTarget || stillResolving) && resumeFocused) setResumeFocused(false);
  }, [resumeTarget, stillResolving, resumeFocused]);

  // `hasTVPreferredFocus` alone is not enough after a remount: the target
  // is usually below the fold, and the details ScrollView only has views
  // attached for what is on screen, so the focus request has nothing to
  // land on (Android then falls back to the first focusable -- the Back
  // button -- and the page jumps to the top). So once the first layout has
  // settled, scroll the target into view and then re-issue the focus
  // request by remounting it (the nonce trick described by
  // `episodeFocusNonce` above). Same recipe TVDiscoverScreen uses.
  useEffect(() => {
    if (!restored) return;
    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const refocus = () => {
      timer = setTimeout(() => {
        if (!cancelled) setEpisodeFocusNonce((n) => n + 1);
      }, 60);
    };

    const run = () => {
      if (cancelled) return;
      const target = restoreTargetRef.current;
      if (!target) return;
      if (target.kind === 'row' && horizontalListRef.current) {
        // Episodes are a horizontal row at the top of the page: no vertical
        // scroll needed, the list scrolls the card into view itself.
        scrollRef.current?.scrollTo({ x: 0, y: 0, animated: false });
        refocus();
        return;
      }
      if (target.kind === 'row') {
        const rowLayout = rowLayoutsRef.current[target.key];
        const rowY = rowLayout === undefined ? undefined : episodeWrapperYRef.current + rowLayout.y;
        // Row layouts arrive a frame or two after mount; wait for them,
        // but never forever -- a scroll-less refocus is still better than
        // nothing.
        if (rowY === undefined && attempts < 15) {
          attempts += 1;
          timer = setTimeout(run, 100);
          return;
        }
        const y = rowY === undefined ? 0 : Math.max(listSectionYRef.current + rowY - RESTORE_SCROLL_MARGIN, 0);
        scrollRef.current?.scrollTo({ x: 0, y, animated: false });
      } else {
        scrollRef.current?.scrollTo({ x: 0, y: 0, animated: false });
      }
      refocus();
    };

    timer = setTimeout(run, 100);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // Mount-only: `restored` is a snapshot and everything else is a ref.
  }, []);

  // ---- Header data ---------------------------------------------------------
  // Same fields, same precedence as the Discover results header: Cinemeta's
  // canonical data when we have it, the provider's own where we do not.
  // Titles opened from the Nuvio catalog (Stremio / Nuvio addon rows) already
  // carry Nuvio's 16:9 backdrop -- the same one Home showed. Use it straight
  // away instead of waiting for (and then swapping to) Cinemeta's.
  const catalogBackdrop =
    isStremioProvider(providerId) || item?.nuvioFallback ? item?.background : undefined;
  const bannerImage =
    catalogBackdrop ||
    cinemetaMeta?.background ||
    info?.image ||
    item?.background ||
    info?.poster ||
    item?.image;
  const logoUrl = cinemetaMeta?.logo || info?.logo;
  useEffect(() => {
    setLogoFailed(false);
    setLogoAspect(null);
  }, [logoUrl]);
  const logoWidth =
    logoAspect && logoAspect > 0
      ? Math.min(LOGO_MAX_W, Math.max(120, Math.round(LOGO_MAX_H * logoAspect)))
      : LOGO_MAX_W;
  const displayTitle = cinemetaMeta?.name || info?.title || item?.title;
  // First usable rating wins. An empty/"0" value must not shadow a real one
  // (`??` only skips null/undefined), and the catalog post's own rating --
  // the one Home showed -- is a fallback too, since a brand-new title's meta
  // often has no rating yet.
  const ratingText = (() => {
    const candidates = [
      cinemetaMeta?.imdbRating,
      cinemetaMeta?.rating,
      info?.rating,
      item?.rating,
      tmdbRating,
    ];
    for (const raw of candidates) {
      const n = parseFloat(String(raw ?? ''));
      if (Number.isFinite(n) && n > 0) return String(raw).trim();
    }
    return undefined;
  })();
  const runtimeText = formatCinemetaRuntime(cinemetaMeta?.runtime);
  const yearText = String(cinemetaMeta?.year ?? cinemetaMeta?.releaseInfo ?? '').match(/(19|20)\d{2}/)?.[0];
  const genreList: string[] = cinemetaMeta?.genres?.length ? cinemetaMeta.genres : (info?.tags || []).slice(0, 3);
  const overviewText =
    cinemetaMeta?.description || info?.synopsis || 'Select an episode or source below to start streaming.';

  // ---- Row rendering -------------------------------------------------------
  // Stremio / Nuvio addons: warm the server/quality list for the episode the
  // cursor rests on and the next two, so pressing OK opens the picker at once.
  const handleCursorRow = useCallback(
    (row: DetailRow, next?: DetailRow) => {
      if (!providerId || !row.isEpisode || !isStremioProvider(providerId)) return;
      const rowsNow = visibleRowsRef.current;
      const i = rowsNow.findIndex((r) => r.key === row.key);
      scheduleStremioStreamPrefetch(providerId, [
        row.link,
        next?.link,
        i >= 0 ? rowsNow[i + 2]?.link : undefined,
      ]);
    },
    [providerId],
  );

  const handleRowPress = useCallback(
    (row: DetailRow) =>
      resolveAndPlay(
        row.link,
        row.playTitle,
        row.playType,
        row.index,
        row.stableKey,
        row.episodesOverride,
        row.key,
      ),
    [resolveAndPlay],
  );
  // Resume card on another dropdown entry: switch to it, then play once its
  // episodes have loaded.
  const pendingResumeKeyRef = useRef<string | null>(null);
  const handleResumeCardPress = useCallback(() => {
    if (!resumeTarget) return;
    if ('row' in resumeTarget && resumeTarget.row) {
      handleRowPress(resumeTarget.row);
      return;
    }
    if ('switchTo' in resumeTarget && resumeTarget.switchTo !== undefined) {
      pendingResumeKeyRef.current = resumeTarget.episodeKey || null;
      restoreModeRef.current = false;
      setSeasonIndex(resumeTarget.switchTo);
    }
  }, [resumeTarget, handleRowPress]);
  useEffect(() => {
    const key = pendingResumeKeyRef.current;
    if (!key || episodesLoading || rows.length === 0) return;
    const row = rows.find((r) => r.stableKey === key);
    pendingResumeKeyRef.current = null;
    if (row) handleRowPress(row);
  }, [rows, episodesLoading, handleRowPress]);
  const handleRowLayout = useCallback((key: string, y: number, h: number) => {
    rowLayoutsRef.current[key] = { y, h };
  }, []);
  const handleWrapperLayout = useCallback((y: number) => {
    episodeWrapperYRef.current = y;
  }, []);
  // Which row (if any) takes focus when the list mounts or is refocused.
  // After the viewer picks a block themselves, focus stays on the chips
  // instead of jumping to the resume row if it lives in that block.
  const episodeTargetKey = useMemo(() => {
    if (rangeStart !== null) return null;
    const target = restoreActive
      ? restoredRow
        ? visibleRows.find((r) => r.key === restoredRow.key)
        : restoreToPicker
        ? undefined
        : visibleRows.find((r) => r.isDefaultFocus)
      : visibleRows.find((r) => r.isDefaultFocus);
    return target ? target.key : null;
  }, [rangeStart, restoreActive, restoredRow, restoreToPicker, visibleRows]);

  // As soon as a season's episodes are on screen, warm the one the viewer is
  // most likely to open (resume / up-next / default focus, else the first)
  // and the one after it -- before they have even moved the cursor.
  useEffect(() => {
    if (!providerId || !isStremioProvider(providerId)) return;
    const list = visibleRows;
    if (list.length === 0 || !list[0].isEpisode) return;
    const resumeIdx = list.findIndex((r) => r.isResumeTarget);
    const focusIdx = list.findIndex((r) => r.isDefaultFocus);
    const start = resumeTarget && 'row' in resumeTarget && resumeTarget.row
      ? list.findIndex((r) => r.key === resumeTarget.row.key)
      : resumeIdx >= 0
      ? resumeIdx
      : focusIdx >= 0
      ? focusIdx
      : 0;
    const at = start >= 0 ? start : 0;
    prefetchStremioStreams(providerId, [list[at]?.link, list[at + 1]?.link]);
  }, [providerId, visibleRows, resumeTarget]);

  if (error && !info) {
    return (
      <View style={[styles.container, styles.centerLoading]}>
        <MaterialCommunityIcons name="alert-circle-outline" size={48} color="#EF4444" />
        <Text style={styles.errorTitle}>Failed to load content</Text>
        <Text style={styles.loadingSubtext}>{error}</Text>
        <TVFocusablePressable
          hasTVPreferredFocus
          scaleFocused={1.06}
          focusedBorderColor="#FFFFFF"
          borderRadius={10}
          onPress={onBack}
          style={styles.backBtn}
        >
          {() => (
            <View style={styles.backBtnInner}>
              <MaterialCommunityIcons name="arrow-left" size={20} color="#FFFFFF" />
              <Text style={styles.backBtnText}>Go back</Text>
            </View>
          )}
        </TVFocusablePressable>
      </View>
    );
  }

  // Resume pill focused -> it takes the width the picker gives up.
  const pillExpanded = resumeFocused && Boolean(resumeTarget) && !stillResolving;
  const pickerShowing = linkList.length > 1;
  const pillMaxExpanded = Math.max(
    PILL_MAX_COLLAPSED,
    windowWidth - PAGE_PAD_H * 2 - (pickerShowing ? PICKER_COMPACT_W + ACTION_ROW_GAP : 0),
  );

  return (
    <View style={styles.container}>
      {/* Backdrop stays fixed behind the scrolling content, rather than
          being confined to its own short header band. Same layering and
          gradients as the Discover results view. */}
      <View style={styles.backdropWrapper} pointerEvents="none">
        {bannerImage ? (
          <Image source={{ uri: bannerImage }} style={styles.backdropImage} resizeMode="cover" />
        ) : null}
        <LinearGradient
          colors={['rgba(10, 10, 14, 0.4)', 'rgba(10, 10, 14, 0.4)', 'transparent']}
          locations={[0, 0.42, 0.85]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={styles.backdropLeftGradient}
        />
        <LinearGradient
          colors={['transparent', 'rgba(10, 10, 14, 0.4)', 'rgba(10, 10, 14, 0.4)']}
          locations={[0.2, 0.65, 1]}
          style={StyleSheet.absoluteFillObject}
        />
      </View>

      <ScrollView
        ref={scrollRef}
        style={styles.scrollArea}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        // Clipping is OFF on purpose. With it on, every row scrolled out of
        // view is detached from the window, so coming back from the player
        // the row the person left off on (usually below the fold) has no
        // attached view to take focus -- see the restore pass above.
        removeClippedSubviews={false}
        // Android's own arrow-key scrolling is switched off: when the focused
        // row falls outside the viewport during a held key it makes the
        // ScrollView itself take focus, and the next press then lands on
        // whichever row happens to be at the top (the bounce on long lists).
        // Focus moves through the explicit links and the native
        // scroll-to-focused-child still keeps the focused row in view.
        // scrollEnabled=false also makes the ScrollView unfocusable;
        // programmatic scrollTo (used by the restore passes) is unaffected.
        scrollEnabled={false}
        onLayout={(e) => {
          pageViewportHRef.current = e.nativeEvent.layout.height;
        }}
        onContentSizeChange={(_w, h) => {
          pageContentHRef.current = h;
        }}
      >
        {/* Header -- logo (or title), rating / runtime / year / genres,
            synopsis and cast, laid out like the Discover results header. */}
        <View style={styles.cleanHeaderContainer}>
          {logoUrl && !logoFailed ? (
            <Image
              source={{ uri: logoUrl }}
              style={[styles.targetLogo, { width: logoWidth }]}
              resizeMode="contain"
              onLoad={(e) => {
                const src = e.nativeEvent?.source;
                if (src && src.width > 0 && src.height > 0) {
                  const ratio = src.width / src.height;
                  setLogoAspect((prev) => (prev === ratio ? prev : ratio));
                }
              }}
              onError={() => setLogoFailed(true)}
            />
          ) : (
            <Text style={styles.targetTitle} numberOfLines={2}>
              {displayTitle}
            </Text>
          )}

          <View style={styles.metaRow}>
            {ratingText ? (
              <View style={styles.ratingBadge}>
                <Text style={styles.ratingText}>★ {ratingText}</Text>
              </View>
            ) : null}
            {runtimeText ? <Text style={styles.targetMetaText}>{runtimeText}</Text> : null}
            {yearText ? <Text style={styles.targetMetaText}>{yearText}</Text> : null}
            {genreList.length > 0 ? (
              <Text style={styles.targetGenreText}>{genreList.join(' • ')}</Text>
            ) : null}
          </View>
          <Text numberOfLines={3} style={styles.targetOverview}>
            {overviewText}
          </Text>
        </View>

        {/* Action row -- season / quality picker (a single button opening a
            picker modal, so the picker stays fully reachable however many
            seasons/qualities there are) next to the compact resume / up
            next pill. Both live above the list so the episode row below is
            on screen without scrolling. */}
        {(linkList.length > 1 || (!stillResolving && resumeTarget)) && (
          <View style={styles.actionRow}>
            {linkList.length > 1 && (
              <TVFocusablePressable
                key={`season-picker${restoreToPicker ? `-f${episodeFocusNonce}` : ''}`}
                hasTVPreferredFocus={restoreToPicker}
                onFocus={scrollPageToTop}
                scaleFocused={1.03}
                focusedBorderColor="#8A5CF6"
                borderRadius={10}
                onPress={() => setSeasonPickerVisible(true)}
                style={[styles.seasonPickerBtn, pillExpanded && styles.seasonPickerBtnCompact]}
              >
                {() => (
                  <View style={styles.seasonPickerBtnInner}>
                    <MaterialCommunityIcons name="playlist-play" size={18} color="#FFFFFF" />
                    {/* No numberOfLines: the button grows with its label up to
                        `maxWidth`, then the label wraps onto more lines. */}
                    <Text
                      numberOfLines={pillExpanded ? 1 : undefined}
                      style={styles.seasonPickerBtnText}
                    >
                      {activeLink?.title || 'Select'}
                      {activeLink?.quality ? ` \u2022 ${activeLink.quality}` : ''}
                    </Text>
                    <MaterialCommunityIcons name="chevron-down" size={20} color="#C4B5FD" />
                  </View>
                )}
              </TVFocusablePressable>
            )}
            {!stillResolving && resumeTarget && (
              <TVFocusablePressable
                scaleFocused={1.03}
                focusedBorderColor="#FFFFFF"
                borderRadius={14}
                onPress={handleResumeCardPress}
                onFocus={() => {
                  setResumeFocused(true);
                  scrollPageToTop();
                }}
                onBlur={() => setResumeFocused(false)}
                style={[
                  styles.resumePill,
                  { maxWidth: pillExpanded ? pillMaxExpanded : PILL_MAX_COLLAPSED },
                ]}
              >
                {({ focused }) => (
                  <View>
                    {/* Liquid glass: translucent tint, diagonal sheen, bright top
                        edge and a hairline rim. Plain layers (no live blur) so it
                        stays cheap on TV SoCs. */}
                    <LinearGradient
                      pointerEvents="none"
                      colors={
                        focused
                          ? ['rgba(255,255,255,0.40)', 'rgba(167,139,250,0.22)', 'rgba(255,255,255,0.22)']
                          : ['rgba(255,255,255,0.26)', 'rgba(138,92,246,0.14)', 'rgba(255,255,255,0.10)']
                      }
                      start={{ x: 0, y: 0 }}
                      end={{ x: 1, y: 1 }}
                      style={StyleSheet.absoluteFill}
                    />
                    <View pointerEvents="none" style={styles.resumeGlassTopEdge} />
                    <View pointerEvents="none" style={styles.resumeGlassRim} />
                    <View style={styles.resumePillInner}>
                      <MaterialCommunityIcons
                        name={resumeTarget.mode === 'next' ? 'skip-next' : 'play'}
                        size={20}
                        color="#FFFFFF"
                      />
                      {/* One line while idle; the full text (wrapping only if even
                          the expanded width is not enough) while focused. */}
                      <Text
                        numberOfLines={pillExpanded ? undefined : 1}
                        style={styles.resumePillText}
                      >
                        {[
                          resumeTarget.mode === 'resume'
                            ? 'Resume'
                            : resumeTarget.mode === 'next'
                            ? 'Up next'
                            : 'Start watching',
                          'seasonTitle' in resumeTarget ? resumeTarget.seasonTitle : undefined,
                          resumeTarget.title,
                          resumeTarget.mode === 'resume' && 'remaining' in resumeTarget && resumeTarget.remaining
                            ? formatRemainingLabel(resumeTarget.remaining)
                            : undefined,
                        ]
                          .filter(Boolean)
                          .join(' \u00B7 ')}
                      </Text>
                    </View>
                    {resumeTarget.mode === 'resume' &&
                      'progress' in resumeTarget &&
                      resumeTarget.progress !== undefined && (
                        <View style={styles.resumeGlassTrack}>
                          <View
                            style={[
                              styles.resumeGlassFill,
                              { width: `${Math.min(100, Math.max(2, resumeTarget.progress * 100))}%` },
                            ]}
                          />
                        </View>
                      )}
                  </View>
                )}
              </TVFocusablePressable>
            )}
          </View>
        )}

        {/* Episode / Source list -- full-width rows stacked vertically so
            the whole page (not a cramped inner row) scrolls to reveal
            all of them, over the fixed backdrop above. Wrapped so its
            layout position (constant across the spinner/loaded swap,
            since only what's above it affects that) can be captured for
            the scroll-restore in the effects above. */}
        <View
          onLayout={(e) => {
            listSectionYRef.current = e.nativeEvent.layout.y;
          }}
        >
          {stillResolving ? (
            <View style={styles.centerInline}>
              <ActivityIndicator size="large" color="#8A5CF6" />
              <Text style={styles.loadingSubtext}>
                {extractingStreams
                  ? 'Resolving stream links...'
                  : isAwaitingEpisodes || episodesLoading
                  ? 'Loading episodes...'
                  : 'Loading media details...'}
              </Text>
            </View>
          ) : rows.length > 0 ? (
            <View style={styles.listSection}>
              <Text style={styles.sectionHeader}>{rows[0].isEpisode ? 'Episodes' : 'Select Source'}</Text>
              {episodeRanges.length > 0 && (
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.rangeChipRow}
                  style={styles.rangeChipScroll}
                >
                  {episodeRanges.map((range) => {
                    const selected = activeRange?.start === range.start;
                    return (
                      <TVFocusablePressable
                        key={`range-${range.start}`}
                        onFocus={scrollPageToTop}
                        scaleFocused={1.05}
                        focusedBorderColor="#8A5CF6"
                        borderRadius={16}
                        onPress={() => {
                          restoreModeRef.current = false;
                          setRangeStart(range.start);
                        }}
                        style={[styles.rangeChip, selected && styles.rangeChipSelected]}
                      >
                        {() => (
                          <Text style={[styles.rangeChipText, selected && styles.rangeChipTextSelected]}>
                            {range.start + 1}{'\u2013'}{range.end}
                          </Text>
                        )}
                      </TVFocusablePressable>
                    );
                  })}
                </ScrollView>
              )}
              <EpisodeList
                rows={visibleRows}
                targetKey={episodeTargetKey}
                focusNonce={episodeFocusNonce}
                paused={seasonPickerVisible || serverPicker !== null}
                resumeHint={resumeHint}
                onPressRow={handleRowPress}
                onRowLayout={handleRowLayout}
                onWrapperLayout={handleWrapperLayout}
                scrollToRow={scrollToEpisodeRow}
                onFocusList={scrollPageToTop}
                onCursorRow={handleCursorRow}
              />
            </View>
          ) : (
            <View style={styles.playActionSection}>
              <TVFocusablePressable
                key={`play-btn-${episodeFocusNonce}`}
                hasTVPreferredFocus={true}
                onFocus={scrollPageToTop}
                scaleFocused={1.06}
                focusedBorderColor="#FFFFFF"
                borderRadius={14}
                onPress={() =>
                  resolveAndPlay(
                    usableDirectItems[0]?.link || item?.link,
                    info?.title || item?.title,
                    usableDirectItems[0]?.type || info?.type || 'movie',
                  )
                }
                style={styles.playBtn}
              >
                {() => (
                  <View style={styles.playBtnInner}>
                    <MaterialCommunityIcons name="play" size={26} color="#FFFFFF" />
                    <Text style={styles.playBtnText}>
                      {resumeHint?.position ? 'Resume Movie / Stream' : 'Play Movie / Stream'}
                    </Text>
                  </View>
                )}
              </TVFocusablePressable>
            </View>
          )}
        </View>

        {/* Creator / director, writer and top cast, with photos -- one
            horizontal strip that shows as many people as fit from the left. */}
        {credits.directors.length + credits.cast.length > 0 && (
          <View
            style={styles.creditsSection}
            onLayout={(e) => {
              creditsYRef.current = e.nativeEvent.layout.y;
            }}
          >
            <Text style={styles.sectionHeader}>
              {(() => {
                const parts: string[] = [];
                if (credits.directors.length > 0) {
                  // Heading follows the people's actual roles (TMDB creators
                  // vs. Cinemeta directors), never the title type.
                  const isCreators = credits.directors.every((p) => p.role === 'Creator');
                  parts.push(`${isCreators ? 'Creator' : 'Director'}${credits.directors.length > 1 ? 's' : ''}`);
                }
                if (credits.cast.length > 0) parts.push('Cast');
                return parts.length > 1
                  ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
                  : parts[0];
              })()}
            </Text>
            <ScrollView
              ref={creditsScrollRef}
              horizontal
              scrollEnabled={false}
              showsHorizontalScrollIndicator={false}
              removeClippedSubviews={false}
              style={{ width: creditsWidth - 48, height: CREDIT_ROW_H }}
              contentContainerStyle={styles.creditsRow}
            >
              {credits.directors.map((p) => ({ p, key: `dir-${p.id ?? p.name}` })).map(({ p, key }) => (
                <View
                  key={key}
                  onLayout={(e) => {
                    creditLayoutsRef.current[key] = { x: e.nativeEvent.layout.x, w: e.nativeEvent.layout.width };
                  }}
                >
                  <CreditItem person={p} onFocus={() => focusCredit(key)} />
                </View>
              ))}
              {credits.directors.length > 0 && credits.cast.length > 0 ? (
                <View style={styles.creditsDivider} />
              ) : null}
              {credits.cast.map((p) => {
                const key = `cast-${p.id ?? p.name}`;
                return (
                  <View
                    key={key}
                    onLayout={(e) => {
                      creditLayoutsRef.current[key] = { x: e.nativeEvent.layout.x, w: e.nativeEvent.layout.width };
                    }}
                  >
                    <CreditItem person={p} onFocus={() => focusCredit(key)} />
                  </View>
                );
              })}
            </ScrollView>
          </View>
        )}

        <View style={{ height: 60 }} />
      </ScrollView>

      {/* Back -- icon only, in a circular glass button pinned to the top-left
          corner (outside the ScrollView so it never scrolls away). */}
      <TVFocusablePressable
        scaleFocused={1.1}
        focusedBorderColor="#FFFFFF"
        borderRadius={20}
        onPress={onBack}
        onFocus={scrollPageToTop}
        style={styles.backCircle}
      >
        {() => (
          <View style={styles.backCircleInner}>
            <MaterialCommunityIcons name="arrow-left" size={22} color="#FFFFFF" />
          </View>
        )}
      </TVFocusablePressable>

      {/* In-app stream picker (Stremio addon episodes): same look as the
          Season / Quality menu, with release details and file size. */}
      <Modal
        visible={Boolean(serverPicker?.onSelect)}
        transparent
        animationType="fade"
        onRequestClose={() => setServerPicker(null)}
      >
        <View style={styles.pickerOverlay}>
          <View
            style={[
              styles.pickerBox,
              { maxWidth: Math.min(windowWidth * 0.7, 900), maxHeight: windowHeight * 0.85 },
            ]}
          >
            <View style={styles.pickerHeader}>
              <MaterialCommunityIcons name="playlist-play" size={22} color="#A78BFA" />
              <View style={styles.pickerHeaderText}>
                <Text style={styles.pickerTitle}>Select Server / Quality</Text>
                <Text style={styles.pickerSubtitle}>
                  {serverPicker?.options.length ?? 0} streams • choose one to play
                </Text>
              </View>
            </View>
            <View style={styles.pickerDivider} />
            <ScrollView
              style={styles.pickerList}
              contentContainerStyle={styles.pickerListContent}
              showsVerticalScrollIndicator={false}
            >
              {serverPicker?.onSelect &&
                serverPicker.options.map((opt, i) => (
                  <TVFocusablePressable
                    key={`stream-opt-${i}`}
                    hasTVPreferredFocus={i === 0}
                    scaleFocused={1.02}
                    focusedBorderColor="#8A5CF6"
                    borderRadius={10}
                    onPress={() => handlePickServer(opt, i)}
                    style={styles.seasonPickerOption}
                  >
                    {() => (
                      <View style={styles.seasonPickerOptionInner}>
                        <View style={{ flexShrink: 1 }}>
                          <Text style={styles.seasonPickerOptionText}>{opt.name}</Text>
                          {opt.detail ? (
                            <Text numberOfLines={7} style={styles.pickerOptionDetail}>
                              {opt.detail}
                            </Text>
                          ) : null}
                        </View>
                        {opt.size ? (
                          <View style={styles.sizeBadge}>
                            <Text style={styles.sizeBadgeText}>{opt.size}</Text>
                          </View>
                        ) : null}
                      </View>
                    )}
                  </TVFocusablePressable>
                ))}
            </ScrollView>
            <TVFocusablePressable
              scaleFocused={1.05}
              focusedBorderColor="#FFFFFF"
              borderRadius={8}
              onPress={() => setServerPicker(null)}
              style={styles.modalCancelBtn}
            >
              {() => <Text style={styles.modalCancelText}>Cancel</Text>}
            </TVFocusablePressable>
          </View>
        </View>
      </Modal>

      <Modal
        visible={Boolean(serverPicker) && !serverPicker?.onSelect}
        transparent
        animationType="fade"
        onRequestClose={() => setServerPicker(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>Select a Server</Text>
            <Text style={styles.modalSubtitle}>
              {serverPicker?.onSelect
                ? 'Choose a server / quality to play.'
                : `Choose which stream to open in ${
                    serverPicker?.player === 'vlc' ? 'VLC' : 'your external player'
                  }.`}
            </Text>
            <ScrollView showsVerticalScrollIndicator={false}>
              {serverPicker?.options.map((opt, i) => (
                <TVFocusablePressable
                  key={`server-opt-${i}`}
                  hasTVPreferredFocus={i === 0}
                  scaleFocused={1.03}
                  focusedBorderColor="#8A5CF6"
                  borderRadius={8}
                  onPress={() => handlePickServer(opt, i)}
                  style={styles.serverOption}
                >
                  {() => (
                    <View>
                      <Text style={styles.serverOptionText}>{opt.name}</Text>
                      {opt.detail ? (
                        <Text numberOfLines={2} style={styles.serverOptionDetail}>
                          {opt.detail}
                        </Text>
                      ) : null}
                    </View>
                  )}
                </TVFocusablePressable>
              ))}
            </ScrollView>
            <TVFocusablePressable
              scaleFocused={1.05}
              focusedBorderColor="#FFFFFF"
              borderRadius={8}
              onPress={() => setServerPicker(null)}
              style={styles.modalCancelBtn}
            >
              {() => <Text style={styles.modalCancelText}>Cancel</Text>}
            </TVFocusablePressable>
          </View>
        </View>
      </Modal>

      <Modal
        visible={seasonPickerVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setSeasonPickerVisible(false)}
      >
        <View style={styles.pickerOverlay}>
          {/* Shrink-wraps its content (so a short list gets a compact card,
              a long label a wider one) up to 70% of the screen; beyond
              that labels wrap, and a long list scrolls inside the card. */}
          <View
            style={[
              styles.pickerBox,
              {
                maxWidth: Math.min(windowWidth * 0.7, 900),
                maxHeight: windowHeight * 0.8,
              },
            ]}
          >
            <View style={styles.pickerHeader}>
              <MaterialCommunityIcons name="playlist-play" size={22} color="#A78BFA" />
              <View style={styles.pickerHeaderText}>
                <Text style={styles.pickerTitle}>Select Season / Quality</Text>
                <Text style={styles.pickerSubtitle}>
                  {linkList.length} options • choose which source to load episodes from
                </Text>
              </View>
            </View>
            <View style={styles.pickerDivider} />
            <ScrollView
              style={styles.pickerList}
              contentContainerStyle={styles.pickerListContent}
              showsVerticalScrollIndicator={false}
            >
              {linkList.map((l, idx) => {
                const isActive = idx === activeIndex;
                return (
                  <TVFocusablePressable
                    key={`season-opt-${l.title}-${idx}`}
                    hasTVPreferredFocus={isActive}
                    scaleFocused={1.02}
                    focusedBorderColor="#8A5CF6"
                    borderRadius={10}
                    onPress={() => {
                      // Only arms the forced scroll/refocus below when this
                      // pick will actually trigger an async episode fetch
                      // (`stillResolving` toggling true→false) -- otherwise
                      // (a plain quality/direct-link swap with no
                      // episodesLink) the content updates synchronously in
                      // this same render and the normal fresh-mount
                      // `hasTVPreferredFocus` already handles it, so
                      // leaving the flag armed would just misfire on some
                      // unrelated later loading state (e.g. pressing Play).
                      if (idx !== activeIndex) {
                        // A different selection makes the restored focus
                        // target moot -- default focus rules take over.
                        restoreModeRef.current = false;
                        if (l?.episodesLink) {
                          pendingEpisodeFocusRef.current = true;
                        }
                      }
                      setSeasonIndex(idx);
                      setSeasonPickerVisible(false);
                    }}
                    style={[styles.seasonPickerOption, isActive && styles.seasonPickerOptionActive]}
                  >
                    {() => (
                      <View style={styles.seasonPickerOptionInner}>
                        {/* Full label, wrapped -- never truncated. */}
                        <View style={{ flexShrink: 1 }}>
                          <Text
                            style={[
                              styles.seasonPickerOptionText,
                              isActive && styles.seasonPickerOptionTextActive,
                            ]}
                          >
                            {l.title}
                            {l.quality ? ` • ${l.quality}` : ''}
                          </Text>
                          {l.description ? (
                            <Text numberOfLines={7} style={styles.pickerOptionDetail}>
                              {l.description}
                            </Text>
                          ) : null}
                        </View>
                        {getFileSizeLabel({ size: l.size }) ? (
                          <View style={styles.sizeBadge}>
                            <Text style={styles.sizeBadgeText}>{getFileSizeLabel({ size: l.size })}</Text>
                          </View>
                        ) : null}
                        {isActive && (
                          <MaterialCommunityIcons
                            name="check-circle"
                            size={20}
                            color="#A78BFA"
                            style={styles.seasonPickerCheck}
                          />
                        )}
                      </View>
                    )}
                  </TVFocusablePressable>
                );
              })}
            </ScrollView>
            <TVFocusablePressable
              scaleFocused={1.05}
              focusedBorderColor="#FFFFFF"
              borderRadius={8}
              onPress={() => setSeasonPickerVisible(false)}
              style={styles.modalCancelBtn}
            >
              {() => <Text style={styles.modalCancelText}>Cancel</Text>}
            </TVFocusablePressable>
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
  },
  backdropWrapper: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  backdropImage: {
    width: '100%',
    height: '100%',
    opacity: 0.88,
  },
  backdropLeftGradient: {
    ...StyleSheet.absoluteFillObject,
    width: '75%',
  },
  scrollArea: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 48,
    // Clears the top-left back button; kept tight so the episode row fits
    // on screen without scrolling.
    paddingTop: 54,
    paddingBottom: 40,
  },
  // Round glass back button, top-left corner.
  backCircle: {
    position: 'absolute',
    top: 12,
    left: 20,
    width: 40,
    height: 40,
    backgroundColor: 'rgba(255, 255, 255, 0.14)',
    borderColor: 'rgba(255, 255, 255, 0.22)',
    zIndex: 20,
  },
  backCircleInner: {
    width: 36,
    height: 36,
    justifyContent: 'center',
    alignItems: 'center',
  },
  // Still used by the error screen's "Go back" button.
  backBtn: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginBottom: 20,
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
  // Header -- values match the Discover results header.
  cleanHeaderContainer: {
    maxWidth: 720,
    marginBottom: 10,
    backgroundColor: 'transparent',
  },
  targetLogo: {
    width: LOGO_MAX_W,
    height: LOGO_MAX_H,
    marginBottom: 10,
    alignSelf: 'flex-start',
  },
  targetTitle: {
    color: '#FFFFFF',
    fontSize: 28,
    fontWeight: '900',
    marginBottom: 4,
    letterSpacing: -0.3,
    textShadowColor: 'rgba(0, 0, 0, 0.95)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 8,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 10,
    marginBottom: 6,
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
    textShadowColor: 'rgba(0, 0, 0, 0.95)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 6,
  },
  targetGenreText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
    textShadowColor: 'rgba(0, 0, 0, 0.95)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 6,
  },
  targetOverview: {
    color: '#FFFFFF',
    fontSize: 13,
    lineHeight: 18,
    maxWidth: 520,
    textShadowColor: 'rgba(0, 0, 0, 0.95)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  // Single trigger button that opens the season/quality picker modal
  // (replaces the old inline, potentially multi-row, chip list).
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
  // Shrunk while the resume pill is focused (label ellipsizes to one line).
  seasonPickerBtnCompact: {
    maxWidth: PICKER_COMPACT_W,
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
  // Season/quality picker popup. Kept separate from the external-player
  // "Select a Server" modal (modalOverlay/modalBox) so the two can differ.
  pickerOverlay: {
    flex: 1,
    // Light dim so the details screen stays visible behind the popup.
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
  seasonPickerCheck: {
    flexShrink: 0,
  },
  sectionHeader: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 6,
  },
  listSection: {
    marginBottom: 12,
  },
  resumeCard: {
    backgroundColor: '#7C4DFF',
    marginBottom: 18,
    overflow: 'hidden',
  },
  resumeCardInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  resumeCardTextCol: { flex: 1 },
  resumeCardHeading: { color: '#FFFFFF', fontSize: 18, fontWeight: '700' },
  resumeCardDetail: { color: 'rgba(255,255,255,0.85)', fontSize: 15, marginTop: 2 },
  rangeChipScroll: { marginBottom: 14 },
  rangeChipRow: { gap: 8, paddingVertical: 4 },
  rangeChip: {
    backgroundColor: 'rgba(22, 22, 30, 0.6)',
    borderWidth: 1,
    borderColor: 'rgba(167, 139, 250, 0.25)',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  rangeChipSelected: { backgroundColor: 'rgba(124, 77, 255, 0.35)', borderColor: '#A78BFA' },
  rangeChipText: { color: '#C4B5FD', fontSize: 15, fontWeight: '600' },
  rangeChipTextSelected: { color: '#FFFFFF' },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 10,
  },
  // Liquid-glass resume / up-next pill (maxWidth is set at render time).
  resumePill: {
    backgroundColor: 'rgba(138, 92, 246, 0.20)',
    overflow: 'hidden',
    flexShrink: 1,
  },
  resumeGlassTopEdge: {
    position: 'absolute',
    top: 0,
    left: 12,
    right: 12,
    height: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.6)',
  },
  resumeGlassRim: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.28)',
  },
  resumeGlassTrack: {
    height: 4,
    backgroundColor: 'rgba(255, 255, 255, 0.14)',
  },
  resumeGlassFill: {
    height: 4,
    backgroundColor: 'rgba(196, 181, 253, 0.95)',
  },
  resumePillInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  resumePillText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
    flexShrink: 1,
  },
  // Horizontal episode cards.
  hRowContent: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: EPISODE_ROW_PAD_V,
    paddingHorizontal: EPISODE_ROW_PAD_H,
  },
  hCard: {
    width: EPISODE_CARD_W,
    height: EPISODE_CARD_H,
    marginRight: EPISODE_CARD_GAP,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    backgroundColor: '#16161E',
    overflow: 'hidden',
  },
  hCardSelected: {
    borderColor: '#8A5CF6',
    transform: [{ scale: 1.03 }],
  },
  hCardImage: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: EPISODE_CARD_W,
    height: EPISODE_CARD_H,
  },
  hCardScrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: EPISODE_CARD_W,
    height: EPISODE_CARD_H,
  },
  hCardBody: {
    position: 'absolute',
    left: 0,
    bottom: 0,
    width: EPISODE_CARD_W - 4,
    paddingHorizontal: 12,
    paddingBottom: 10,
  },
  hBadge: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    borderRadius: 5,
    paddingHorizontal: 7,
    paddingVertical: 2,
    marginBottom: 4,
  },
  hBadgeText: {
    color: '#E5E7EB',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1,
  },
  hTitle: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 3,
  },
  hOverview: {
    color: '#E5E7EB',
    fontSize: 11,
    lineHeight: 15,
    marginBottom: 6,
  },
  hMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  hMetaItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  hMetaSpacer: {
    flex: 1,
  },
  hMetaText: {
    color: '#D1D5DB',
    fontSize: 11,
    fontWeight: '500',
  },
  hRatingTag: {
    backgroundColor: '#F5C518',
    borderRadius: 3,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  hRatingTagText: {
    color: '#000000',
    fontSize: 9,
    fontWeight: '900',
  },
  hRatingValue: {
    color: '#F5C518',
    fontSize: 11,
    fontWeight: '700',
  },
  hResumeBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
    backgroundColor: 'rgba(138, 92, 246, 0.85)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 5,
    overflow: 'hidden',
  },
  // Director / cast.
  creditsSection: {
    marginTop: 4,
  },
  creditsRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  creditsDivider: {
    width: 1,
    height: CREDIT_PHOTO,
    marginHorizontal: 10,
    backgroundColor: 'rgba(255, 255, 255, 0.25)',
  },
  creditItem: {
    width: CREDIT_PHOTO + 24,
    padding: 4,
    marginRight: 4,
  },
  creditInner: {
    alignItems: 'center',
  },
  creditPhoto: {
    width: CREDIT_PHOTO,
    height: CREDIT_PHOTO,
    borderRadius: CREDIT_PHOTO / 2,
    backgroundColor: '#1A1A22',
  },
  creditPhotoFallback: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  creditInitials: {
    color: '#9CA3AF',
    fontSize: 26,
    fontWeight: '700',
  },
  // Dark hue behind names / roles so they stay readable over the backdrop.
  creditName: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'center',
    marginTop: 6,
    maxWidth: CREDIT_PHOTO + 16,
    backgroundColor: 'rgba(0, 0, 0, 0.62)',
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    overflow: 'hidden',
    textShadowColor: 'rgba(0, 0, 0, 0.95)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  creditRole: {
    color: '#E5E7EB',
    fontSize: 10,
    textAlign: 'center',
    marginTop: 3,
    maxWidth: CREDIT_PHOTO + 16,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    borderRadius: 5,
    paddingHorizontal: 5,
    paddingVertical: 1,
    overflow: 'hidden',
  },
  // Episode card -- values match the Discover episode card.
  episodeCard: {
    backgroundColor: 'rgba(22, 22, 30, 0.6)',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 8,
    width: '100%',
    marginBottom: 10,
  },
  // Non-episode row (a server/quality for one movie).
  sourceRow: {
    backgroundColor: 'rgba(22, 22, 30, 0.6)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.06)',
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 10,
  },
  rowFrame: {
    borderWidth: 2,
    borderColor: 'transparent',
  },
  rowSelected: {
    borderColor: '#8A5CF6',
    transform: [{ scale: 1.02 }],
  },
  listHost: {
    position: 'absolute',
    backgroundColor: 'transparent',
  },
  episodeInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  playCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  playCircleFocused: {
    backgroundColor: '#8A5CF6',
  },
  episodeThumbWrap: {
    width: 120,
    height: 68,
    borderRadius: 6,
    overflow: 'hidden',
    backgroundColor: '#1A1A22',
    marginRight: 4,
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
  episodeTextWrap: {
    flex: 1,
  },
  episodeText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
  sourceText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
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
  playActionSection: {
    marginTop: 8,
  },
  playBtn: {
    alignSelf: 'flex-start',
    backgroundColor: '#8A5CF6',
    paddingHorizontal: 28,
    paddingVertical: 14,
  },
  playBtnInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  playBtnText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '800',
  },
  centerLoading: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  centerInline: {
    alignItems: 'flex-start',
    paddingVertical: 30,
  },
  loadingSubtext: {
    color: '#9CA3AF',
    fontSize: 15,
    marginTop: 14,
  },
  errorTitle: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '700',
    marginTop: 12,
    marginBottom: 4,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalBox: {
    width: 460,
    maxHeight: 460,
    backgroundColor: '#13131A',
    borderRadius: 14,
    padding: 20,
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.12)',
  },
  modalTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '800',
    marginBottom: 4,
  },
  modalSubtitle: {
    color: '#9CA3AF',
    fontSize: 13,
    marginBottom: 14,
  },
  serverOption: {
    backgroundColor: '#1E1E28',
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 8,
  },
  serverOptionText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  serverOptionDetail: {
    color: '#9CA3AF',
    fontSize: 12,
    marginTop: 3,
  },
  modalCancelBtn: {
    alignSelf: 'flex-end',
    marginTop: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 8,
  },
  modalCancelText: {
    color: '#D1D5DB',
    fontSize: 13,
    fontWeight: '700',
  },
});
