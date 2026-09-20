import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Image,
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
  fetchMatchingCinemetaMeta,
  findCinemetaEpisode,
  formatCinemetaTitle,
  CinemetaMeta,
} from '../../lib/services/cinemetaService';
import { settingsStorage } from '../../lib/storage';
import { launchVideo, PlayerChoice } from '../../lib/services/PlayerLauncher';
import { parseSeasonNumber, parseEpisodeNumber, sortEpisodesChronologically, formatEpisodeLabel } from '../../lib/utils/episodeParsing';
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

interface ResumeHint {
  episodeLink?: string;
  // Stable "S{season}E{episode}" key -- see ContinueWatchingItem.episodeKey.
  // Preferred over `episodeLink` when present; `episodeLink` stays as a
  // fallback for entries saved before this key existed.
  episodeKey?: string;
  position?: number;
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
      servers?: { name: string; url: string; headers?: Record<string, string>; sourceType?: string }[];
      qualities?: { name: string; url: string; headers?: Record<string, string>; sourceType?: string }[];
      headers?: Record<string, string>;
      sourceType?: string;
      subtitles?: TextTracks;
      startPosition?: number;
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

  const [info, setInfo] = useState<Info | null>(() =>
    item?.link && providerId ? getCachedMetadata(item.link, providerId) || null : null
  );
  const [loading, setLoading] = useState(!info);
  const [error, setError] = useState<string | null>(null);
  const [extractingStreams, setExtractingStreams] = useState(false);

  const [seasonIndex, setSeasonIndex] = useState(0);
  const [rawEpisodes, setEpisodes] = useState<EpisodeLink[]>([]);
  const [episodesLoading, setEpisodesLoading] = useState(false);

  // This whole screen is one flat ScrollView (no separate "page 2" like
  // Discover's results view), so picking a season/quality chip that's
  // scrolled below the fold doesn't remount anything -- but the episode
  // section briefly collapses to a small spinner while the new list
  // fetches (see `stillResolving` below), shrinking the page's content
  // height. Android clamps the ScrollView's offset to the new (shorter)
  // max scroll range when that happens, which yanks the view back toward
  // the top and, since the just-pressed chip can end up scrolled off
  // screen by that clamp, drops real focus along with it. And because
  // `hasTVPreferredFocus` only fires a real focus() the moment an item
  // first *mounts*, a quality switch that happens to return the exact
  // same episode list (same ids/links, just a different source) never
  // remounts anything either -- so nothing re-asserts focus at all.
  // `scrollRef` + `episodeFocusNonce` below explicitly drive both the
  // scroll position and a forced refocus once the new list is actually
  // ready, instead of relying on incidental remounts.
  const scrollRef = useRef<ScrollView | null>(null);
  // y-offset (within the ScrollView's content) of the section holding the
  // episode/source list -- captured via that section's `onLayout` below.
  // Stable across the spinner <-> loaded-list swap since it only depends
  // on the (unchanged) siblings above it, not on the section's own height.
  const listSectionYRef = useRef(0);
  // Armed by a season/quality chip press; consumed the next time loading
  // finishes (see the effect below), so an ordinary initial page load
  // (nothing pressed) never triggers an unwanted scroll/refocus.
  const pendingEpisodeFocusRef = useRef(false);
  // Bumped to force exactly the target episode/source row (index 0, or
  // the resume target) to remount -- same "nonce in the key" trick used
  // for programmatic focus elsewhere in this app (TVNavigationRail,
  // TVDiscoverScreen), since plain React Native doesn't wire up a real
  // `ref.focus()` for arbitrary Views on Android.
  const [episodeFocusNonce, setEpisodeFocusNonce] = useState(0);

