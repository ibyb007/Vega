import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  Image,
  ActivityIndicator,
  Modal,
  StyleSheet,
  findNodeHandle,
} from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { TVFocusablePressable } from '../../components/tv/TVFocusablePressable';
import { registerRailLeftEdge } from '../../lib/tv/registerRailLeftEdge';
import { useTVEntryFocus } from '../../lib/tv/useTVEntryFocus';
import type { useReadingOrderFocus } from '../../lib/tv/useReadingOrderFocus';
import { Post, Info, Link, EpisodeLink } from '../../lib/providers/types';
import { isStremioProvider, scheduleStremioStreamPrefetch } from '../../lib/services/stremioAddon';
import { CatalogMediaItem, DiscoverCatalog } from '../../lib/services/stremioCatalog';
import { findCinemetaEpisode, formatEpisodeReleaseDate, CinemetaMeta } from '../../lib/services/cinemetaService';
import { getTmdbApiKey } from '../../lib/hooks/useTmdbStory';
import {
  CreditPerson,
  TmdbCredits,
  TmdbEpisodeInfo,
  TmdbIdentityLite,
  fetchTmdbCredits,
  fetchTmdbSeasonEpisodes,
  resolveTmdbIdentityLite,
} from '../../lib/services/tmdbDetailsService';
import { parseSeasonNumber, parseEpisodeNumber, isBareEpisodeLabel } from '../../lib/utils/episodeParsing';
import { getFileSizeLabel, stripFileSize } from '../../lib/utils/fileSize';
import { styles, SCREEN_WIDTH, SCREEN_HEIGHT, isQualityExcluded, DiscoverResumeHint } from './TVDiscoverScreen';

// ---------------------------------------------------------------------------
// Horizontal episode cards + director / cast -- the same look as
// TVDetailsScreen (episode still, number, title, synopsis, runtime, rating,
// release date; round director / cast photos).
// ---------------------------------------------------------------------------

// Explicit pixel sizes on purpose: Fabric collapses percentage-sized containers on TV.
const EPISODE_CARD_W = 300;
const EPISODE_CARD_H = 176;
const EPISODE_CARD_GAP = 14;
// Space kept around the focused (scaled) card so it is never clipped.
const EPISODE_ROW_PAD_V = 12;
const EPISODE_ROW_PAD_H = 8;
// Page content starts this far from the left screen edge (RESULTS_PADDING_LEFT
// in TVDiscoverScreen); the episode row runs off the right edge from there.
const RESULTS_LEFT_INSET = 48;
const BACK_SIZE = 44;
// Credits strip: photo size and the strip's explicit height.
const CREDIT_PHOTO = 104;
const CREDIT_ROW_H = 190;
// Right gutter of the results page (CONTAINER_PADDING_RIGHT in TVDiscoverScreen).
const RESULTS_RIGHT_INSET = 56;

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
  const str = String(value);
  const h = /(\d+)\s*h/i.exec(str);
  const m = /(\d+)\s*m/i.exec(str);
  if (h || m) return (h ? parseInt(h[1], 10) * 60 : 0) + (m ? parseInt(m[1], 10) : 0);
  const n = parseInt(str, 10);
  return n > 0 ? n : undefined;
};

// One episode, fully resolved for display.
interface EpisodeCardData {
  // Focus identity (`results:ep:...` / `results:direct-ep:...`).
  focusKey: string;
  index: number;
  link: string;
  rawTitle: string;
  // Stable "S{season}E{episode}" -- also the resume identity.
  stableKey: string;
  seasonNum: number;
  episodeNum: number;
  cardTitle: string;
  thumb?: string;
  overview?: string;
  releaseDate?: string;
  runtimeLabel?: string;
  ratingLabel?: string;
  ratingSource?: 'IMDb' | 'TMDB';
  sizeLabel?: string;
  isResumeTarget: boolean;
}

// Purely presentational; the TVFocusablePressable around it is the focus target.
const EpisodeCardBody = React.memo(function EpisodeCardBody({
  card,
  resumePosition,
}: {
  card: EpisodeCardData;
  resumePosition?: number;
}) {
  return (
    <View style={local.hCardInner}>
      {card.thumb ? (
        <Image
          source={{ uri: card.thumb }}
          style={local.hCardImage}
          resizeMode="cover"
          // Skips the fade-in on Android -- adds up across a long row of thumbs.
          fadeDuration={0}
        />
      ) : null}
      <LinearGradient
        pointerEvents="none"
        colors={['rgba(10, 10, 14, 0.10)', 'rgba(10, 10, 14, 0.72)', 'rgba(10, 10, 14, 0.96)']}
        locations={[0, 0.42, 1]}
        style={local.hCardScrim}
      />
      {resumePosition ? (
        <Text style={local.hResumeBadge}>
          Resume {Math.floor(resumePosition / 60)}:{String(Math.floor(resumePosition % 60)).padStart(2, '0')}
        </Text>
      ) : null}
      {card.sizeLabel ? (
        <View style={local.hSizeBadge}>
          <Text style={local.hSizeBadgeText}>{card.sizeLabel}</Text>
        </View>
      ) : null}
      <View style={local.hCardBody}>
        <View style={local.hBadge}>
          <Text style={local.hBadgeText}>EPISODE {card.episodeNum}</Text>
        </View>
        <Text numberOfLines={1} style={local.hTitle}>
          {card.cardTitle}
        </Text>
        {card.overview ? (
          <Text numberOfLines={3} style={local.hOverview}>
            {card.overview}
          </Text>
        ) : null}
        <View style={local.hMetaRow}>
          {card.runtimeLabel ? (
            <View style={local.hMetaItem}>
              <MaterialCommunityIcons name="clock-outline" size={13} color="#D1D5DB" />
              <Text style={local.hMetaText}>{card.runtimeLabel}</Text>
            </View>
          ) : null}
          {card.ratingLabel ? (
            <View style={local.hMetaItem}>
              <View style={local.hRatingTag}>
                <Text style={local.hRatingTagText}>{card.ratingSource || 'IMDb'}</Text>
              </View>
              <Text style={local.hRatingValue}>{card.ratingLabel}</Text>
            </View>
          ) : null}
          <View style={local.hMetaSpacer} />
          {card.releaseDate ? (
            <Text numberOfLines={1} style={local.hMetaText}>
              {card.releaseDate}
            </Text>
          ) : null}
        </View>
      </View>
    </View>
  );
});

