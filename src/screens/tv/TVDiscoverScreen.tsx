import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
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
} from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import KeyEvent from 'react-native-keyevent';
import { TVFocusablePressable } from '../../components/tv/TVFocusablePressable';
import { TVNoProviderFallback } from '../../components/tv/TVNoProviderFallback';
import { TVHeroMeta, TVHeroMedia } from '../../components/tv/TVHeroMeta';
import { TVRoute } from '../../components/tv/TVNavigationRail';
import useContentStore from '../../lib/zustand/contentStore';
import useContinueWatchingStore from '../../lib/zustand/continueWatchingStore';
import { providerManager } from '../../lib/services/ProviderManager';
import { Post, Info, Link, EpisodeLink, Stream } from '../../lib/providers/types';
import {
  loadDiscoverCatalogs,
  fetchCatalogItems,
  fetchItemMeta,
  clearManifestCache,
  DiscoverCatalog,
  CatalogMediaItem,
} from '../../lib/services/stremioCatalog';
import { isStrictMatch } from '../../lib/utils/titleMatcher';
import { parseSeasonNumber, parseEpisodeNumber, sortEpisodesChronologically } from '../../lib/utils/episodeParsing';
import {
  fetchMatchingCinemetaMeta,
  findCinemetaEpisode,
  CinemetaMeta,
} from '../../lib/services/cinemetaService';
import {
  stremioCatalogStorage,
  StremioManifestEntry,
  HiddenCatalogEntry,
  settingsStorage,
} from '../../lib/storage';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

const CONTAINER_PADDING_LEFT = 88;
const CONTAINER_PADDING_RIGHT = 40;
const GRID_GAP = 14;
const GRID_COLUMNS = 6;
const CARD_WIDTH = Math.floor(
  (SCREEN_WIDTH - CONTAINER_PADDING_LEFT - CONTAINER_PADDING_RIGHT - GRID_GAP * (GRID_COLUMNS - 1)) /
    GRID_COLUMNS,
);
const CARD_HEIGHT = Math.round(CARD_WIDTH * 1.5);

