// Minimal client for the Stremio addon protocol's catalog resource --
// enough to list an addon's catalogs and page through their items. See
// https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/manifest.md
// and .../catalog.md for the shapes being parsed here.

export interface StremioCatalogDef {
  type: string; // 'movie' | 'series' | ...
  id: string;
  name?: string;
}

export interface StremioManifest {
  id: string;
  name: string;
  description?: string;
  catalogs: StremioCatalogDef[];
}

export interface CatalogMediaItem {
  id: string;
  imdb_id?: string;
  type: 'movie' | 'series';
  title: string;
  year?: string;
  poster?: string;
  banner?: string;
  overview?: string;
  rating?: string;
  genres?: string[];
}

/** One catalog tab in the Discover UI, tagged with the manifest it came from. */
export interface DiscoverCatalog extends StremioCatalogDef {
  manifestUrl: string;
  manifestName: string;
  baseEndpoint: string;
}

const manifestCache = new Map<string, Promise<{ manifest: StremioManifest; baseEndpoint: string }>>();

const normalizeManifestUrl = (url: string): string => url.trim();

const toBaseEndpoint = (manifestUrl: string): string =>
  manifestUrl.replace(/\/manifest\.json\s*$/i, '').replace(/\/+$/, '');

/**
 * Fetches and validates a Stremio addon manifest. Results are cached per
 * URL for the lifetime of the app session so switching catalog tabs or
 * re-adding the same manifest doesn't re-fetch it.
 */
export const fetchManifestCatalogs = async (
  manifestUrl: string,
): Promise<{ manifest: StremioManifest; baseEndpoint: string }> => {
  const cleanUrl = normalizeManifestUrl(manifestUrl);
  if (!cleanUrl) {
    throw new Error('Manifest URL is empty');
  }

  const cached = manifestCache.get(cleanUrl);
  if (cached) return cached;

  const request = (async () => {
    let res;
    try {
      res = await fetch(cleanUrl);
    } catch (err) {
      throw new Error('Could not reach that manifest URL');
    }
    if (!res.ok) {
      throw new Error(`Manifest request failed (HTTP ${res.status})`);
    }
    let manifest: StremioManifest;
    try {
      manifest = await res.json();
    } catch {
      throw new Error('Manifest did not return valid JSON');
    }
    if (!manifest || !Array.isArray(manifest.catalogs)) {
      throw new Error('Manifest has no catalogs');
    }
    return { manifest, baseEndpoint: toBaseEndpoint(cleanUrl) };
  })();

  manifestCache.set(cleanUrl, request);
  request.catch(() => manifestCache.delete(cleanUrl));
  return request;
};

export const clearManifestCache = (manifestUrl?: string) => {
  if (manifestUrl) {
    manifestCache.delete(normalizeManifestUrl(manifestUrl));
  } else {
    manifestCache.clear();
  }
};

export const fetchCatalogItems = async (
  baseEndpoint: string,
  type: string,
  id: string,
  skip: number = 0,
): Promise<CatalogMediaItem[]> => {
  try {
    const url = `${baseEndpoint}/catalog/${encodeURIComponent(type)}/${encodeURIComponent(id)}${
      skip > 0 ? `/skip=${skip}` : ''
    }.json`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    if (!data?.metas || !Array.isArray(data.metas)) return [];

    return data.metas
      .filter((m: any) => m && (m.name || m.title))
      .map((m: any) => ({
        id: m.id,
        imdb_id: m.imdb_id || (typeof m.id === 'string' && m.id.startsWith('tt') ? m.id : undefined),
        type: m.type === 'series' ? 'series' : 'movie',
        title: m.name || m.title || 'Untitled',
        year: m.year ? String(m.year) : m.releaseInfo ? String(m.releaseInfo).slice(0, 4) : undefined,
        poster: m.poster,
        banner: m.background || m.banner,
        overview: m.description || m.overview,
        rating: m.imdbRating ? String(m.imdbRating) : undefined,
        genres: m.genres || [],
      }));
  } catch (err) {
    console.warn(`[StremioCatalog] Failed to load ${type}/${id}:`, err);
    return [];
  }
};

/**
 * Loads every manifest in `manifestUrls` in parallel and flattens their
 * declared catalogs into a single list for the catalog-tab bar. Manifests
 * that fail to load are skipped rather than failing the whole call.
 */
export const loadDiscoverCatalogs = async (
  manifests: { url: string; name?: string }[],
): Promise<DiscoverCatalog[]> => {
  const results = await Promise.allSettled(
    manifests.map(async ({ url, name }) => {
      const { manifest, baseEndpoint } = await fetchManifestCatalogs(url);
      const manifestName = name || manifest.name || 'Addon';
      return manifest.catalogs.map((cat) => ({
        ...cat,
        manifestUrl: url,
        manifestName,
        baseEndpoint,
      }));
    }),
  );

  const catalogs: DiscoverCatalog[] = [];
  results.forEach((result) => {
    if (result.status === 'fulfilled') {
      catalogs.push(...result.value);
    } else {
      console.warn('[StremioCatalog] Manifest failed to load:', result.reason);
    }
  });
  return catalogs;
};

const metaCache = new Map<string, Promise<any | null>>();

/**
 * Catalog list responses only carry a poster, not a landscape backdrop --
 * that only shows up on the addon's full meta resource. Used to lazily
 * upgrade the Discover hero once a poster-fallback item is focused, rather
 * than fetching full meta for every catalog item up front.
 */
export const fetchItemMeta = async (
  baseEndpoint: string,
  type: string,
  id: string,
): Promise<{ background?: string } | null> => {
  if (!baseEndpoint || !type || !id) return null;
  const cacheKey = `${baseEndpoint}::${type}::${id}`;

  const cached = metaCache.get(cacheKey);
  if (cached) return cached;

  const request = (async () => {
    try {
      const url = `${baseEndpoint}/meta/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = await res.json();
      return data?.meta || null;
    } catch (err) {
      return null;
    }
  })();

  metaCache.set(cacheKey, request);
  return request;
};