// One director / cast member: round photo (initials when there is none), name
// and role. Focusable so D-pad Down from the episode row can reach the section.
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
      style={local.creditItem}
    >
      {() => (
        <View style={local.creditInner}>
          {person.photo && !photoFailed ? (
            <Image
              source={{ uri: person.photo }}
              style={local.creditPhoto}
              resizeMode="cover"
              fadeDuration={0}
              onError={() => setPhotoFailed(true)}
            />
          ) : (
            <View style={[local.creditPhoto, local.creditPhotoFallback]}>
              <Text style={local.creditInitials}>{initials}</Text>
            </View>
          )}
          <Text numberOfLines={2} style={local.creditName}>
            {person.name}
          </Text>
          {person.role ? (
            <Text numberOfLines={1} style={local.creditRole}>
              {person.role}
            </Text>
          ) : null}
        </View>
      )}
    </TVFocusablePressable>
  );
});

// The "page 2" of TVDiscoverScreen: season/quality picker, episode/source
// list, and playback resolution for one tapped catalog item. Split out of
// TVDiscoverScreen.tsx (which now handles only "page 1" -- catalog pills,
// hero, posters grid) because the two pages share almost no state and
// editing either one no longer means scrolling through the other's ~2,700
// lines to find the right scope. TVDiscoverScreen renders this in place of
// its own JSX whenever `screenMode === 'results'`.
//
// This is a render-only extraction, not a rewrite: every prop below is a
// value, ref, or callback that already existed in TVDiscoverScreen, passed
// through unchanged -- including `chain`. It's tempting to give this page
// its own `useReadingOrderFocus()` instance instead of receiving one, since
// page 1 never reads from it -- but page 1's `setItemRef` (also shared,
// also passed straight through) calls `chain.register()` for every
// `results:`-prefixed key regardless of which page is showing, so the
// instance that registers rows and the instance this page reads
// (`chain.propsFor`/`chain.beginRender`) have to be the same object.
//
// `shouldPreferResultsFocus`, `noteResultsFocus` and `onResultsScroll` stay
// defined in TVDiscoverScreen -- they're the only things that read or write
// the module-level `lastFocusedDiscoverResultsKey` / `lastResultsScrollY`,
// so keeping them there means this file never touches those variables
// directly. Likewise `onSelectLink` wraps the one spot that mutates
// `savedDiscoverState`.
export interface TVDiscoverResultsViewProps {
  resultsTarget: (CatalogMediaItem & { logo?: string; cast?: string[]; runtime?: string }) | null;
  selectedCatalog?: DiscoverCatalog | null;
  resultsLoading: boolean;
  matchedAddonPosts: Post[];
  activeSourcePost: Post | null;
  sourceInfo: Info | null;
  loadingSourceInfo: boolean;
  activeLinkIndex: number;
  episodes: EpisodeLink[];
  episodesLoading: boolean;
  sourceCinemetaMeta: CinemetaMeta | null;
  extractingLink: boolean;
  resumeHint: DiscoverResumeHint | null;
  excludedQualities: string[];
  resultsScrollRef: React.RefObject<ScrollView | null>;
  sourcesRowFirstRef: React.RefObject<View | null>;

  // Focus plumbing owned by the parent (see file comment above).
  chain: ReturnType<typeof useReadingOrderFocus>;
  keyFor: ReturnType<typeof useTVEntryFocus>['keyFor'];
  setItemRef: ReturnType<typeof useTVEntryFocus>['setItemRef'];
  shouldPreferResultsFocus: (key: string, defaultValue: boolean) => boolean;
  noteResultsFocus: (key: string, keepResumePending?: boolean) => void;
  onResultsScroll: (e: any) => void;
  handleResultsContentSizeChange: () => void;

  // Actions.
  onSelectLink: (idx: number) => void;
  backToBrowse: () => void;
  handleSelectSourceCard: (sourcePost: Post) => void | Promise<void>;
  handleResolveAndPlay: (
    link: string,
    title: string,
    type: string,
    episodeIdx?: number,
    customEpisodes?: EpisodeLink[],
    episodeKey?: string,
  ) => void | Promise<void>;
}