const CATALOG_TYPE_LABEL: Record<string, string> = {
  movie: 'Movies',
  series: 'Shows',
  channel: 'Channels',
  tv: 'TV',
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

interface TVDiscoverScreenProps {
  onSelectItem: (item: Post) => void;
  onNavigateRoute?: (route: TVRoute) => void;
  onPlayStream?: (streamUrl: string, title?: string, extraMeta?: any) => void;
  discoverFocusTarget?: number | null;
  onRegisterBackHandler?: (handler: (() => boolean) | null) => void;
}

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

interface SavedDiscoverState {
  catalogs?: DiscoverCatalog[];
  selectedCatalog?: DiscoverCatalog | null;
  items?: CatalogMediaItem[];
  skip?: number;
  hasMore?: boolean;
  activeHero?: TVHeroMedia | null;

  screenMode: 'browse' | 'results';
  resultsTarget: (CatalogMediaItem & { logo?: string }) | null;
  matchedAddonPosts: Post[];
  activeSourcePost: Post | null;
  sourceInfo: Info | null;
  activeLinkIndex: number;
  episodes: EpisodeLink[];
}

let savedDiscoverState: SavedDiscoverState | null = null;

export const TVDiscoverScreen: React.FC<TVDiscoverScreenProps> = ({
  onSelectItem,
  onNavigateRoute,
  onPlayStream,
  discoverFocusTarget,
  onRegisterBackHandler,
}) => {
  const installedProviders = useContentStore((state) => state.installedProviders);
  const [manifests, setManifests] = useState<StremioManifestEntry[]>([]);
  const [catalogs, setCatalogs] = useState<DiscoverCatalog[]>(savedDiscoverState?.catalogs || []);
  const [hiddenCatalogs, setHiddenCatalogs] = useState<HiddenCatalogEntry[]>([]);
  const [catalogsLoading, setCatalogsLoading] = useState(
    savedDiscoverState?.catalogs && savedDiscoverState.catalogs.length > 0 ? false : true,
  );
  const [catalogsError, setCatalogsError] = useState<string | null>(null);
  const [selectedCatalog, setSelectedCatalog] = useState<DiscoverCatalog | null>(
    savedDiscoverState?.selectedCatalog ?? null,
  );
  const [items, setItems] = useState<CatalogMediaItem[]>(savedDiscoverState?.items || []);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [skip, setSkip] = useState(savedDiscoverState?.skip ?? 0);
  const [hasMore, setHasMore] = useState(savedDiscoverState?.hasMore ?? true);
  const [activeHero, setActiveHero] = useState<TVHeroMedia | null>(savedDiscoverState?.activeHero ?? null);
  const heroRequestIdRef = useRef(0);

  const [screenMode, setScreenMode] = useState<'browse' | 'results'>(
    savedDiscoverState?.screenMode || 'browse',
  );
  const [resultsTarget, setResultsTarget] = useState<(CatalogMediaItem & { logo?: string }) | null>(
    savedDiscoverState?.resultsTarget ?? null,
  );
  const [resultsLoading, setResultsLoading] = useState(false);
  const [matchedAddonPosts, setMatchedAddonPosts] = useState<Post[]>(
    savedDiscoverState?.matchedAddonPosts || [],
  );
  const resolveAbortRef = useRef<AbortController | null>(null);

  const [activeSourcePost, setActiveSourcePost] = useState<Post | null>(
    savedDiscoverState?.activeSourcePost ?? null,
  );
  const [sourceInfo, setSourceInfo] = useState<Info | null>(
    savedDiscoverState?.sourceInfo ?? null,
  );
  const [loadingSourceInfo, setLoadingSourceInfo] = useState(false);
  const [activeLinkIndex, setActiveLinkIndex] = useState(
    savedDiscoverState?.activeLinkIndex ?? 0,
  );
  const [episodes, setEpisodes] = useState<EpisodeLink[]>(
    savedDiscoverState?.episodes || [],
  );
  const [episodesLoading, setEpisodesLoading] = useState(false);

  const [sourceCinemetaMeta, setSourceCinemetaMeta] = useState<CinemetaMeta | null>(null);
  const [extractingLink, setExtractingLink] = useState(false);

  const [manageVisible, setManageVisible] = useState(false);
  const [manifestInput, setManifestInput] = useState('');
  const [addingManifest, setAddingManifest] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const focusedPillRef = useRef<DiscoverCatalog | null>(null);
  const selectHoldStreakRef = useRef(0);
  const lastSelectKeyTimeRef = useRef(0);
  const [catalogToHide, setCatalogToHide] = useState<DiscoverCatalog | null>(null);

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

  const focusHero = useCallback(
    (item: CatalogMediaItem, baseEndpoint: string) => {
      setActiveHero(heroFor(item));
      if (item.banner) return;
      const metaId = item.imdb_id || item.id;
      if (!metaId) return;
      const requestId = ++heroRequestIdRef.current;
      fetchItemMeta(baseEndpoint, item.type, metaId).then((meta) => {
        if (!meta?.background) return;
        if (heroRequestIdRef.current !== requestId) return;
        setActiveHero((prev) =>
          prev && prev.title === item.title
            ? { ...prev, backdropUrl: meta.background, isPosterFallback: false }
            : prev,
        );
      });
    },
    [heroFor],
  );

  const reloadCatalogs = useCallback(async (keepSelection = true) => {
    setCatalogsLoading(true);
    setCatalogsError(null);
    const list = stremioCatalogStorage.getManifests();
    setManifests(list);
    setHiddenCatalogs(stremioCatalogStorage.getHiddenCatalogs());
    if (list.length === 0) {
      setCatalogs([]);
      setSelectedCatalog(null);
      setCatalogsLoading(false);
      return;
    }
    const loaded = await loadDiscoverCatalogs(list);
    setCatalogs(loaded);
    if (loaded.length === 0) {
      setCatalogsError('None of your added catalogs could be loaded.');
      setSelectedCatalog(null);
    } else {
      setSelectedCatalog((prev) => {
        const target = prev || savedDiscoverState?.selectedCatalog;
        if (keepSelection && target) {
          const stillThere = loaded.find((c) => catalogKey(c) === catalogKey(target));
          if (stillThere) return stillThere;
        }
        const available = loaded.filter(
          (c) => !stremioCatalogStorage.getHiddenCatalogs().some((h) => h.key === catalogKey(c)),
        );
        return available[0] || loaded[0];
      });
    }
    setCatalogsLoading(false);
  }, []);

  useEffect(() => {
    reloadCatalogs(true);
  }, [reloadCatalogs]);

  useEffect(() => {
    if (!selectedCatalog) {
      setItems([]);
      setActiveHero(null);
      return;
    }
    if (savedDiscoverState?.screenMode === 'results' && items.length > 0) {
      return;
    }
    if (
      savedDiscoverState?.selectedCatalog &&
      catalogKey(selectedCatalog) === catalogKey(savedDiscoverState.selectedCatalog) &&
      items.length > 0
    ) {
      return;
    }
    let isMounted = true;
    async function loadCatalogData() {
      setItemsLoading(true);
      setSkip(0);
      setHasMore(true);
      const res = await fetchCatalogItems(
        selectedCatalog!.baseEndpoint,
        selectedCatalog!.type,
        selectedCatalog!.id,
        0,
      );
      if (!isMounted) return;
      setItems(res);
      setHasMore(res.length > 0);
      if (savedDiscoverState) {
        savedDiscoverState.selectedCatalog = selectedCatalog;
        savedDiscoverState.items = res;
        savedDiscoverState.skip = 0;
        savedDiscoverState.hasMore = res.length > 0;
      }
      if (res.length > 0) {
        focusHero(res[0], selectedCatalog!.baseEndpoint);
      } else {
        setActiveHero(null);
      }
      setItemsLoading(false);
    }
    loadCatalogData();
    return () => {
      isMounted = false;
    };
  }, [selectedCatalog, focusHero]);

  useEffect(() => {
    const KEYCODE_DPAD_CENTER = 23;
    const KEYCODE_ENTER = 66;
    const handleKeyDown = (e: { keyCode?: number }) => {
      if (e?.keyCode !== KEYCODE_DPAD_CENTER && e?.keyCode !== KEYCODE_ENTER) return;
      if (!focusedPillRef.current || screenMode === 'results') return;
      const now = Date.now();
      if (now - lastSelectKeyTimeRef.current > 400) {
        selectHoldStreakRef.current = 0;
      }
      lastSelectKeyTimeRef.current = now;
      selectHoldStreakRef.current += 1;
      if (selectHoldStreakRef.current >= 3) {
        selectHoldStreakRef.current = 0;
        setCatalogToHide(focusedPillRef.current);
      }
    };
    KeyEvent.onKeyDownListener(handleKeyDown);
    return () => KeyEvent.removeKeyDownListener();
  }, [screenMode]);

  const handleLoadMore = useCallback(async () => {
    if (!selectedCatalog || loadingMore || !hasMore) return;
    setLoadingMore(true);
    const nextSkip = skip + items.length;
    const more = await fetchCatalogItems(
      selectedCatalog.baseEndpoint,
      selectedCatalog.type,
      selectedCatalog.id,
      nextSkip,
    );
    setItems((prev) => {
      const next = [...prev, ...more];
      if (savedDiscoverState) {
        savedDiscoverState.items = next;
        savedDiscoverState.skip = nextSkip;
        savedDiscoverState.hasMore = more.length > 0;
      }
      return next;
    });
    setHasMore(more.length > 0);
    setSkip(nextSkip);
    setLoadingMore(false);
  }, [selectedCatalog, loadingMore, hasMore, skip, items.length]);

  const handleItemPress = useCallback(
    async (item: CatalogMediaItem) => {
      if (resolveAbortRef.current) {
        resolveAbortRef.current.abort();
      }
      const controller = new AbortController();
      resolveAbortRef.current = controller;
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
        items,
        skip,
        hasMore,
        activeHero,
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
          if (cMeta?.logo) {
            setResultsTarget((prev) => {
              const next = prev ? { ...prev, logo: cMeta.logo } : prev;
              if (savedDiscoverState) savedDiscoverState.resultsTarget = next;
              return next;
            });
          }
        });
      }

      const matches: Post[] = [];
      await Promise.allSettled(
        installedProviders.map(async (provider) => {
          try {
            const data = await providerManager.getSearchPosts({
              searchQuery: item.title,
              page: 1,
              providerValue: provider.value,
              signal: controller.signal,
            });
            const posts = normalizeSearchResult(data, provider.value);
            posts.forEach((post) => {
              if (isStrictMatch(item.title, post.title, item.year, (post as any).year)) {
                matches.push(post);
              }
            });
          } catch (e) {
            if ((e as any)?.name !== 'AbortError') {
              console.warn(`[Discover] Match error on ${provider.value}:`, e);
            }
          }
        }),
      );
      if (controller.signal.aborted) return;
      setMatchedAddonPosts(matches);
      setResultsLoading(false);
      if (savedDiscoverState) {
        savedDiscoverState.matchedAddonPosts = matches;
      }
    },
    [installedProviders, selectedCatalog, catalogs, items, skip, hasMore, activeHero],
  );

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

  const handleBackToSources = useCallback(() => {
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
    setSourceCinemetaMeta(null);
    const imdbId = sourceInfo?.imdbId || resultsTarget?.imdb_id || resultsTarget?.id;
    const type = sourceInfo?.type || resultsTarget?.type;
    if (imdbId && type) {
      fetchMatchingCinemetaMeta(imdbId, type, sourceInfo?.title || resultsTarget?.title).then((meta) => {
        if (isMounted) setSourceCinemetaMeta(meta);
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

        const best = usableStreams[0];
        const qualities = usableStreams.map((s, idx) => ({
          name: s.quality ? `${s.quality}p` : s.server || `Source ${idx + 1}`,
          url: s.link,
          headers: s.headers,
          sourceType: s.type,
        }));

        const episodesToSend =
          customEpisodes && customEpisodes.length > 0
            ? customEpisodes
            : episodes && episodes.length > 0
            ? episodes
            : undefined;

        if (savedDiscoverState) {
          savedDiscoverState.screenMode = 'results';
          savedDiscoverState.resultsTarget = resultsTarget;
          savedDiscoverState.matchedAddonPosts = matchedAddonPosts;
          savedDiscoverState.activeSourcePost = activeSourcePost;
          savedDiscoverState.sourceInfo = sourceInfo;
          savedDiscoverState.activeLinkIndex = activeLinkIndex;
          savedDiscoverState.episodes = episodesToSend || episodes;
        }

        const canonicalKey = episodeKey || link || activeSourcePost?.link;
        const resumePos = getSavedResumePosition(canonicalKey);

        onPlayStream(best.link, title, {
          posterUrl: sourceInfo?.image || sourceInfo?.poster || activeSourcePost?.image || resultsTarget?.poster,
          itemLink: activeSourcePost?.link,
          episodeId: canonicalKey,
          startPosition: resumePos,
          providerValue,
          episodes: episodesToSend,
          currentEpisodeIndex: episodeIdx,
          qualities,
          headers: best.headers,
          sourceType: best.type,
          subtitles: best.subtitles,
        });
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
      getSavedResumePosition,
    ],
  );

  const backToBrowse = useCallback(() => {
    if (activeSourcePost) {
      handleBackToSources();
      return;
    }
    if (resolveAbortRef.current) resolveAbortRef.current.abort();
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

  // Hardware Back Key: only handle this screen's own back-stack (closing the
  // manage/hide-catalog dialogs, or dropping from Page 2 results back to Page
  // 1 browse). If none of that applies, report "not handled" so App.tsx moves
  // focus to the Discover button on the rail.
  useEffect(() => {
    const handleBack = () => {
      if (manageVisible) {
        setManageVisible(false);
        return true;
      }
      if (catalogToHide) {
        setCatalogToHide(null);
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
  }, [screenMode, manageVisible, catalogToHide, backToBrowse, onRegisterBackHandler]);

  useEffect(() => {
    return () => {
      if (resolveAbortRef.current) resolveAbortRef.current.abort();
    };
  }, []);

  const handleHideCatalog = useCallback((cat: DiscoverCatalog) => {
    stremioCatalogStorage.hideCatalog({
      key: catalogKey(cat),
      name: catalogDisplayName(cat),
      manifestName: cat.manifestName,
    });
    setHiddenCatalogs(stremioCatalogStorage.getHiddenCatalogs());
    setSelectedCatalog((prev) => {
      if (prev && catalogKey(prev) === catalogKey(cat)) {
        const stillVisible = catalogs.find(
          (c) => catalogKey(c) !== catalogKey(cat) && !hiddenKeySet.has(catalogKey(c)),
        );
        return stillVisible || null;
      }
      return prev;
    });
    try {
      ToastAndroid.show(`Hidden "${catalogDisplayName(cat)}"`, ToastAndroid.SHORT);
    } catch {}
  }, [catalogs, hiddenKeySet]);

  const handleRestoreCatalog = useCallback((key: string) => {
    stremioCatalogStorage.unhideCatalog(key);
    setHiddenCatalogs(stremioCatalogStorage.getHiddenCatalogs());
  }, []);

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

        <ScrollView
          style={styles.resultsScrollView}
          contentContainerStyle={styles.resultsScrollContent}
          showsVerticalScrollIndicator={false}
          scrollEventThrottle={16}
          removeClippedSubviews={true}
        >
          <TVFocusablePressable
            hasTVPreferredFocus={true}
            scaleFocused={1.04}
            focusedBorderColor="#8A5CF6"
            borderRadius={8}
            {...(discoverFocusTarget ? { nextFocusLeft: discoverFocusTarget } : {})}
            onPress={backToBrowse}
            style={styles.backBtn}
          >
            {() => (
              <View style={styles.backBtnInner}>
                <MaterialCommunityIcons name="arrow-left" size={18} color="#FFFFFF" />
                <Text style={styles.backBtnText}>
                  {activeSourcePost ? 'Back to Sources' : 'Back to Discover'}
                </Text>
              </View>
            )}
          </TVFocusablePressable>

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
              {resultsTarget?.year ? <Text style={styles.targetMetaText}>{resultsTarget.year}</Text> : null}
              {resultsTarget?.genres && resultsTarget.genres.length > 0 ? (
                <Text style={styles.targetMetaText}>{resultsTarget.genres.join(' • ')}</Text>
              ) : null}
            </View>
            <Text numberOfLines={4} style={styles.targetOverview}>
              {resultsTarget?.overview || 'Select a matched addon source below to view stream links.'}
            </Text>
          </View>

          <View style={styles.sectionContainer}>
            <Text style={styles.sectionHeader}>Matching Addon Sources</Text>
            {resultsLoading ? (
              <View style={styles.loadingRow}>
                <ActivityIndicator size="small" color="#8A5CF6" />
                <Text style={styles.loadingText}>Searching installed addons for exact matches...</Text>
              </View>
            ) : matchedAddonPosts.length === 0 ? (
              <Text style={styles.emptySubtitle}>No matching releases found in your installed addons.</Text>
            ) : (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.sourcesRow}
                scrollEventThrottle={16}
              >
                {matchedAddonPosts.map((post, idx) => {
                  const isSelected = activeSourcePost?.link === post.link;
                  return (
                    <TVFocusablePressable
                      key={`${post.link}-${idx}`}
                      scaleFocused={1.04}
                      focusedBorderColor="#8A5CF6"
                      borderRadius={10}
                      {...(idx === 0 && discoverFocusTarget ? { nextFocusLeft: discoverFocusTarget } : {})}
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
                      <View style={styles.chipsRow}>
                        {usableLinkList.map((l, idx) => (
                          <TVFocusablePressable
                            key={`link-${idx}`}
                            scaleFocused={1.04}
                            focusedBorderColor="#8A5CF6"
                            borderRadius={8}
                            {...(idx === 0 && discoverFocusTarget ? { nextFocusLeft: discoverFocusTarget } : {})}
                            onPress={() => {
                              setActiveLinkIndex(idx);
                              if (savedDiscoverState) savedDiscoverState.activeLinkIndex = idx;
                            }}
                            style={[styles.qualityChip, idx === activeLinkIndex && styles.qualityChipActive]}
                          >
                            {() => (
                              <View style={styles.chipInner}>
                                <MaterialCommunityIcons name="filmstrip" size={16} color="#8A5CF6" />
                                <Text style={styles.chipText}>{l.title}</Text>
                              </View>
                            )}
                          </TVFocusablePressable>
                        ))}
                      </View>
                    </View>
                  )}

                  {isSeries ? (
                    episodesLoading ? (
                      <View style={styles.loadingRow}>
                        <ActivityIndicator size="small" color="#8A5CF6" />
                        <Text style={styles.loadingText}>Loading episodes...</Text>
                      </View>
                    ) : episodes.length > 0 ? (
                      <View style={styles.subBlock}>
                        <Text style={styles.subHeader}>Episodes</Text>
                        <View style={styles.episodesGrid}>
                          {episodes.map((ep, idx) => {
                            const seasonNum = parseSeasonNumber(activeLink?.title) ?? activeLinkIndex + 1;
                            const episodeNum = parseEpisodeNumber(ep.title) ?? idx + 1;
                            const cinemetaEp = findCinemetaEpisode(
                              sourceCinemetaMeta,
                              seasonNum,
                              episodeNum,
                            );
                            const episodeThumb = ep.image || cinemetaEp?.thumbnail;
                            const episodeOverview = ep.description || cinemetaEp?.overview;
                            return (
                              <TVFocusablePressable
                                key={`ep-${ep.link || idx}`}
                                scaleFocused={1.02}
                                focusedBorderColor="#8A5CF6"
                                borderRadius={8}
                                {...(discoverFocusTarget ? { nextFocusLeft: discoverFocusTarget } : {})}
                                onPress={() =>
                                  handleResolveAndPlay(
                                    ep.link,
                                    sourceInfo?.title ||
                                      activeSourcePost?.title ||
                                      resultsTarget?.title ||
                                      ep.title ||
                                      `Episode ${idx + 1}`,
                                    'series',
                                    idx,
                                    episodes,
                                    ep.link || `ep-${idx + 1}`,
                                  )
                                }
                                style={styles.episodeCard}
                              >
                                {() => (
                                  <View style={styles.episodeInner}>
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
                                      <MaterialCommunityIcons name="play-circle-outline" size={22} color="#8A5CF6" />
                                    )}
                                    <View style={styles.episodeTextWrap}>
                                      <Text numberOfLines={1} style={styles.episodeText}>
                                        {ep.title || cinemetaEp?.name || cinemetaEp?.title || `Episode ${idx + 1}`}
                                      </Text>
                                      {!!episodeOverview && (
                                        <Text numberOfLines={2} style={styles.episodeOverviewText}>
                                          {episodeOverview}
                                        </Text>
                                      )}
                                    </View>
                                  </View>
                                )}
                              </TVFocusablePressable>
                            );
                          })}
                        </View>
                      </View>
                    ) : (
                      <Text style={styles.emptySubtitle}>No episodes found for this season.</Text>
                    )
                  ) : usableDirectItems.length > 0 ? (
                    <View style={styles.subBlock}>
                      <Text style={styles.subHeader}>Play</Text>
                      <View style={styles.chipsRow}>
                        {usableDirectItems.map((d, idx) => (
                          <TVFocusablePressable
                            key={`direct-${idx}`}
                            scaleFocused={1.04}
                            focusedBorderColor="#FFFFFF"
                            borderRadius={8}
                            {...(idx === 0 && discoverFocusTarget ? { nextFocusLeft: discoverFocusTarget } : {})}
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
                    <TVFocusablePressable
                      scaleFocused={1.04}
                      focusedBorderColor="#FFFFFF"
                      borderRadius={10}
                      {...(discoverFocusTarget ? { nextFocusLeft: discoverFocusTarget } : {})}
                      onPress={() =>
                        activeSourcePost &&
                        handleResolveAndPlay(
                          activeSourcePost.link,
                          activeSourcePost.title,
                          'movie',
                          0,
                          undefined,
                          activeSourcePost.link,
                        )
                      }
                      style={styles.directStreamBtn}
                    >
                      {() => (
                        <View style={styles.directBtnInner}>
                          <MaterialCommunityIcons name="play" size={24} color="#FFFFFF" />
                          <Text style={styles.directBtnText}>Start Playback</Text>
                        </View>
                      )}
                    </TVFocusablePressable>
                  )}
                </View>
              )}
            </View>
          )}
        </ScrollView>
      </View>
    );
  }

  /* ======================================================================= */
  /* SCREEN MODE: BROWSE (Category Pills, Posters Grid, Hero)                */
  /* ======================================================================= */
  return (
    <View style={styles.container}>
      <View style={styles.heroWrapper}>
        <TVHeroMeta media={activeHero} />
      </View>

      <View style={styles.browseBodyWrapper}>
        <View style={styles.catalogsBar}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.catalogsScroll}
            scrollEventThrottle={16}
          >
            <TVFocusablePressable
              scaleFocused={1.04}
              focusedBorderColor="#8A5CF6"
              borderRadius={20}
              {...(discoverFocusTarget ? { nextFocusLeft: discoverFocusTarget } : {})}
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

            {visibleCatalogs.map((cat, idx) => {
              const isSelected = selectedCatalog ? catalogKey(cat) === catalogKey(selectedCatalog) : false;
              return (
                <TVFocusablePressable
                  key={catalogKey(cat)}
                  hasTVPreferredFocus={idx === 0}
                  scaleFocused={1.04}
                  focusedBorderColor="#8A5CF6"
                  borderRadius={20}
                  {...(idx === 0 && discoverFocusTarget ? { nextFocusLeft: discoverFocusTarget } : {})}
                  onFocus={() => {
                    focusedPillRef.current = cat;
                  }}
                  onBlur={() => {
                    focusedPillRef.current = null;
                  }}
                  onPress={() => setSelectedCatalog(cat)}
                  onLongPress={() => handleHideCatalog(cat)}
                  style={[styles.catalogPill, isSelected && styles.catalogPillActive]}
                >
                  {() => (
                    <Text style={[styles.catalogText, isSelected && styles.catalogTextActive]}>
                      {catalogDisplayName(cat)}
                    </Text>
                  )}
                </TVFocusablePressable>
              );
            })}
          </ScrollView>
        </View>

        {catalogsLoading ? (
          <View style={styles.centerLoading}>
            <ActivityIndicator size="large" color="#8A5CF6" />
          </View>
        ) : visibleCatalogs.length === 0 ? (
          <View style={styles.emptyState}>
            <MaterialCommunityIcons name="view-grid-plus-outline" size={56} color="#4B5563" />
            <Text style={styles.emptyTitle}>
              {catalogsError || (catalogs.length > 0 ? 'All catalogs are hidden' : 'No catalogs added yet')}
            </Text>
            <Text style={styles.emptySubtitle}>
              {catalogs.length > 0
                ? 'Restore a hidden category from the Catalogs menu.'
                : 'Add a Stremio addon manifest URL (like Cinemeta) to populate this tab.'}
            </Text>
            <TVFocusablePressable
              hasTVPreferredFocus
              scaleFocused={1.04}
              focusedBorderColor="#8A5CF6"
              borderRadius={10}
              {...(discoverFocusTarget ? { nextFocusLeft: discoverFocusTarget } : {})}
              onPress={() => setManageVisible(true)}
              style={styles.emptyAddBtn}
            >
              {() => <Text style={styles.emptyAddBtnText}>Open Catalogs</Text>}
            </TVFocusablePressable>
          </View>
        ) : itemsLoading ? (
          <View style={styles.centerLoading}>
            <ActivityIndicator size="large" color="#8A5CF6" />
          </View>
        ) : (
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.gridContainer}
            scrollEventThrottle={16}
            removeClippedSubviews={true}
          >
            {items.map((item, index) => (
              <TVFocusablePressable
                key={`${item.id}-${index}`}
                scaleFocused={1.05}
                focusedBorderColor="#FFFFFF"
                borderRadius={8}
                {...(index % GRID_COLUMNS === 0 && discoverFocusTarget
                  ? { nextFocusLeft: discoverFocusTarget }
                  : {})}
                onFocus={() => selectedCatalog && focusHero(item, selectedCatalog.baseEndpoint)}
                onPress={() => handleItemPress(item)}
                style={[styles.card, { width: CARD_WIDTH, height: CARD_HEIGHT }]}
              >
                {({ focused }) => (
                  <View style={styles.cardInner}>
                    <Image
                      source={{
                        uri: item.poster || 'https://placehold.jp/24/363636/ffffff/200x300.png?text=Vega',
                      }}
                      style={styles.cardPoster}
                      resizeMode="cover"
                    />
                    {focused && <View style={styles.focusBorderGlow} />}
                  </View>
                )}
              </TVFocusablePressable>
            ))}

            {hasMore && items.length > 0 && (
              <TVFocusablePressable
                scaleFocused={1.04}
                focusedBorderColor="#FFFFFF"
                borderRadius={8}
                onPress={handleLoadMore}
                style={[styles.card, styles.loadMoreCard, { width: CARD_WIDTH, height: CARD_HEIGHT }]}
              >
                {() =>
                  loadingMore ? (
                    <ActivityIndicator size="small" color="#8A5CF6" />
                  ) : (
                    <View style={styles.loadMoreInner}>
                      <MaterialCommunityIcons name="dots-horizontal" size={28} color="#9CA3AF" />
                      <Text style={styles.loadMoreText}>More</Text>
                    </View>
                  )
                }
              </TVFocusablePressable>
            )}
          </ScrollView>
        )}
      </View>

      <Modal
        visible={Boolean(catalogToHide)}
        transparent
        animationType="fade"
        onRequestClose={() => setCatalogToHide(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <MaterialCommunityIcons name="eye-off-outline" size={40} color="#8A5CF6" />
            <Text style={styles.modalTitle}>Hide Catalog?</Text>
            <Text style={styles.modalSubtitle}>
              Hide "{catalogToHide ? catalogDisplayName(catalogToHide) : ''}" from your Discover screen?
            </Text>
            <View style={styles.modalActions}>
              <TVFocusablePressable
                hasTVPreferredFocus
                scaleFocused={1.04}
                focusedBorderColor="#8A5CF6"
                borderRadius={8}
                onPress={() => setCatalogToHide(null)}
                style={styles.cancelBtn}
              >
                {() => <Text style={styles.cancelBtnText}>Cancel</Text>}
              </TVFocusablePressable>
              <TVFocusablePressable
                scaleFocused={1.04}
                focusedBorderColor="#FFFFFF"
                borderRadius={8}
                onPress={() => {
                  if (catalogToHide) {
                    handleHideCatalog(catalogToHide);
                  }
                  setCatalogToHide(null);
                }}
                style={styles.confirmBtn}
              >
                {() => <Text style={styles.confirmBtnText}>Hide</Text>}
              </TVFocusablePressable>
            </View>
          </View>
        </View>
      </Modal>

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
              Add a Stremio addon manifest URL, e.g. https://v3-cinemeta.strem.io/manifest.json.
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
                      focusedBorderColor="#EF4444"
                      borderRadius={8}
                      onPress={() => handleRemoveManifest(m.url)}
                      style={styles.removeBtn}
                    >
                      {() => <MaterialCommunityIcons name="trash-can-outline" size={18} color="#EF4444" />}
                    </TVFocusablePressable>
                  </View>
                </View>
              ))}

              {hiddenCatalogs.length > 0 && (
                <>
                  <Text style={styles.hiddenSectionHeader}>Hidden categories</Text>
                  {hiddenCatalogs.map((h) => (
                    <View key={h.key} style={styles.sourceItem}>
                      <View style={styles.sourceItemContent}>
                        <MaterialCommunityIcons name="eye-off-outline" size={20} color="#6B7280" />
                        <View style={{ flex: 1, marginLeft: 10 }}>
                          <Text style={styles.sourceProviderName}>{h.manifestName}</Text>
                          <Text numberOfLines={1} style={styles.sourceItemTitle}>
                            {h.name}
                          </Text>
                        </View>
                        <TVFocusablePressable
                          scaleFocused={1.06}
                          focusedBorderColor="#8A5CF6"
                          borderRadius={8}
                          onPress={() => handleRestoreCatalog(h.key)}
                          style={styles.removeBtn}
                        >
                          {() => <MaterialCommunityIcons name="eye-outline" size={18} color="#8A5CF6" />}
                        </TVFocusablePressable>
                      </View>
                    </View>
                  ))}
                </>
              )}
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

const styles = StyleSheet.create({
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
  browseBodyWrapper: {
    flex: 1,
    marginTop: 240,
    zIndex: 2,
  },
  catalogsBar: {
    paddingLeft: CONTAINER_PADDING_LEFT,
    marginBottom: 12,
  },
  catalogsScroll: {
    gap: 10,
    paddingRight: CONTAINER_PADDING_RIGHT,
    alignItems: 'center',
  },
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
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    borderColor: '#8A5CF6',
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
    paddingLeft: CONTAINER_PADDING_LEFT,
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
    color: '#E5E7EB',
    fontSize: 13,
    fontWeight: '600',
  },
  targetOverview: {
    color: '#D1D5DB',
    fontSize: 13,
    lineHeight: 20,
    textShadowColor: 'rgba(0, 0, 0, 0.85)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
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
  chipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  qualityChip: {
    backgroundColor: 'rgba(22, 22, 30, 0.4)',
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
  },
  episodeCard: {
    backgroundColor: 'rgba(22, 22, 30, 0.4)',
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
  episodeOverviewText: {
    color: '#9CA3AF',
    fontSize: 11,
    marginTop: 2,
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
  directStreamBtn: {
    alignSelf: 'flex-start',
    backgroundColor: '#8A5CF6',
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderRadius: 8,
  },
  directBtnInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  directBtnText: {
    color: '#FFFFFF',
    fontSize: 15,
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
