import {Content} from './zustand/contentStore';
import {Post} from './providers/types';
import {providerManager} from './services/ProviderManager';

export interface HomePageData {
  title: string;
  Posts: Post[];
  filter: string;
  error?: string;
}

// Every catalog row is one `getPosts` call into the provider sandbox, and
// each call ships the provider's whole posts module through the single
// hidden WebView (base64-encoded on the JS thread). Firing all of a
// provider's catalogs -- twice over with a second source -- in the same tick
// starves the JS thread for long enough that D-pad input stalls. A small
// worker pool spreads the same work out and lets input/render tasks
// interleave between calls.
const CATALOG_FETCH_CONCURRENCY = 3;

const createAbortError = (): Error => {
  const error = new Error('Request aborted');
  error.name = 'AbortError';
  return error;
};

const mapWithConcurrency = async <T, R>(
  items: T[],
  limit: number,
  signal: AbortSignal,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  const runWorker = async () => {
    for (;;) {
      if (signal.aborted) {
        throw createAbortError();
      }
      const index = nextIndex++;
      if (index >= items.length) {
        return;
      }
      results[index] = await worker(items[index], index);
    }
  };

  await Promise.all(
    Array.from({length: Math.min(limit, items.length)}, () => runWorker()),
  );
  return results;
};

// Optimized version with better error handling
export const getHomePageDataOptimized = async (
  activeProvider: Content['provider'],
  signal: AbortSignal,
): Promise<HomePageData[]> => {
  console.log('Fetching data for provider:', activeProvider.display_name);

  const catalogs = await providerManager.getCatalog({
    providerValue: activeProvider.value,
  });

  // Each catalog resolves to its own result (never rejects) so one bad
  // catalog still yields partial data for the rest.
  const homePageData = await mapWithConcurrency<
    (typeof catalogs)[number],
    HomePageData
  >(catalogs, CATALOG_FETCH_CONCURRENCY, signal, async item => {
    try {
      const data = await providerManager.getPosts({
        filter: item.filter,
        page: 1,
        providerValue: activeProvider.value,
        signal,
      });

      if (signal.aborted) {
        throw new Error('Request aborted');
      }

      console.log(`✅ Fetched ${data?.length || 0} posts for: ${item.title}`);

      return {
        title: item.title,
        Posts: data || [],
        filter: item.filter,
      };
    } catch (error) {
      console.error(`❌ Failed to fetch ${item.title}:`, error);

      // Return partial data with error info instead of failing completely
      return {
        title: item.title,
        Posts: [],
        filter: item.filter,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  const successCount = homePageData.filter(
    category => category.Posts.length > 0,
  ).length;
  const failureCount = homePageData.filter(category => category.error).length;

  console.log(
    `📊 Results: ${successCount} successful, ${failureCount} failed categories`,
  );

  // Ensure we have at least some data
  if (successCount === 0) {
    throw new Error('Failed to load any content categories');
  }

  return homePageData;
};

// Keep original for backward compatibility
export const getHomePageData = getHomePageDataOptimized;