  // Cinemeta enrichment -- canonical title/year formatting plus, for
  // series, per-episode stills & synopses (the provider's own `episodes`
  // almost never carry either). Only trusted once `fetchMatchingCinemetaMeta`
  // has confirmed the title actually matches, same gate the home screen's
  // hero enrichment uses.
  const [cinemetaMeta, setCinemetaMeta] = useState<CinemetaMeta | null>(null);

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
  useEffect(() => {
    let isMounted = true;

    async function fetchMetadata() {
      if (!providerId || !item?.link) {
        setError('No active provider found for this media');
        setLoading(false);
        return;
      }

      const cached = getCachedMetadata(item.link, providerId);
      if (cached) {
        setInfo(cached);
        setSeasonIndex(0);
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);
      try {
        const res = await getOrFetchMetadata(item.link, providerId);
        if (isMounted) {
          setInfo(res);
          setSeasonIndex(0);
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
  }, [item, providerId]);

  // Fetch Cinemeta's meta for this title (canonical name/year + a series'
  // per-episode `videos` list) once real metadata is in. Same
  // `populateMeta` opt-in gate the home screen hero uses -- only trust an
  // imdbId a provider has explicitly vouched for.
  useEffect(() => {
    let isMounted = true;
    setCinemetaMeta(null);

    if (info?.populateMeta === true && info?.imdbId && info?.type) {
      fetchMatchingCinemetaMeta(info.imdbId, info.type, info.title || item?.title).then((meta) => {
        if (isMounted) setCinemetaMeta(meta);
      });
    }

    return () => {
      isMounted = false;
    };
  }, [info?.imdbId, info?.type, info?.populateMeta, info?.title, item?.title]);

  const excludedQualities = useMemo(
    () => settingsStorage.getExcludedQualities() || [],
    [],
  );

  // Filter season/quality tabs against excluded settings -- falls back to
  // the unfiltered list if every entry would otherwise be excluded, so
  // there's always something pickable.
  const rawLinkList: Link[] = info?.linkList || [];
  const linkList: Link[] = useMemo(() => {
    if (!excludedQualities.length) return rawLinkList;
    const filtered = rawLinkList.filter(
      (l) =>
        !isQualityExcluded(l?.quality, excludedQualities) &&
        !isQualityExcluded(l?.title, excludedQualities),
    );
    return filtered.length > 0 ? filtered : rawLinkList;
  }, [rawLinkList, excludedQualities]);
  const activeLink = linkList[seasonIndex];
  const hasEpisodesLink = !!activeLink?.episodesLink;

  // 2. Once we know which season/link is selected, fetch its episode list
  //    (series) -- movies use `directLinks` directly, no extra fetch needed.
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
    if (!excludedQualities.length) return rawEpisodes;
    const filtered = rawEpisodes.filter(
      (ep: any) =>
        !isQualityExcluded(ep?.quality, excludedQualities) &&
        !isQualityExcluded(ep?.title, excludedQualities),
    );
    return filtered.length > 0 ? filtered : rawEpisodes;
  }, [rawEpisodes, excludedQualities]);

  const usableDirectItems = useMemo(() => {
    if (!excludedQualities.length) return directItems;
    const filtered = directItems.filter(
      (d: any) =>
        !isQualityExcluded(d?.title, excludedQualities) &&
        !isQualityExcluded(d?.quality, excludedQualities),
    );
    return filtered.length > 0 ? filtered : directItems;
  }, [directItems, excludedQualities]);

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

  // Episode payload actually handed to TVPlayerScreen -- same list as
  // `episodes` above, but enriched with each episode's real season/episode
  // number plus Cinemeta's synopsis/thumbnail (falling back to whatever the
  // provider itself returned) when the provider's own data is missing one.
  // Powers the player's "Videos" episode picker and "Up Next" popup.
  const playerEpisodes: EpisodeLink[] = useMemo(() => {
    return episodes.map((ep, index) => {
      const seasonNum = parseSeasonNumber(activeLink?.title) ?? seasonIndex + 1;
      const episodeNum = parseEpisodeNumber(ep.title) ?? index + 1;
      const cinemetaEp = findCinemetaEpisode(cinemetaMeta, seasonNum, episodeNum);
      return {
        ...ep,
        // Real episode name (Cinemeta) over the provider's own bare/numeric
        // label -- feeds the player's "Videos" list and "Up Next" popup.
        title: cinemetaEp?.name || cinemetaEp?.title || ep.title || `Episode ${index + 1}`,
        image: ep.image || cinemetaEp?.thumbnail,
        synopsis: ep.description || cinemetaEp?.overview,
        season: seasonNum,
        episodeNumber: episodeNum,
        releaseDate: cinemetaEp?.released,
      } as EpisodeLink & { synopsis?: string; season?: number; episodeNumber?: number; releaseDate?: string };
    });
  }, [episodes, cinemetaMeta, activeLink, seasonIndex]);

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

        onPlayStream(best.link, streamTitle, {
          posterUrl: info?.image || info?.poster || item?.image,
          itemLink: item?.link,
          episodeId: episodeKey,
          providerValue: providerId,
          episodes: episodesOverride ?? playerEpisodes,
          currentEpisodeIndex: episodeIdx,
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
    [providerId, info, item, playerEpisodes, onPlayStream, resumeHint, excludedQualities],
  );

  const handlePickServer = async (option: { url: string; headers?: Record<string, string> }) => {
    if (!serverPicker) return;
    const opened = await launchVideo(option.url, serverPicker.title, serverPicker.player, option.headers);
    setServerPicker(null);
    if (!opened) {
      ToastAndroid.show('External player unavailable.', ToastAndroid.SHORT);
    }
  };

  const bannerImage = info?.image || info?.poster || item?.image;
  const hasEpisodes = episodes.length > 0;

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
          being confined to its own short header band. */}
      <View style={styles.backdropWrapper}>
        {bannerImage ? (
          <Image
            source={{ uri: bannerImage }}
            style={styles.backdropImage}
            resizeMode="cover"
          />
        ) : null}
        <LinearGradient
          // Darkest stop capped at 0.5 (was 0.85 -> solid #0A0A0E) so the
          // backdrop never gets darker than 50% behind the picker text.
          colors={['rgba(10, 10, 14, 0.25)', 'rgba(10, 10, 14, 0.5)', 'rgba(10, 10, 14, 0.5)']}
          locations={[0, 0.55, 1]}
          style={StyleSheet.absoluteFillObject}
        />
        <LinearGradient
          // Darkest stop capped at 0.5 (was 0.95).
          colors={['rgba(10, 10, 14, 0.5)', 'transparent']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={[StyleSheet.absoluteFillObject, { width: '75%' }]}
        />
      </View>

      <ScrollView
        ref={scrollRef}
        style={styles.scrollArea}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
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

        {/* Title block, moved up so the episode/quality list below has
            more of the screen to itself. */}
        <View style={styles.titleBlock}>
          <Text style={styles.title} numberOfLines={2}>
            {formatCinemetaTitle(cinemetaMeta?.name, cinemetaMeta?.releaseInfo) ||
              info?.title ||
              item?.title}
          </Text>

          <View style={styles.badgeRow}>
            {info?.rating ? (
              <View style={styles.ratingBadge}>
                <Text style={styles.ratingText}>★ {info.rating}</Text>
              </View>
            ) : null}
            {(info?.tags || []).slice(0, 3).map((t, i) => (
              <Text key={`${t}-${i}`} style={styles.metaBadge}>
                {t}
              </Text>
            ))}
          </View>

          <Text style={styles.overview} numberOfLines={3}>
            {info?.synopsis || 'Select an episode or source below to start streaming.'}
          </Text>
        </View>

        {/* Season / Quality Selector */}
        {linkList.length > 1 && (
          <View style={styles.seasonRow}>
            {linkList.map((l, idx) => (
              <TVFocusablePressable
                key={`${l.title}-${idx}`}
                scaleFocused={1.05}
                focusedBorderColor="#8A5CF6"
                borderRadius={8}
                onPress={() => {
                  pendingEpisodeFocusRef.current = true;
                  setSeasonIndex(idx);
                }}
                style={[styles.seasonChip, idx === seasonIndex && styles.seasonChipActive]}
              >
                {() => (
                  <Text
                    numberOfLines={1}
                    style={[styles.seasonChipText, idx === seasonIndex && styles.seasonChipTextActive]}
                  >
                    {l.title}
                    {l.quality ? ` • ${l.quality}` : ''}
                  </Text>
                )}
              </TVFocusablePressable>
            ))}
          </View>
        )}

        {/* Episode / Source list -- full-width rows stacked vertically so
            the whole page (not a cramped inner row) scrolls to reveal
            all of them, over the fixed backdrop above. Wrapped so its
            layout position (constant across the spinner/loaded swap,
            since only what's above it affects that) can be captured for
            the scroll-restore in the effect above. */}
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
        ) : hasEpisodes ? (
          <View style={styles.listSection}>
            <Text style={styles.sectionHeader}>Episodes</Text>
            {episodes.map((ep, index) => {
              // Prefer real season/episode numbers parsed from the source's
              // own labels (handles S01/s1/Season01/Season 1 etc. on the
              // season chip, and E12/Episode 12/leading "12." etc. on the
              // episode title); fall back to positional order only when a
              // number genuinely can't be found.
              const seasonNum = parseSeasonNumber(activeLink?.title) ?? seasonIndex + 1;
              const episodeNum = parseEpisodeNumber(ep.title) ?? index + 1;
              const episodeKey = `S${seasonNum}E${episodeNum}`;
              // Stable key match is authoritative; raw link match is only a
              // fallback for continue-watching entries saved before this
              // key existed.
              const isResumeTarget =
                resumeHint?.episodeKey
                  ? resumeHint.episodeKey === episodeKey
                  : !!resumeHint?.episodeLink && ep.link === resumeHint.episodeLink;
              const cinemetaEp = findCinemetaEpisode(cinemetaMeta, seasonNum, episodeNum);
              const episodeThumb = ep.image || cinemetaEp?.thumbnail;
              const episodeOverview = ep.description || cinemetaEp?.overview;
              const isFocusTarget =
                resumeHint?.episodeKey || resumeHint?.episodeLink
                  ? isResumeTarget
                  : index === 0;
              return (
                <TVFocusablePressable
                  // Nonce suffix only on the target row -- forces just
                  // that one to remount (and re-fire `hasTVPreferredFocus`)
                  // when a season/quality switch needs a forced refocus,
                  // without touching every other row's identity.
                  key={`ep-${ep.id || ep.link || index}${isFocusTarget ? `-f${episodeFocusNonce}` : ''}`}
                  hasTVPreferredFocus={isFocusTarget}
                  scaleFocused={1.02}
                  focusedBorderColor="#8A5CF6"
                  borderRadius={10}
                  onPress={() =>
                    resolveAndPlay(
                      ep.link,
                      info?.title || item?.title || ep.title || `Episode ${index + 1}`,
                      'series',
                      index,
                      episodeKey,
                    )
                  }
                  style={styles.episodeRow}
                >
                  {({ focused }) => (
                    <View style={styles.episodeRowInner}>
                      {episodeThumb ? (
                        <View style={styles.episodeThumbWrap}>
                          <Image
                            source={{ uri: episodeThumb }}
                            style={styles.episodeThumb}
                            resizeMode="cover"
                          />
                          <View style={styles.episodeThumbPlayOverlay}>
                            <MaterialCommunityIcons name="play" size={16} color="#FFFFFF" />
                          </View>
                        </View>
                      ) : (
                        <View style={[styles.playCircle, focused && styles.playCircleFocused]}>
                          <MaterialCommunityIcons name="play" size={18} color="#FFFFFF" />
                        </View>
                      )}
                      <View style={styles.episodeTextWrap}>
                        <Text numberOfLines={1} style={styles.episodeTitle}>
                          {formatEpisodeLabel(
                            seasonNum,
                            episodeNum,
                            cinemetaEp?.name || cinemetaEp?.title || ep.title,
                            `Episode ${index + 1}`
                          )}
                        </Text>
                        {!!episodeOverview && (
                          <Text numberOfLines={2} style={styles.episodeDesc}>
                            {episodeOverview}
                          </Text>
                        )}
                      </View>
                      {isResumeTarget && resumeHint?.position ? (
                        <Text style={styles.resumeBadge}>
                          Resume {Math.floor(resumeHint.position / 60)}:
                          {String(Math.floor(resumeHint.position % 60)).padStart(2, '0')}
                        </Text>
                      ) : null}
                    </View>
                  )}
                </TVFocusablePressable>
              );
            })}
          </View>
        ) : usableDirectItems.length > 1 ? (
          <View style={styles.listSection}>
            <Text style={styles.sectionHeader}>Select Source</Text>
            {(() => {
              // Providers without a TMDB/IMDb id often can't group a show
              // into proper season tabs + an `episodesLink` fetch, so each
              // episode ends up here as a flat "direct link" entry instead
              // of going through the `hasEpisodes` branch above. Whether
              // this list is actually a set of distinct episodes (needing
              // per-item resume matching, same as that branch) or just
              // several servers/qualities for one movie (where every entry
              // legitimately shares the same resume badge) can't be read
              // off `d.type` alone -- most providers never bother setting
              // it. `info.type` is set from basic scraping regardless of
              // TMDB/IMDb enrichment, so -- matching the convention already
              // used elsewhere in this app (TVInfoScreen, TVDiscoverScreen)
              // -- treat anything not explicitly `'movie'` as episodes.
              const directItemsAreEpisodes =
                usableDirectItems.some((d) => d.type === 'series') ||
                (info?.type || 'series') !== 'movie';
              const episodesForPlayer: EpisodeLink[] | undefined = directItemsAreEpisodes
                ? usableDirectItems.map((d, index) => {
                    const seasonNum = parseSeasonNumber(activeLink?.title) ?? seasonIndex + 1;
                    const episodeNum = parseEpisodeNumber(d.title) ?? index + 1;
                    const cinemetaEp = findCinemetaEpisode(cinemetaMeta, seasonNum, episodeNum);
                    return {
                      title: cinemetaEp?.name || cinemetaEp?.title || d.title,
                      link: d.link,
                      description: d.description,
                      image: d.image || cinemetaEp?.thumbnail,
                      synopsis: d.description || cinemetaEp?.overview,
                      season: seasonNum,
                      episodeNumber: episodeNum,
                      releaseDate: cinemetaEp?.released,
                      quickDownload: d.quickDownload,
                      skip: d.skip,
                    } as EpisodeLink & { synopsis?: string; season?: number; episodeNumber?: number; releaseDate?: string };
                  })
                : undefined;

              return usableDirectItems.map((d, index) => {
                const seasonNum = parseSeasonNumber(activeLink?.title) ?? seasonIndex + 1;
                const episodeNum = parseEpisodeNumber(d.title) ?? index + 1;
                const directCinemetaEp = directItemsAreEpisodes
                  ? findCinemetaEpisode(cinemetaMeta, seasonNum, episodeNum)
                  : null;
                const directEpisodeKey = directItemsAreEpisodes
                  ? `S${seasonNum}E${episodeNum}`
                  : undefined;
                const isResumeTarget = directEpisodeKey
                  ? resumeHint?.episodeKey
                    ? resumeHint.episodeKey === directEpisodeKey
                    : !!resumeHint?.episodeLink && d.link === resumeHint.episodeLink
                  : true;
                const isFocusTarget =
                  directItemsAreEpisodes && (resumeHint?.episodeKey || resumeHint?.episodeLink)
                    ? isResumeTarget
                    : index === 0;
                return (
                  <TVFocusablePressable
                    // Same forced-remount nonce as the episode list above.
                    key={`direct-${d.link}-${index}${isFocusTarget ? `-f${episodeFocusNonce}` : ''}`}
                    hasTVPreferredFocus={isFocusTarget}
                    scaleFocused={1.02}
                    focusedBorderColor="#8A5CF6"
                    borderRadius={10}
                    onPress={() =>
                      resolveAndPlay(
                        d.link,
                        info?.title || item?.title,
                        d.type || info?.type || 'movie',
                        index,
                        directEpisodeKey,
                        episodesForPlayer,
                      )
                    }
                    style={styles.episodeRow}
                  >
                    {({ focused }) => (
                      <View style={styles.episodeRowInner}>
                        <View style={[styles.playCircle, focused && styles.playCircleFocused]}>
                          <MaterialCommunityIcons name="play" size={18} color="#FFFFFF" />
                        </View>
                        <Text numberOfLines={1} style={styles.episodeTitle}>
                          {directItemsAreEpisodes
                            ? formatEpisodeLabel(
                                seasonNum,
                                episodeNum,
                                directCinemetaEp?.name || directCinemetaEp?.title || d.title,
                                `Episode ${index + 1}`
                              )
                            : directCinemetaEp?.name || directCinemetaEp?.title || d.title}
                        </Text>
                        {isResumeTarget && resumeHint?.position ? (
                          <Text style={styles.resumeBadge}>
                            Resume {Math.floor(resumeHint.position / 60)}:
                            {String(Math.floor(resumeHint.position % 60)).padStart(2, '0')}
                          </Text>
                        ) : null}
                      </View>
                    )}
                  </TVFocusablePressable>
                );
              });
            })()}
          </View>
        ) : (
          <View style={styles.playActionSection}>
            <TVFocusablePressable
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
  titleBlock: {
    maxWidth: 780,
    marginBottom: 20,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 32,
    fontWeight: '800',
    marginBottom: 8,
  },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 10,
    flexWrap: 'wrap',
  },
  ratingBadge: {
    backgroundColor: '#F59E0B',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  ratingText: {
    color: '#000000',
    fontSize: 12,
    fontWeight: '800',
  },
  metaBadge: {
    color: '#D1D5DB',
    fontSize: 12,
    fontWeight: '600',
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 4,
  },
  overview: {
    color: '#D1D5DB',
    fontSize: 14,
    lineHeight: 20,
  },
  seasonRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginBottom: 24,
  },
  seasonChip: {
    paddingHorizontal: 16,
    paddingVertical: 9,
    backgroundColor: 'rgba(22, 22, 30, 0.6)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  seasonChipActive: {
    backgroundColor: 'rgba(138, 92, 246, 0.22)',
    borderColor: '#8A5CF6',
  },
  seasonChipText: {
    color: '#9CA3AF',
    fontSize: 13,
    fontWeight: '600',
  },
  seasonChipTextActive: {
    color: '#FFFFFF',
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
  episodeRow: {
    backgroundColor: 'rgba(22, 22, 30, 0.6)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.06)',
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 10,
  },
  episodeRowInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
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
  episodeTitle: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
    flex: 1,
  },
  episodeDesc: {
    color: '#9CA3AF',
    fontSize: 12,
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