export const TVDiscoverResultsView: React.FC<TVDiscoverResultsViewProps> = ({
  resultsTarget,
  selectedCatalog,
  resultsLoading,
  matchedAddonPosts,
  activeSourcePost,
  sourceInfo,
  loadingSourceInfo,
  activeLinkIndex,
  chain,
  episodes,
  episodesLoading,
  sourceCinemetaMeta,
  extractingLink,
  resumeHint,
  excludedQualities,
  resultsScrollRef,
  sourcesRowFirstRef,
  keyFor,
  setItemRef,
  shouldPreferResultsFocus,
  noteResultsFocus,
  onResultsScroll,
  handleResultsContentSizeChange,
  onSelectLink,
  backToBrowse,
  handleSelectSourceCard,
  handleResolveAndPlay,
}) => {
  // Controls the season/quality picker popup -- purely local to this page,
  // nothing outside it reads this.
  const [seasonPickerVisible, setSeasonPickerVisible] = useState(false);

  const banner = resultsTarget?.banner || resultsTarget?.poster;
  const rawLinkList: Link[] = sourceInfo?.linkList || [];
  const linkList = rawLinkList.filter(
    (l) =>
      !isQualityExcluded(l?.quality, excludedQualities) &&
      !isQualityExcluded(l?.title, excludedQualities),
  );
  const usableLinkList = linkList.length > 0 ? linkList : rawLinkList;
  const activeLink = usableLinkList[activeLinkIndex] || usableLinkList[0];

  const rawDirectItems = activeLink?.directLinks || [];
  const directItems = rawDirectItems.filter(
    (d) =>
      !isQualityExcluded(d?.title, excludedQualities) &&
      !isQualityExcluded((d as any)?.quality, excludedQualities),
  );
  const usableDirectItems = directItems.length > 0 ? directItems : rawDirectItems;

  const isSeries =
    Boolean(activeLink?.episodesLink) ||
    resultsTarget?.type === 'series' ||
    sourceInfo?.type === 'series' ||
    sourceInfo?.type === 'tv' ||
    selectedCatalog?.type === 'series' ||
    episodes.length > 0 ||
    Boolean(usableDirectItems.length > 0 && usableDirectItems.some((d) => d.type === 'series')) ||
    Boolean(usableDirectItems.length > 1 && resultsTarget?.type !== 'movie');

  const isAwaitingEpisodes = isSeries && episodesLoading && episodes.length === 0;
  const logoUrl = resultsTarget?.logo || (sourceCinemetaMeta as any)?.logo;


  // ---- Episode cards: base list -------------------------------------------------
  // A real per-season episode list, or -- when the provider only gave a flat
  // `directLinks` list for the season -- those entries rendered the same way.
  const usingEpisodeList = episodes.length > 0;
  const episodeSources: Array<{
    title?: string;
    link: string;
    image?: string;
    description?: string;
    skip?: EpisodeLink['skip'];
    size?: string | number;
  }> = usingEpisodeList ? episodes : usableDirectItems;
  const baseEpisodes = episodeSources.map((src, idx) => {
    const seasonNum =
      parseSeasonNumber(src.title) ?? parseSeasonNumber(activeLink?.title) ?? activeLinkIndex + 1;
    const episodeNum = parseEpisodeNumber(src.title) ?? idx + 1;
    return { src, idx, seasonNum, episodeNum };
  });
  // Handed to the player (queue / "Up Next").
  const playerEpisodes: EpisodeLink[] = usingEpisodeList
    ? episodes
    : usableDirectItems.map((item, i) => ({
        title: item.title || `Episode ${i + 1}`,
        link: item.link,
        image: item.image,
        description: item.description,
        skip: item.skip,
      }));

  // ---- Director / cast + per-episode runtime & rating --------------------------
  // Photos: Cinemeta's own `app_extras` when it carries them, otherwise TMDB
  // credits (needs the TMDB key the rest of the app uses). Episode runtime /
  // rating come from TMDB season data when available; Cinemeta's per-episode
  // IMDb rating wins when it has one. Same sources as TVDetailsScreen.
  const [tmdbIdentity, setTmdbIdentity] = useState<TmdbIdentityLite | null>(null);
  const [tmdbCredits, setTmdbCredits] = useState<TmdbCredits | null>(null);
  const [tmdbEpisodeInfo, setTmdbEpisodeInfo] = useState<Record<string, TmdbEpisodeInfo>>({});

  useEffect(() => {
    let alive = true;
    setTmdbIdentity(null);
    if (!resultsTarget || !getTmdbApiKey()) {
      return () => {
        alive = false;
      };
    }
    resolveTmdbIdentityLite({
      tmdbId: sourceInfo?.tmdbId || sourceCinemetaMeta?.moviedb_id,
      imdbId: sourceInfo?.imdbId || sourceCinemetaMeta?.imdb_id || resultsTarget.imdb_id,
      title: sourceCinemetaMeta?.name || resultsTarget.title,
      year: resultsTarget.year,
      kind: isSeries ? 'series' : 'movie',
    }).then((identity) => {
      if (alive && identity) setTmdbIdentity(identity);
    });
    return () => {
      alive = false;
    };
  }, [
    resultsTarget?.id,
    resultsTarget?.imdb_id,
    resultsTarget?.title,
    resultsTarget?.year,
    sourceInfo?.tmdbId,
    sourceInfo?.imdbId,
    sourceCinemetaMeta?.moviedb_id,
    sourceCinemetaMeta?.imdb_id,
    sourceCinemetaMeta?.name,
    isSeries,
  ]);

  const cinemetaCredits: TmdbCredits = useMemo(() => {
    const extras = (sourceCinemetaMeta as any)?.app_extras;
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
    // they stay "Director" even for a series. (Real creators come from TMDB.)
    const directorRole = 'Director';
    let cast = (Array.isArray(extras?.cast) ? extras.cast : [])
      .map((p: any) => toPerson(p))
      .filter(Boolean) as CreditPerson[];
    let directors = (Array.isArray(extras?.directors) ? extras.directors : [])
      .map((p: any) => toPerson(p, directorRole))
      .filter(Boolean) as CreditPerson[];
    // No structured credits: names only (initials stand in for photos).
    if (cast.length === 0) {
      const names: string[] = sourceCinemetaMeta?.cast?.length
        ? sourceCinemetaMeta.cast
        : resultsTarget?.cast?.length
        ? resultsTarget.cast
        : sourceInfo?.cast || [];
      cast = names.filter(Boolean).map((name) => ({ name }));
    }
    if (directors.length === 0) {
      const raw = (sourceCinemetaMeta as any)?.director;
      const names: string[] = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
      directors = names.filter(Boolean).map((name) => ({ name, role: directorRole }));
    }
    return { directors: directors.slice(0, 2), writers: [], cast: cast.slice(0, 15) };
  }, [sourceCinemetaMeta, resultsTarget?.cast, sourceInfo?.cast]);

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

  // Credits strip: one horizontal row (directors / creators, then cast). Its
  // own scrolling is off; focusing a person scrolls it, and the page scrolls
  // vertically so the strip is in view.
  const creditsScrollRef = useRef<ScrollView | null>(null);
  const creditsOffsetRef = useRef(0);
  const creditsYRef = useRef(0);
  const creditLayoutsRef = useRef<Record<string, { x: number; w: number }>>({});
  const focusCredit = useCallback(
    (key: string) => {
      resultsScrollRef.current?.scrollTo({
        x: 0,
        y: Math.max(creditsYRef.current - 24, 0),
        animated: false,
      });
      const l = creditLayoutsRef.current[key];
      if (!l) return;
      const viewport = SCREEN_WIDTH - RESULTS_LEFT_INSET - RESULTS_RIGHT_INSET;
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
    [resultsScrollRef],
  );

  // Episode cards' own native nodes, so the first card's Left and the last
  // card's Right can point at themselves (key consumed, focus stays put).
  const episodeNodesRef = useRef<Record<string, any>>({});

  // Season numbers present in the current list (usually exactly one).
  const seasonsKey = Array.from(new Set(baseEpisodes.map((e) => e.seasonNum)))
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b)
    .slice(0, 8)
    .join(',');

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

  // ---- Episode cards: resolved for display ---------------------------------------
  const titleRuntimeMinutes = parseRuntimeMinutes(sourceCinemetaMeta?.runtime ?? resultsTarget?.runtime);
  const episodeCards: EpisodeCardData[] = baseEpisodes.map(({ src, idx, seasonNum, episodeNum }) => {
    const cinemetaEp: any = findCinemetaEpisode(sourceCinemetaMeta, seasonNum, episodeNum);
    const tmdbInfo = tmdbIdentity
      ? tmdbEpisodeInfo[`${tmdbIdentity.tmdbId}:${seasonNum}:${episodeNum}`]
      : undefined;
    // Same "GB/MB baked into the title" extraction TVDetailsScreen uses.
    const sizeLabel = getFileSizeLabel(src as any);
    const cleaned = sizeLabel ? stripFileSize(src.title) || src.title || '' : src.title || '';
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
    const stableKey = `S${seasonNum}E${episodeNum}`;
    return {
      focusKey: usingEpisodeList ? `results:ep:${src.link || idx}` : `results:direct-ep:${src.link || idx}`,
      index: idx,
      link: src.link,
      rawTitle: src.title || '',
      stableKey,
      seasonNum,
      episodeNum,
      cardTitle:
        cinemetaEp?.name ||
        cinemetaEp?.title ||
        (cleaned && !isBareEpisodeLabel(cleaned) ? cleaned : tmdbInfo?.name || `Episode ${episodeNum}`),
      // Cinemeta's per-episode `thumbnail` is the real still; many providers
      // only return the show poster as `image` for every episode.
      thumb: cinemetaEp?.thumbnail || tmdbInfo?.still || src.image,
      overview: src.description || cinemetaEp?.overview || tmdbInfo?.overview,
      releaseDate: formatEpisodeReleaseDate(cinemetaEp?.released),
      runtimeLabel: formatMinutes(tmdbInfo?.runtime ?? titleRuntimeMinutes),
      ratingLabel,
      ratingSource,
      sizeLabel,
      isResumeTarget: resumeHint?.episodeKey
        ? resumeHint.episodeKey === stableKey
        : !!resumeHint?.episodeLink && src.link === resumeHint.episodeLink,
    };
  });

  // Reading-order Left/Right chain: reset at the top of every results
  // render; each focusable below adds itself, in visual order, via
  // `chain.propsFor(key)`.
  chain.beginRender();


  return (
    <View style={styles.resultsRoot}>
      <View style={styles.resultsBackdropLayer} pointerEvents="none">
        {banner ? (
          <Image source={{ uri: banner }} style={styles.resultsBackdropImage} resizeMode="cover" />
        ) : null}
        <LinearGradient
          colors={['rgba(10, 10, 14, 0.4)', 'rgba(10, 10, 14, 0.4)', 'transparent']}
          locations={[0, 0.42, 0.85]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={styles.resultsLeftGradient}
        />
        <LinearGradient
          colors={['transparent', 'rgba(10, 10, 14, 0.4)', 'rgba(10, 10, 14, 0.4)']}
          locations={[0.2, 0.65, 1]}
          style={styles.resultsBottomGradient}
        />
      </View>

      {/* Back -- icon only, liquid-glass circle pinned to the top-left corner
          (outside the ScrollView so it never scrolls away). Rendered before the
          ScrollView so it stays first in the reading-order focus chain. */}
      <TVFocusablePressable
        key={keyFor('results:back')}
        ref={(el) => setItemRef('results:back', el)}
        {...chain.propsFor('results:back')}
        hasTVPreferredFocus={shouldPreferResultsFocus('results:back', true)}
        onFocus={() => {
          noteResultsFocus('results:back');
          resultsScrollRef.current?.scrollTo({ x: 0, y: 0, animated: false });
        }}
        scaleFocused={1.1}
        focusedBorderColor="#FFFFFF"
        borderRadius={BACK_SIZE / 2}
        onPress={backToBrowse}
        style={local.backGlass}
        accessibilityLabel="Back"
      >
        {({ focused }) => (
          <View style={local.backGlassInner}>
            <LinearGradient
              pointerEvents="none"
              colors={
                focused
                  ? ['rgba(255,255,255,0.42)', 'rgba(255,255,255,0.12)', 'rgba(255,255,255,0.24)']
                  : ['rgba(255,255,255,0.26)', 'rgba(255,255,255,0.05)', 'rgba(255,255,255,0.12)']
              }
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={local.backGlassFill}
            />
            <View pointerEvents="none" style={local.backGlassTopEdge} />
            <View pointerEvents="none" style={local.backGlassRim} />
            <MaterialCommunityIcons name="arrow-left" size={22} color="#FFFFFF" />
          </View>
        )}
      </TVFocusablePressable>

      <ScrollView
        ref={resultsScrollRef}
        style={styles.resultsScrollView}
        contentContainerStyle={[styles.resultsScrollContent, local.scrollContentTopClear]}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={onResultsScroll}
        onContentSizeChange={handleResultsContentSizeChange}
        // Clipping is OFF on purpose. With it on, every row scrolled out of
        // view is detached from the window, which broke two things here:
        //  1. Coming back from the player, the episode/button the person
        //     left off on (usually below the fold) had no attached view to
        //     take focus, so Android fell back to the first focusable (the
        //     Back button) and the page jumped to the top.
        //  2. The Left/Right reading-order links (useReadingOrderFocus) are
        //     explicit next-focus ids, which only resolve to attached views.
        // The old reason for keeping it on (winning a focus race against
        // the nav rail while this screen mounted) is gone: the rail is
        // hidden while page 2 is showing.
        removeClippedSubviews={false}
      >

        <View style={styles.cleanHeaderContainer}>
          {logoUrl ? (
            <Image
              source={{ uri: logoUrl }}
              style={styles.targetLogo}
              resizeMode="contain"
            />
          ) : (
            <Text style={styles.targetTitle}>{resultsTarget?.title}</Text>
          )}

          <View style={styles.metaRow}>
            {resultsTarget?.rating ? (
              <View style={styles.ratingBadge}>
                <Text style={styles.ratingText}>★ {resultsTarget.rating}</Text>
              </View>
            ) : null}
            {resultsTarget?.runtime ? (
              <Text style={styles.targetMetaText}>{resultsTarget.runtime}</Text>
            ) : null}
            {resultsTarget?.year ? <Text style={styles.targetMetaText}>{resultsTarget.year}</Text> : null}
            {resultsTarget?.genres && resultsTarget.genres.length > 0 ? (
              <Text style={styles.targetGenreText}>{resultsTarget.genres.join(' • ')}</Text>
            ) : null}
          </View>
          <Text numberOfLines={5} style={styles.targetOverview}>
            {resultsTarget?.overview || 'Select a matched addon source below to view stream links.'}
          </Text>
          {resultsTarget?.cast && resultsTarget.cast.length > 0 ? (
            <Text numberOfLines={1} style={styles.targetCastText}>
              <Text style={styles.targetCastLabel}>Cast: </Text>
              {resultsTarget.cast.slice(0, 3).join(', ')}
            </Text>
          ) : null}
        </View>

        <View style={styles.sectionContainer}>
          <Text style={styles.sectionHeader}>Matching Addon Sources</Text>
          {matchedAddonPosts.length === 0 ? (
            resultsLoading ? (
              <View style={styles.loadingRow}>
                <ActivityIndicator size="small" color="#8A5CF6" />
                <Text style={styles.loadingText}>Searching installed addons for exact matches...</Text>
              </View>
            ) : (
              <Text style={styles.emptySubtitle}>No matching releases found in your installed addons.</Text>
            )
          ) : (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.sourcesRow}
              scrollEventThrottle={16}
            >
              {matchedAddonPosts.map((post, idx) => {
                const isSelected = activeSourcePost?.link === post.link;
                const isFirst = idx === 0;
                const sourceKey = `results:source:${post.link}:${idx}`;
                const isResumeSource =
                  !!resumeHint &&
                  ((resumeHint.infoUrl && post.link === resumeHint.infoUrl) ||
                    (!resumeHint.infoUrl && resumeHint.providerValue === post.provider));
                return (
                  <TVFocusablePressable
                    key={keyFor(sourceKey)}
                    ref={(el) => {
                      setItemRef(sourceKey, el);
                      if (isFirst) sourcesRowFirstRef.current = el;
                    }}
                    {...chain.propsFor(sourceKey)}
                    hasTVPreferredFocus={
                      resumeHint
                        ? shouldPreferResultsFocus(sourceKey, isResumeSource)
                        : shouldPreferResultsFocus(sourceKey, false)
                    }
                    scaleFocused={1.04}
                    focusedBorderColor="#8A5CF6"
                    borderRadius={10}
                    onFocus={() => {
                      noteResultsFocus(sourceKey, isResumeSource);
                      if (isFirst) registerRailLeftEdge('discover', sourcesRowFirstRef.current);
                    }}
                    onPress={() => handleSelectSourceCard(post)}
                    style={[styles.sourceCard, isSelected && styles.sourceCardActive]}
                  >
                    {({ focused }) => (
                      <View style={styles.sourceCardInner}>
                        <Image
                          source={{
                            uri: post.image || resultsTarget?.poster || 'https://placehold.jp/24/363636/ffffff/200x300.png?text=Vega',
                          }}
                          style={styles.sourcePoster}
                          resizeMode="cover"
                        />
                        {isResumeSource && (
                          <View style={styles.sourceResumeBadge}>
                            <Text style={styles.sourceResumeBadgeText}>Resume</Text>
                          </View>
                        )}
                        <View style={styles.sourceBadge}>
                          <Text numberOfLines={1} style={styles.sourceBadgeText}>
                            {post.provider}
                          </Text>
                        </View>
                        {focused && <View style={styles.focusBorderGlow} />}
                      </View>
                    )}
                  </TVFocusablePressable>
                );
              })}
              {resultsLoading ? (
                // Still searching the remaining addons -- more cards will
                // be appended after these as they are confirmed.
                <View style={styles.sourcesLoadingTail}>
                  <ActivityIndicator size="small" color="#8A5CF6" />
                </View>
              ) : null}
            </ScrollView>
          )}
        </View>

        {activeSourcePost && (
          <View style={styles.sectionContainer}>
            <Text style={styles.sectionHeader}>
              Episodes & Streams ({activeSourcePost.provider})
            </Text>

            {loadingSourceInfo || extractingLink || isAwaitingEpisodes ? (
              <View style={styles.loadingRow}>
                <ActivityIndicator size="small" color="#8A5CF6" />
                <Text style={styles.loadingText}>
                  {extractingLink
                    ? 'Extracting stream link...'
                    : loadingSourceInfo
                    ? 'Loading media details...'
                    : 'Loading episodes...'}
                </Text>
              </View>
            ) : !sourceInfo ? (
              <Text style={styles.emptySubtitle}>
                Could not load details from this source. Try another source above.
              </Text>
            ) : (
              <View style={styles.pickerSection}>
                {usableLinkList.length > 1 &&
                  (!isSeries ||
                    usableLinkList.some((l) => Boolean(l.episodesLink)) ||
                    parseSeasonNumber(usableLinkList[0]?.title) !== null) && (
                  <View style={styles.subBlock}>
                    <Text style={styles.subHeader}>Seasons &amp; Quality</Text>
                    {/* Single trigger button that opens the season/quality
                        picker popup below -- same picker TVDetailsScreen
                        uses, rather than an inline (and, with many
                        options, multi-row) chip list. One reading-order
                        stop here regardless of how many options exist. */}
                    <TVFocusablePressable
                      key={keyFor('results:linkPicker')}
                      ref={(el) => setItemRef('results:linkPicker', el)}
                      {...chain.propsFor('results:linkPicker')}
                      hasTVPreferredFocus={shouldPreferResultsFocus('results:linkPicker', false)}
                      onFocus={() => {
                        noteResultsFocus('results:linkPicker');
                      }}
                      scaleFocused={1.03}
                      focusedBorderColor="#8A5CF6"
                      borderRadius={10}
                      onPress={() => setSeasonPickerVisible(true)}
                      style={styles.seasonPickerBtn}
                    >
                      {() => (
                        <View style={styles.seasonPickerBtnInner}>
                          <MaterialCommunityIcons name="playlist-play" size={18} color="#FFFFFF" />
                          <Text style={styles.seasonPickerBtnText}>
                            {activeLink?.title || 'Select'}
                            {activeLink?.quality ? ` • ${activeLink.quality}` : ''}
                          </Text>
                          <MaterialCommunityIcons name="chevron-down" size={20} color="#C4B5FD" />
                        </View>
                      )}
                    </TVFocusablePressable>
                  </View>
                )}

                {isSeries ? (
                  episodesLoading ? (
                    <View style={styles.loadingRow}>
                      <ActivityIndicator size="small" color="#8A5CF6" />
                      <Text style={styles.loadingText}>Loading episodes...</Text>
                    </View>
                  ) : episodeCards.length > 0 ? (
                    <View style={local.episodesBlock}>
                      <Text style={styles.subHeader}>Episodes</Text>
                      {/* Horizontal episode cards -- same card as TVDetailsScreen
                          (still, number, title, synopsis, runtime, rating, date).
                          Each card is its own native focus target, chained into
                          the page's Left/Right reading order; the row follows
                          focus. Explicit pixel sizes: Fabric collapses %-sized
                          containers on TV. */}
                      <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        removeClippedSubviews={false}
                        style={local.episodesRow}
                        contentContainerStyle={local.episodesRowContent}
                      >
                        {episodeCards.map((card, cardIdx) => {
                          // Keep the card's place in the reading-order chain,
                          // but nothing sits left of the first card or right
                          // of the last one: those keys must not move focus
                          // (the default search would jump to the credits).
                          const links: { nextFocusLeft?: number; nextFocusRight?: number } = {
                            ...chain.propsFor(card.focusKey),
                          };
                          const selfHandle = episodeNodesRef.current[card.focusKey]
                            ? findNodeHandle(episodeNodesRef.current[card.focusKey]) ?? undefined
                            : undefined;
                          if (cardIdx === 0) links.nextFocusLeft = selfHandle;
                          if (cardIdx === episodeCards.length - 1) links.nextFocusRight = selfHandle;
                          return (
                          <TVFocusablePressable
                            key={keyFor(card.focusKey)}
                            ref={(el) => {
                              episodeNodesRef.current[card.focusKey] = el;
                              setItemRef(card.focusKey, el);
                            }}
                            {...links}
                            hasTVPreferredFocus={
                              resumeHint?.episodeKey || resumeHint?.episodeLink
                                ? shouldPreferResultsFocus(card.focusKey, card.isResumeTarget)
                                : shouldPreferResultsFocus(card.focusKey, false)
                            }
                            onFocus={() => {
                              noteResultsFocus(card.focusKey);
                              // Stremio addon: warm this episode's (and the
                              // next one's) server/quality list.
                              if (isStremioProvider(activeSourcePost?.provider)) {
                                scheduleStremioStreamPrefetch(activeSourcePost!.provider!, [
                                  card.link,
                                  episodeCards[cardIdx + 1]?.link,
                                ]);
                              }
                            }}
                            scaleFocused={1.04}
                            focusedBorderColor="#8A5CF6"
                            borderRadius={12}
                            onPress={() =>
                              handleResolveAndPlay(
                                card.link,
                                sourceInfo?.title ||
                                  activeSourcePost?.title ||
                                  resultsTarget?.title ||
                                  card.rawTitle ||
                                  `Episode ${card.index + 1}`,
                                'series',
                                card.index,
                                playerEpisodes,
                                card.stableKey,
                              )
                            }
                            style={local.hCard}
                          >
                            {() => (
                              <EpisodeCardBody
                                card={card}
                                resumePosition={card.isResumeTarget ? resumeHint?.position : undefined}
                              />
                            )}
                          </TVFocusablePressable>
                          );
                        })}
                      </ScrollView>
                    </View>
                  ) : (
                    <Text style={styles.emptySubtitle}>No episodes found for this season.</Text>
                  )
                ) : usableDirectItems.length > 1 ? (
                  <View style={styles.subBlock}>
                    <Text style={styles.subHeader}>Play</Text>
                    <View style={styles.chipsRow}>
                      {usableDirectItems.map((d, idx) => (
                        <TVFocusablePressable
                          key={keyFor(`results:direct:${idx}`)}
                          ref={(el) => setItemRef(`results:direct:${idx}`, el)}
                          {...chain.propsFor(`results:direct:${idx}`)}
                          hasTVPreferredFocus={shouldPreferResultsFocus(`results:direct:${idx}`, false)}
                          onFocus={() => {
                            noteResultsFocus(`results:direct:${idx}`);
                          }}
                          scaleFocused={1.04}
                          focusedBorderColor="#FFFFFF"
                          borderRadius={8}
                          onPress={() =>
                            handleResolveAndPlay(
                              d.link,
                              activeSourcePost?.title || resultsTarget?.title || d.title,
                              d.type || (isSeries ? 'series' : 'movie'),
                              idx,
                              isSeries && usableDirectItems.length > 0
                                ? usableDirectItems.map((item, i) => ({
                                    title: item.title || `Episode ${i + 1}`,
                                    link: item.link,
                                    image: item.image,
                                    description: item.description,
                                    skip: item.skip,
                                  }))
                                : undefined,
                              activeSourcePost?.link,
                            )
                          }
                          style={styles.qualityChip}
                        >
                          {() => (
                            <View style={styles.chipInner}>
                              <MaterialCommunityIcons name="quality-high" size={16} color="#8A5CF6" />
                              <Text style={styles.chipText}>{d.title || `Source ${idx + 1}`}</Text>
                            </View>
                          )}
                        </TVFocusablePressable>
                      ))}
                    </View>
                  </View>
                ) : (
                  (() => {
                    // A movie CW entry has no episodeKey/episodeLink to
                    // disambiguate (see ContinueWatchingItem) -- their
                    // absence alongside a saved position is exactly what
                    // marks this resumeHint as belonging to this single
                    // movie stream, same as TVDetailsScreen's "Resume
                    // Movie / Stream" button label.
                    const isMovieResume =
                      !!resumeHint &&
                      !resumeHint.episodeKey &&
                      !resumeHint.episodeLink &&
                      !!resumeHint.position;
                    // A single direct link (one server/quality) is still
                    // the real target to play -- fall back to the source
                    // post's own link only when the provider gave no
                    // direct link at all.
                    const singleDirect = usableDirectItems[0];
                    const playLink = singleDirect?.link || activeSourcePost?.link;
                    const playType = singleDirect?.type || 'movie';
                    return (
                      <TVFocusablePressable
                        key={keyFor('results:direct-stream-btn')}
                        ref={(el) => setItemRef('results:direct-stream-btn', el)}
                        {...chain.propsFor('results:direct-stream-btn')}
                        hasTVPreferredFocus={
                          resumeHint
                            ? shouldPreferResultsFocus('results:direct-stream-btn', isMovieResume)
                            : shouldPreferResultsFocus('results:direct-stream-btn', false)
                        }
                        onFocus={() => {
                          noteResultsFocus('results:direct-stream-btn');
                        }}
                        scaleFocused={1.06}
                        focusedBorderColor="#FFFFFF"
                        borderRadius={14}
                        onPress={() =>
                          playLink &&
                          handleResolveAndPlay(
                            playLink,
                            activeSourcePost?.title || resultsTarget?.title || singleDirect?.title,
                            playType,
                            0,
                            undefined,
                            activeSourcePost?.link,
                          )
                        }
                        style={styles.directStreamBtn}
                      >
                        {() => (
                          <View style={styles.directBtnInner}>
                            <MaterialCommunityIcons name="play" size={26} color="#FFFFFF" />
                            <Text style={styles.directBtnText}>
                              {isMovieResume
                                ? `Resume ${Math.floor((resumeHint!.position || 0) / 60)}:${String(
                                    Math.floor((resumeHint!.position || 0) % 60),
                                  ).padStart(2, '0')}`
                                : 'Play Movie / Stream'}
                            </Text>
                          </View>
                        )}
                      </TVFocusablePressable>
                    );
                  })()
                )}
              </View>
            )}
          </View>
        )}

        {/* Director / creator + top cast, with photos -- same strip as
            TVDetailsScreen: one horizontal row that scrolls as focus moves. */}
        {credits.directors.length + credits.cast.length > 0 && (
          <View
            style={local.creditsSection}
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
              style={{
                width: SCREEN_WIDTH - RESULTS_LEFT_INSET - RESULTS_RIGHT_INSET,
                height: CREDIT_ROW_H,
              }}
              contentContainerStyle={local.creditsRow}
            >
              {credits.directors.map((p) => {
                const key = `dir-${p.id ?? p.name}`;
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
              {credits.directors.length > 0 && credits.cast.length > 0 ? (
                <View style={local.creditsDivider} />
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
      </ScrollView>

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
                maxWidth: Math.min(SCREEN_WIDTH * 0.7, 900),
                maxHeight: SCREEN_HEIGHT * 0.8,
              },
            ]}
          >
            <View style={styles.pickerHeader}>
              <MaterialCommunityIcons name="playlist-play" size={22} color="#A78BFA" />
              <View style={styles.pickerHeaderText}>
                <Text style={styles.pickerTitle}>Select Season / Quality</Text>
                <Text style={styles.pickerSubtitle}>
                  {usableLinkList.length} options • choose which source to load episodes from
                </Text>
              </View>
            </View>
            <View style={styles.pickerDivider} />
            <ScrollView
              style={styles.pickerList}
              contentContainerStyle={styles.pickerListContent}
              showsVerticalScrollIndicator={false}
            >
              {usableLinkList.map((l, idx) => {
                const isActive = idx === activeLinkIndex;
                return (
                  <TVFocusablePressable
                    key={`results-season-opt-${l.title}-${idx}`}
                    hasTVPreferredFocus={isActive}
                    scaleFocused={1.02}
                    focusedBorderColor="#8A5CF6"
                    borderRadius={10}
                    onPress={() => {
                      onSelectLink(idx);
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
                          <View style={styles.pickerSizeBadge}>
                            <Text style={styles.pickerSizeBadgeText}>{getFileSizeLabel({ size: l.size })}</Text>
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
              style={styles.pickerCancelBtn}
            >
              {() => <Text style={styles.pickerCancelText}>Cancel</Text>}
            </TVFocusablePressable>
          </View>
        </View>
      </Modal>
    </View>
  );
};

const local = StyleSheet.create({
  // Liquid-glass circular back button, top-left. Plain translucent layers (sheen
  // gradient, bright top edge, hairline border) rather than a live backdrop blur.
  backGlass: {
    position: 'absolute',
    top: 12,
    left: 20,
    width: BACK_SIZE,
    height: BACK_SIZE,
    backgroundColor: 'rgba(255, 255, 255, 0.10)',
    borderColor: 'rgba(255, 255, 255, 0.28)',
    overflow: 'hidden',
    zIndex: 20,
  },
  backGlassInner: {
    width: BACK_SIZE - 4,
    height: BACK_SIZE - 4,
    justifyContent: 'center',
    alignItems: 'center',
  },
  backGlassFill: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: BACK_SIZE - 4,
    height: BACK_SIZE - 4,
  },
  backGlassTopEdge: {
    position: 'absolute',
    top: 0,
    left: 8,
    right: 8,
    height: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.55)',
  },
  // Hairline rim (the pressable's own border is reserved for the focus ring).
  backGlassRim: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: BACK_SIZE - 4,
    height: BACK_SIZE - 4,
    borderRadius: (BACK_SIZE - 4) / 2,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.28)',
  },
  // Clears the pinned back button.
  scrollContentTopClear: {
    paddingTop: 68,
  },

  // Horizontal episode cards.
  episodesBlock: {
    marginTop: 4,
  },
  episodesRow: {
    width: SCREEN_WIDTH - RESULTS_LEFT_INSET,
    height: EPISODE_CARD_H + EPISODE_ROW_PAD_V * 2,
    // Cancels the row's own left padding so the first card lines up with the text.
    marginLeft: -EPISODE_ROW_PAD_H,
  },
  episodesRowContent: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: EPISODE_ROW_PAD_V,
    paddingHorizontal: EPISODE_ROW_PAD_H,
  },
  hCard: {
    width: EPISODE_CARD_W,
    height: EPISODE_CARD_H,
    marginRight: EPISODE_CARD_GAP,
    backgroundColor: '#16161E',
    borderColor: 'rgba(255, 255, 255, 0.08)',
    overflow: 'hidden',
  },
  // The pressable has a 2px border; the content fills what is inside it.
  hCardInner: {
    width: EPISODE_CARD_W - 4,
    height: EPISODE_CARD_H - 4,
  },
  hCardImage: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: EPISODE_CARD_W - 4,
    height: EPISODE_CARD_H - 4,
  },
  hCardScrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: EPISODE_CARD_W - 4,
    height: EPISODE_CARD_H - 4,
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
  hSizeBadge: {
    position: 'absolute',
    top: 8,
    left: 8,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    borderRadius: 5,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  hSizeBadgeText: {
    color: '#E5E7EB',
    fontSize: 10,
    fontWeight: '700',
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
});

export default TVDiscoverResultsView;
