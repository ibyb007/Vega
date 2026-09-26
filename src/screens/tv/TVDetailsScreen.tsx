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
} from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { TVFocusablePressable } from '../../components/tv/TVFocusablePressable';
import useContentStore from '../../lib/zustand/contentStore';
import { providerManager } from '../../lib/services/ProviderManager';
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
import { launchVideo, PlayerChoice } from '../../lib/services/PlayerLauncher';
import { parseSeasonNumber, parseEpisodeNumber, sortEpisodesChronologically, formatEpisodeLabel } from '../../lib/utils/episodeParsing';
import { getFileSizeLabel, stripFileSize } from '../../lib/utils/fileSize';
import {
  DetailsReturnState,
  clearDetailsReturnState,
  episodeRowKey,
  peekDetailsReturnState,
  saveDetailsReturnState,
  sourceRowKey,
} from '../../lib/tv/detailsReturnState';
import type { Info, Link, EpisodeLink, TextTracks } from '../../lib/providers/types';

// The TV settings screen's 'exo' | 'vlc' | 'system' options map onto
// `PlayerLauncher`'s choices ('exoplayer' being the internal player).
const toPlayerChoice = (pref: 'exo' | 'vlc' | 'system'): PlayerChoice =>
  pref === 'vlc' ? 'vlc' : pref === 'system' ? 'external' : 'exoplayer';

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
const EpisodeRow = React.memo(function EpisodeRow({
  row,
  isFocusTarget,
  focusNonce,
  resumePosition,
  onPress,
  onLayout,
}: {
  row: DetailRow;
  isFocusTarget: boolean;
  focusNonce: number;
  resumePosition?: number;
  onPress: (row: DetailRow) => void;
  onLayout: (key: string, y: number) => void;
}) {
  return (
    <TVFocusablePressable
      // Nonce suffix only on the target row -- forces just that one to
      // remount (and re-fire `hasTVPreferredFocus`) when a season/quality
      // switch or a return from the player needs a forced refocus,
      // without touching every other row's identity.
      key={`row-${row.key}-${row.index}${isFocusTarget ? `-f${focusNonce}` : ''}`}
      hasTVPreferredFocus={isFocusTarget}
      onLayout={(e) => onLayout(row.key, e.nativeEvent.layout.y)}
      scaleFocused={1.02}
      focusedBorderColor="#8A5CF6"
      borderRadius={row.isEpisode ? 8 : 10}
      onPress={() => onPress(row)}
      style={row.isEpisode ? styles.episodeCard : styles.sourceRow}
    >
      {({ focused }) => (
        <View style={styles.episodeInner}>
          {row.isEpisode ? (
            row.thumb ? (
              <View style={styles.episodeThumbWrap}>
                <Image
                  source={{ uri: row.thumb }}
                  style={styles.episodeThumb}
                  resizeMode="cover"
                  // Skips the fade-in transition on Android -- cheap enough
                  // on its own, but adds up across a long list of thumbs
                  // mounting in quick succession while scrolling.
                  fadeDuration={0}
                />
                <View style={styles.episodeThumbPlayOverlay}>
                  <MaterialCommunityIcons name="play" size={16} color="#FFFFFF" />
                </View>
              </View>
            ) : (
              <MaterialCommunityIcons name="play-circle-outline" size={22} color="#8A5CF6" />
            )
          ) : (
            <View style={[styles.playCircle, focused && styles.playCircleFocused]}>
              <MaterialCommunityIcons name="play" size={18} color="#FFFFFF" />
            </View>
          )}
          <View style={styles.episodeTextWrap}>
            <Text numberOfLines={1} style={row.isEpisode ? styles.episodeText : styles.sourceText}>
              {row.title}
            </Text>
            {!!row.releaseDate && (
              <Text numberOfLines={1} style={styles.episodeReleaseText}>
                {row.releaseDate}
              </Text>
            )}
            {!!row.overview && (
              <Text numberOfLines={2} style={styles.episodeOverviewText}>
                {row.overview}
              </Text>
            )}
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
      servers?: { name: string; url: string; headers?: Record<string, string>; sourceType?: string }[];
      qualities?: { name: string; url: string; headers?: Record<string, string>; sourceType?: string }[];
      headers?: Record<string, string>;
      sourceType?: string;
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
  const [movieBoxSeasons, setMovieBoxSeasons] = useState<number[] | null>(null);

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
  const rowLayoutsRef = useRef<Record<string, number>>({});
  // Armed by a season/quality pick in the modal; consumed the next time
  // loading finishes (see the effect below), so an ordinary initial page
  // load (nothing picked) never triggers an unwanted scroll/refocus.
  const pendingEpisodeFocusRef = useRef(false);
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

  // When the default player is set to something other than the inbuilt
  // one, `resolveAndPlay` stops short of launching anything and instead
  // populates this so the person can pick which resolved server to open
  // externally -- mirroring the mobile app's SeasonList server-picker
  // modal instead of blindly handing off `streams[0]`.
  const [serverPicker, setServerPicker] = useState<{
    title: string;
    player: PlayerChoice;
    options: { name: string; url: string; headers?: Record<string, string> }[];
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
    if (season == null) return rawEpisodes;
    return rawEpisodes.filter((ep) => (parseSeasonNumber(ep.title) ?? 1) === season);
  }, [rawEpisodes, activeLink]);

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
    scrollRef.current?.scrollTo({ x: 0, y: Math.max(listSectionYRef.current - 16, 0), animated: false });
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
          thumb: cinemetaEp?.thumbnail || ep.image,
          overview: ep.description || cinemetaEp?.overview,
          releaseDate: formatEpisodeReleaseDate(cinemetaEp?.released),
          sizeLabel,
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
          thumb: directItemsAreEpisodes ? cinemetaEp?.thumbnail || d.image : undefined,
          overview: directItemsAreEpisodes ? d.description || cinemetaEp?.overview : undefined,
          releaseDate: directItemsAreEpisodes ? formatEpisodeReleaseDate(cinemetaEp?.released) : undefined,
          sizeLabel,
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
        if (playerPref !== 'exo') {
          // Mirrors the mobile app's SeasonList server-picker modal: show
          // every resolved server/quality and let the person choose which
          // one actually gets handed off to the external player, instead
          // of silently always using `streams[0]` (which is frequently
          // the one most likely to be dead/rate-limited).
          setServerPicker({
            title: streamTitle,
            player: toPlayerChoice(playerPref),
            options: streams.map((s, idx) => ({
              name: s.quality ? `${s.quality}p${s.server ? ` — ${s.server}` : ''}` : s.server || `Source ${idx + 1}`,
              url: s.link,
              headers: s.headers,
            })),
          });
          return;
        }

        const best = streams[0];
        const qualities = streams.map((s, idx) => ({
          name: s.quality ? `${s.quality}p` : s.server || `Source ${idx + 1}`,
          url: s.link,
          headers: s.headers,
          sourceType: s.type,
        }));

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
            rowKey,
            episodeKey,
            episodeLink: link,
          });
        }

        onPlayStream(best.link, streamTitle, {
          posterUrl: info?.image || info?.poster || item?.image,
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
          subtitles: best.subtitles,
          startPosition,
        });
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
      providerYear,
    ],
  );

  const handlePickServer = async (option: { url: string; headers?: Record<string, string> }) => {
    if (!serverPicker) return;
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
      if (target.kind === 'row') {
        const rowY = rowLayoutsRef.current[target.key];
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
  const bannerImage = cinemetaMeta?.background || info?.image || info?.poster || item?.image;
  const logoUrl = cinemetaMeta?.logo || info?.logo;
  useEffect(() => {
    setLogoFailed(false);
  }, [logoUrl]);
  const displayTitle = cinemetaMeta?.name || info?.title || item?.title;
  const ratingText = (() => {
    const raw = cinemetaMeta?.imdbRating ?? cinemetaMeta?.rating ?? info?.rating;
    return raw !== undefined && raw !== null && String(raw).trim() !== '' ? String(raw) : undefined;
  })();
  const runtimeText = formatCinemetaRuntime(cinemetaMeta?.runtime);
  const yearText = String(cinemetaMeta?.year ?? cinemetaMeta?.releaseInfo ?? '').match(/(19|20)\d{2}/)?.[0];
  const genreList: string[] = cinemetaMeta?.genres?.length ? cinemetaMeta.genres : (info?.tags || []).slice(0, 3);
  const castList: string[] = (cinemetaMeta?.cast?.length ? cinemetaMeta.cast : info?.cast || []).slice(0, 3);
  const overviewText =
    cinemetaMeta?.description || info?.synopsis || 'Select an episode or source below to start streaming.';

  // ---- Row rendering -------------------------------------------------------
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
  const handleRowLayout = useCallback((key: string, y: number) => {
    rowLayoutsRef.current[key] = y;
  }, []);
  const renderRow = (row: DetailRow) => {
    const isFocusTarget = restoreActive
      ? restoredRow
        ? row.key === restoredRow.key
        : restoreToPicker
        ? false
        : row.isDefaultFocus
      : row.isDefaultFocus;

    return (
      <EpisodeRow
        key={`row-${row.key}-${row.index}${isFocusTarget ? `-f${episodeFocusNonce}` : ''}`}
        row={row}
        isFocusTarget={isFocusTarget}
        focusNonce={episodeFocusNonce}
        resumePosition={row.isResumeTarget ? resumeHint?.position : undefined}
        onPress={handleRowPress}
        onLayout={handleRowLayout}
      />
    );
  };

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
      >
        <TVFocusablePressable
          scaleFocused={1.08}
          focusedBorderColor="#8A5CF6"
          borderRadius={8}
          onPress={onBack}
          style={styles.backBtn}
        >
          {() => (
            <View style={styles.backBtnInner}>
              <MaterialCommunityIcons name="arrow-left" size={20} color="#FFFFFF" />
              <Text style={styles.backBtnText}>Back</Text>
            </View>
          )}
        </TVFocusablePressable>

        {/* Header -- logo (or title), rating / runtime / year / genres,
            synopsis and cast, laid out like the Discover results header. */}
        <View style={styles.cleanHeaderContainer}>
          {logoUrl && !logoFailed ? (
            <Image
              source={{ uri: logoUrl }}
              style={styles.targetLogo}
              resizeMode="contain"
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
          <Text numberOfLines={5} style={styles.targetOverview}>
            {overviewText}
          </Text>
          {castList.length > 0 ? (
            <Text numberOfLines={1} style={styles.targetCastText}>
              <Text style={styles.targetCastLabel}>Cast: </Text>
              {castList.join(', ')}
            </Text>
          ) : null}
        </View>

        {/* Season / Quality Selector -- a single button opening a picker
            modal instead of an inline (and, with many options, multi-row)
            chip list. Keeps the picker fully reachable regardless of how
            many seasons/qualities there are, and keeps this ScrollView's
            own layout stable while picking (see the comment by
            `scrollRef` above for why that mattered). */}
        {linkList.length > 1 && (
          <TVFocusablePressable
            key={`season-picker${restoreToPicker ? `-f${episodeFocusNonce}` : ''}`}
            hasTVPreferredFocus={restoreToPicker}
            scaleFocused={1.03}
            focusedBorderColor="#8A5CF6"
            borderRadius={10}
            onPress={() => setSeasonPickerVisible(true)}
            style={styles.seasonPickerBtn}
          >
            {() => (
              <View style={styles.seasonPickerBtnInner}>
                <MaterialCommunityIcons name="playlist-play" size={18} color="#FFFFFF" />
                {/* No numberOfLines: the button grows with its label up to
                    `maxWidth`, then the label wraps onto more lines. */}
                <Text style={styles.seasonPickerBtnText}>
                  {activeLink?.title || 'Select'}
                  {activeLink?.quality ? ` • ${activeLink.quality}` : ''}
                </Text>
                <MaterialCommunityIcons name="chevron-down" size={20} color="#C4B5FD" />
              </View>
            )}
          </TVFocusablePressable>
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
              {rows.map(renderRow)}
            </View>
          ) : (
            <View style={styles.playActionSection}>
              <TVFocusablePressable
                key={`play-btn-${episodeFocusNonce}`}
                hasTVPreferredFocus={true}
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

        <View style={{ height: 60 }} />
      </ScrollView>

      <Modal
        visible={Boolean(serverPicker)}
        transparent
        animationType="fade"
        onRequestClose={() => setServerPicker(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>Select a Server</Text>
            <Text style={styles.modalSubtitle}>
              Choose which stream to open in{' '}
              {serverPicker?.player === 'vlc' ? 'VLC' : 'your external player'}.
            </Text>
            <ScrollView showsVerticalScrollIndicator={false}>
              {serverPicker?.options.map((opt, i) => (
                <TVFocusablePressable
                  key={`server-opt-${i}`}
                  hasTVPreferredFocus={i === 0}
                  scaleFocused={1.03}
                  focusedBorderColor="#8A5CF6"
                  borderRadius={8}
                  onPress={() => handlePickServer(opt)}
                  style={styles.serverOption}
                >
                  {() => <Text style={styles.serverOptionText}>{opt.name}</Text>}
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
                        <Text
                          style={[
                            styles.seasonPickerOptionText,
                            isActive && styles.seasonPickerOptionTextActive,
                          ]}
                        >
                          {l.title}
                          {l.quality ? ` • ${l.quality}` : ''}
                        </Text>
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
    paddingTop: 20,
    paddingBottom: 40,
  },
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
    flexWrap: 'wrap',
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
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 6,
  },
  targetCastLabel: {
    color: '#DDE00B',
    fontWeight: '700',
    textShadowColor: 'rgba(0, 0, 0, 0.95)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 6,
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
    marginBottom: 24,
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
  seasonPickerCheck: {
    flexShrink: 0,
  },
  sectionHeader: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 14,
  },
  listSection: {
    marginBottom: 12,
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
