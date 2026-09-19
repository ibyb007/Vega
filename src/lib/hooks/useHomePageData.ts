import {useEffect} from 'react';
import {InteractionManager} from 'react-native';
import {useQuery} from '@tanstack/react-query';
import {getHomePageData, HomePageData} from '../getHomepagedata';
import {Content} from '../zustand/contentStore';
import {cacheStorage} from '../storage';

// How long a fetched home page counts as fresh. Home unmounts every time the
// user opens Details / the player / another rail tab, so with the old
// `staleTime: 0` + `refetchOnMount: 'always'` every single return to Home
// re-fetched *every catalog of every active source* (twice the work once a
// second source is enabled) and re-serialised the results, right while the
// user was trying to navigate. Cached rows still show instantly either way;
// this only controls how often they are silently revalidated.
const HOME_STALE_TIME_MS = 5 * 60 * 1000;

// Last data reference written to MMKV per cache key, so re-mounting Home
// with unchanged data doesn't JSON.stringify a multi-hundred-KB payload again.
const persistedSnapshots = new Map<string, unknown>();

interface UseHomePageDataOptions {
  provider: Content['provider'];
  enabled?: boolean;
}

export const useHomePageData = ({
  provider,
  enabled = true,
}: UseHomePageDataOptions) => {
  const cacheKey = 'homeData' + (provider?.value || '');
  const query = useQuery<HomePageData[], Error>({
    queryKey: ['homePageData', provider.value],
    queryFn: async ({signal}) => {
      // Fetch fresh data from provider
      const data = await getHomePageData(provider, signal);
      return data;
    },
    enabled: enabled && !!provider?.value,
    staleTime: HOME_STALE_TIME_MS,
    gcTime: 60 * 60 * 1000, // 1 hour
    retry: (failureCount, error) => {
      if (error.name === 'AbortError') {
        return false;
      }
      return failureCount < 3;
    },
    retryDelay: attemptIndex => Math.min(1000 * 2 ** attemptIndex, 30000),
    // Add initial data from cache for instant loading without loading screen
    initialData: () => {
      const cache = cacheStorage.getString(cacheKey);
      if (cache) {
        try {
          return JSON.parse(cache);
        } catch {
          return undefined;
        }
      }
      return undefined;
    },
    // Cache-seeded data is treated as already stale (updatedAt 0), so the
    // first mount of a session always revalidates it in the background.
    initialDataUpdatedAt: 0,
    // Refetch on mount only when the data is actually stale (see above).
    refetchOnMount: true,
    refetchOnWindowFocus: false,
    refetchOnReconnect: 'always',
  });

  useEffect(() => {
    const data = query.data;
    if (!data || data.length === 0 || !provider?.value) {
      return;
    }
    // dataUpdatedAt === 0 means this data *came from* the MMKV cache
    // (initialData) -- writing it straight back is wasted work.
    if (query.dataUpdatedAt === 0) {
      return;
    }
    if (persistedSnapshots.get(cacheKey) === data) {
      return;
    }
    persistedSnapshots.set(cacheKey, data);
    // Serialising + writing a full home page is synchronous JS-thread work;
    // do it once navigation/animations have settled instead of mid-input.
    InteractionManager.runAfterInteractions(() => {
      try {
        cacheStorage.setString(cacheKey, JSON.stringify(data));
      } catch {
        // Cache write is best-effort.
      }
    });
  }, [cacheKey, provider?.value, query.data, query.dataUpdatedAt]);

  return query;
};

// Store hero selection per provider to prevent re-randomization on tab switch
const heroSelectionCache = new Map<
  string,
  {postIndex: number; categoryIndex: number}
>();

// Memoized hero selection with stable reference - uses cached index to prevent re-randomization
export const getRandomHeroPost = (
  homeData: HomePageData[],
  providerValue?: string,
) => {
  if (!homeData || homeData.length === 0) {
    return null;
  }

  const populatedCategories = homeData
    .map((category, categoryIndex) => ({category, categoryIndex}))
    .filter(({category}) => category.Posts?.length > 0);
  if (populatedCategories.length === 0) {
    return null;
  }

  const cacheKey = providerValue || 'default';
  const cached = heroSelectionCache.get(cacheKey);

  // If we have a cached index and it's still valid for this data, use it
  const cachedCategory = cached ? homeData[cached.categoryIndex] : undefined;
  if (
    cached &&
    cachedCategory?.Posts &&
    cached.postIndex < cachedCategory.Posts.length
  ) {
    return cachedCategory.Posts[cached.postIndex];
  }

  // Otherwise, choose a random populated catalog and a random post within it.
  const randomCategory =
    populatedCategories[Math.floor(Math.random() * populatedCategories.length)];
  const randomPostIndex = Math.floor(
    Math.random() * randomCategory.category.Posts.length,
  );
  heroSelectionCache.set(cacheKey, {
    postIndex: randomPostIndex,
    categoryIndex: randomCategory.categoryIndex,
  });

  return randomCategory.category.Posts[randomPostIndex];
};

// Function to clear hero cache when explicitly refreshing
export const clearHeroCache = (providerValue?: string) => {
  if (providerValue) {
    heroSelectionCache.delete(providerValue);
  } else {
    heroSelectionCache.clear();
  }
};

// Hook for hero metadata with React Query, instant cache load & background revalidation
export const useHeroMetadata = (heroLink: string, providerValue: string) => {
  const cacheKey = `heroMeta:${providerValue}:${heroLink}`;
  const query = useQuery({
    queryKey: ['heroMetadata', heroLink, providerValue],
    queryFn: async () => {
      const {providerManager} = await import('../services/ProviderManager');
      const {default: axios} = await import('axios');

      const info = await providerManager.getMetaData({
        link: heroLink,
        provider: providerValue,
      });

      // Only enrich providers that explicitly opt in to Cinemeta metadata.
      if (info.populateMeta === true && info.imdbId && info.type) {
        try {
          const response = await axios.get(
            `https://v3-cinemeta.strem.io/meta/${info.type}/${info.imdbId}.json`,
            {timeout: 5000},
          );
          return response.data?.meta || info;
        } catch {
          return info; // Fallback to original info if Stremio fails
        }
      }

      return info;
    },
    enabled: !!heroLink && !!providerValue,
    staleTime: 0, // Instantly revalidate in background
    gcTime: 60 * 60 * 1000, // 1 hour
    retry: 2,
    // Use cached data as initial data
    initialData: () => {
      const cached =
        cacheStorage.getString(cacheKey) || cacheStorage.getString(heroLink);
      if (cached) {
        try {
          return JSON.parse(cached);
        } catch {
          return undefined;
        }
      }
      return undefined;
    },
    initialDataUpdatedAt: 0,
    refetchOnMount: 'always',
  });

  useEffect(() => {
    if (query.data && heroLink) {
      cacheStorage.setString(cacheKey, JSON.stringify(query.data));
      cacheStorage.setString(heroLink, JSON.stringify(query.data));
    }
  }, [cacheKey, heroLink, query.data]);

  return query;
};
