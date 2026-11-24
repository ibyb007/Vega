// Stremio / Nuvio addon support.
//
// A Stremio addon (any manifest.json URL following the Stremio addon
// protocol -- Torrentio, Nuvio addons, Comet, ...) is installed as a normal
// provider whose `source.url` is the manifest URL. ProviderManager routes
// every call for such a provider here instead of the JS sandbox.
//
//   catalogs : the Nuvio catalog (default) followed by the addon's own.
//   search   : the addon's / Nuvio's searchable catalogs, else Cinemeta.
//   meta     : the addon's meta resource, else Nuvio, else Cinemeta.
//   streams  : {addon}/stream/{type}/{id}.json -> direct URLs and torrents.
//
// Spec: https://github.com/Stremio/stremio-addon-sdk/tree/master/docs/api

import type {
  Catalog,
  EpisodeLink,
  Info,
  Link,
  Post,
  Stream,
  TextTracks,
} from '../providers/types';
import {extensionStorage, ProviderExtension} from '../storage/extensionStorage';
import {NUVIO_MANIFEST_URL} from './nuvioCatalog';
import {getFileSizeLabel, formatBytes} from '../utils/fileSize';

export const STREMIO_PROVIDER_PREFIX = 'stremio-';
export const STREMIO_SOURCE_AUTHOR = 'Stremio addon';
const CINEMETA_BASE = 'https://v3-cinemeta.strem.io';
const MAX_FALLBACK_ROWS = 10;
const MAX_ADDON_ROWS = 15;

export const isStremioProvider = (providerValue?: string | null): boolean =>
  !!providerValue && providerValue.startsWith(STREMIO_PROVIDER_PREFIX);

/** True for text that should be installed as a Stremio addon, not a repo. */
export const looksLikeStremioManifest = (input: string): boolean => {
  const t = input.trim();
  return /^stremio:\/\//i.test(t) || /manifest\.json(\?.*)?$/i.test(t);
};

// ---------------------------------------------------------------------------
// HTTP + manifest helpers
// ---------------------------------------------------------------------------

const fetchJson = async (
  url: string,
  signal?: AbortSignal,
  timeoutMs = 20000,
): Promise<any> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    const res = await fetch(url, {signal: controller.signal});
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
};

const toBase = (manifestUrl: string): string =>
  manifestUrl.replace(/\/manifest\.json(\?.*)?\s*$/i, '').replace(/\/+$/, '');

const normalizeManifestUrl = (raw: string): string => {
  let url = raw.trim();
  if (/^stremio:\/\//i.test(url)) {
    url = url.replace(/^stremio:\/\//i, 'https://');
  }
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('Addon URL must start with http(s):// or stremio://');
  }
  return url;
};

const hashString = (s: string): string => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
};

interface AddonManifest {
  id?: string;
  name?: string;
  version?: string;
  logo?: string;
  resources: any[];
  catalogs: any[];
}

interface LoadedManifest {
  manifest: AddonManifest;
  base: string;
}

const manifestCache = new Map<string, Promise<LoadedManifest>>();

const loadManifest = (manifestUrl: string): Promise<LoadedManifest> => {
  const cached = manifestCache.get(manifestUrl);
  if (cached) return cached;
  const request = (async () => {
    let data: any;
    try {
      data = await fetchJson(manifestUrl, undefined, 15000);
    } catch (err: any) {
      throw new Error(
        `Could not load addon manifest (${err?.message || 'network error'})`,
      );
    }
    if (!data || typeof data !== 'object' || !data.id || !data.name) {
      throw new Error('That URL is not a valid Stremio addon manifest');
    }
    const manifest: AddonManifest = {
      ...data,
      resources: Array.isArray(data.resources) ? data.resources : [],
      catalogs: Array.isArray(data.catalogs) ? data.catalogs : [],
    };
    return {manifest, base: toBase(manifestUrl)};
  })();
  manifestCache.set(manifestUrl, request);
  request.catch(() => manifestCache.delete(manifestUrl));
  return request;
};

const resourceNames = (manifest: AddonManifest): string[] =>
  manifest.resources.map(r => (typeof r === 'string' ? r : r?.name)).filter(Boolean);

const hasResource = (manifest: AddonManifest, name: string): boolean =>
  resourceNames(manifest).includes(name);

const getAddonUrl = (providerValue: string): string => {
  const provider = extensionStorage
    .getInstalledProviders()
    .find(p => p.value === providerValue);
  const url = provider?.source?.url;
  if (!url) {
    throw new Error(`Stremio addon not found: ${providerValue}`);
  }
  return url;
};

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

export interface InstallResult {
  provider: ProviderExtension;
  alreadyInstalled: boolean;
  hasStreams: boolean;
  usesNuvioCatalog: boolean;
}

export const installStremioAddon = async (
  rawUrl: string,
): Promise<InstallResult> => {
  const manifestUrl = normalizeManifestUrl(rawUrl);
  const {manifest} = await loadManifest(manifestUrl);

  const hasStreams = hasResource(manifest, 'stream');
  const hasMeta = hasResource(manifest, 'meta');
  const hasCatalog = hasResource(manifest, 'catalog') || manifest.catalogs.length > 0;
  if (!hasStreams && !hasMeta && !hasCatalog) {
    throw new Error('This addon offers no streams, catalogs or metadata');
  }

  const value = `${STREMIO_PROVIDER_PREFIX}${hashString(toBase(manifestUrl))}`;
  const existing = extensionStorage
    .getInstalledProviders()
    .find(p => p.value === value);

  const provider: ProviderExtension = {
    value,
    display_name: String(manifest.name),
    source: {author: STREMIO_SOURCE_AUTHOR, url: manifestUrl},
    version: String(manifest.version || '1.0.0'),
    icon: typeof manifest.logo === 'string' ? manifest.logo : '',
    disabled: false,
    type: 'global',
    installed: true,
    hasSettings: false,
    installedAt: Date.now(),
    lastUpdated: Date.now(),
  };
  if (!existing) {
    extensionStorage.installProvider(provider);
  }

  return {
    provider: existing ?? provider,
    alreadyInstalled: !!existing,
    hasStreams,
    usesNuvioCatalog: true,
  };
};

// ---------------------------------------------------------------------------
// Catalogs
// ---------------------------------------------------------------------------

const needsExtra = (cat: any): boolean => {
  if (Array.isArray(cat?.extraRequired) && cat.extraRequired.length > 0) return true;
  return Array.isArray(cat?.extra) && cat.extra.some((e: any) => e?.isRequired);
};

const supportsSearch = (cat: any): boolean => {
  if (Array.isArray(cat?.extraSupported) && cat.extraSupported.includes('search')) return true;
  if (Array.isArray(cat?.extra) && cat.extra.some((e: any) => e?.name === 'search')) return true;
  return Array.isArray(cat?.extraRequired) && cat.extraRequired.includes('search');
};

const isMediaType = (t: string) => t === 'movie' || t === 'series';

const browsableCatalogs = (manifest: AddonManifest): any[] =>
  manifest.catalogs.filter(c => c && c.id && isMediaType(c.type) && !needsExtra(c));

const TYPE_LABEL: Record<string, string> = {movie: 'Movies', series: 'Series'};

export const getStremioCatalog = async (providerValue: string): Promise<Catalog[]> => {
  const label = (c: any) =>
    `${c.name || c.id} - ${TYPE_LABEL[c.type] || c.type}`;

  // The Nuvio catalog is always part of an addon's Home (it brings 16:9
  // backdrops and synopses with every title); the addon's own catalogs
  // follow it. A failing Nuvio manifest just leaves the addon's rows.
  const rows: Catalog[] = [];
  const usedTitles = new Set<string>();
  try {
    const nuvio = await loadManifest(NUVIO_MANIFEST_URL);
    for (const c of browsableCatalogs(nuvio.manifest).slice(0, MAX_FALLBACK_ROWS)) {
      usedTitles.add(label(c));
      rows.push({title: label(c), filter: `nuvio|${c.type}|${c.id}`});
    }
  } catch (err) {
    console.warn('[Stremio] Nuvio catalog unavailable:', err);
  }

  const {manifest} = await loadManifest(getAddonUrl(providerValue));
  for (const c of browsableCatalogs(manifest).slice(0, MAX_ADDON_ROWS)) {
    const title = usedTitles.has(label(c))
      ? `${manifest.name} - ${label(c)}`
      : label(c);
    rows.push({title, filter: `addon|${c.type}|${c.id}`});
  }
  return rows;
};

// Rating/year the catalog already showed on Home, so the details screen can
// still show them when the title's own meta lacks them.
const catalogHints = new Map<string, {rating?: string; year?: string}>();

const toPost = (m: any, fallbackType: string): Post | null => {
  const title = m?.name || m?.title;
  if (!m?.id || !title) return null;
  const background = m.background || m.banner || undefined;
  const rating = m.imdbRating ? String(m.imdbRating) : m.rating ? String(m.rating) : undefined;
  if (rating) {
    catalogHints.set(`${m.type || fallbackType}/${m.id}`, {rating});
  }
  return {
    id: String(m.id),
    type: String(m.type || fallbackType),
    title: String(title),
    link: `${m.type || fallbackType}/${m.id}`,
    image: m.poster || background || '',
    poster: m.poster || undefined,
    background,
    extra: m.description || m.overview || undefined,
    year: m.year
      ? String(m.year)
      : m.releaseInfo
      ? String(m.releaseInfo).slice(0, 4)
      : undefined,
    rating,
    genres: Array.isArray(m.genres) ? m.genres : undefined,
  };
};

const fetchMetas = async (
  url: string,
  fallbackType: string,
  signal?: AbortSignal,
): Promise<Post[]> => {
  const data = await fetchJson(url, signal);
  if (!Array.isArray(data?.metas)) return [];
  const out: Post[] = [];
  for (const m of data.metas) {
    const post = toPost(m, fallbackType);
    if (post) out.push(post);
  }
  return out;
};

export const getStremioPosts = async ({
  filter,
  page,
  providerValue,
  signal,
}: {
  filter: string;
  page: number;
  providerValue: string;
  signal?: AbortSignal;
}): Promise<Post[]> => {
  const [source, type, ...idParts] = filter.split('|');
  const id = idParts.join('|');
  if (!type || !id) return [];
  const base =
    source === 'nuvio'
      ? (await loadManifest(NUVIO_MANIFEST_URL)).base
      : (await loadManifest(getAddonUrl(providerValue))).base;
  const skip = page > 1 ? `/skip=${(page - 1) * 100}` : '';
  return fetchMetas(
    `${base}/catalog/${encodeURIComponent(type)}/${encodeURIComponent(id)}${skip}.json`,
    type,
    signal,
  );
};

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

const searchableFrom = (manifest: AddonManifest, base: string) =>
  manifest.catalogs
    .filter(c => c && c.id && isMediaType(c.type) && supportsSearch(c))
    .slice(0, 4)
    .map(c => ({base, type: c.type as string, id: c.id as string}));

export const searchStremio = async ({
  searchQuery,
  page,
  providerValue,
  signal,
}: {
  searchQuery: string;
  page: number;
  providerValue: string;
  signal?: AbortSignal;
}): Promise<Post[]> => {
  const query = searchQuery.trim();
  if (!query || page > 1) return [];

  let targets: {base: string; type: string; id: string}[] = [];
  try {
    const addon = await loadManifest(getAddonUrl(providerValue));
    targets = searchableFrom(addon.manifest, addon.base);
  } catch {}
  if (targets.length === 0) {
    try {
      const nuvio = await loadManifest(NUVIO_MANIFEST_URL);
      targets = searchableFrom(nuvio.manifest, nuvio.base);
    } catch {}
  }
  if (targets.length === 0) {
    targets = [
      {base: CINEMETA_BASE, type: 'movie', id: 'top'},
      {base: CINEMETA_BASE, type: 'series', id: 'top'},
    ];
  }

  const settled = await Promise.allSettled(
    targets.map(t =>
      fetchMetas(
        `${t.base}/catalog/${encodeURIComponent(t.type)}/${encodeURIComponent(
          t.id,
        )}/search=${encodeURIComponent(query)}.json`,
        t.type,
        signal,
      ),
    ),
  );
  const seen = new Set<string>();
  const posts: Post[] = [];
  settled.forEach(r => {
    if (r.status !== 'fulfilled') return;
    for (const p of r.value) {
      if (seen.has(p.link)) continue;
      seen.add(p.link);
      posts.push(p);
    }
  });
  return posts;
};

// ---------------------------------------------------------------------------
// Meta + episodes
// ---------------------------------------------------------------------------

const splitLink = (link: string): {type: string; id: string} => {
  const idx = link.indexOf('/');
  if (idx <= 0) throw new Error(`Invalid Stremio link: ${link}`);
  return {type: link.slice(0, idx), id: link.slice(idx + 1)};
};

const metaCache = new Map<string, Promise<any>>();

const fetchRawMeta = (providerValue: string, type: string, id: string): Promise<any> => {
  const key = `${providerValue}|${type}/${id}`;
  const cached = metaCache.get(key);
  if (cached) return cached;

  const request = (async () => {
    const bases: string[] = [];
    try {
      const addon = await loadManifest(getAddonUrl(providerValue));
      if (hasResource(addon.manifest, 'meta')) bases.push(addon.base);
    } catch {}
    try {
      const nuvio = await loadManifest(NUVIO_MANIFEST_URL);
      if (hasResource(nuvio.manifest, 'meta')) bases.push(nuvio.base);
    } catch {}
    if (/^tt\d+/i.test(id) && isMediaType(type)) bases.push(CINEMETA_BASE);

    for (const base of bases) {
      try {
        const data = await fetchJson(
          `${base}/meta/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`,
          undefined,
          15000,
        );
        if (data?.meta?.name) return data.meta;
      } catch {}
    }
    throw new Error('No metadata found for this title');
  })();

  metaCache.set(key, request);
  request.catch(() => metaCache.delete(key));
  return request;
};

const youtubeUrl = (meta: any): string | undefined => {
  const id =
    meta?.trailerStreams?.[0]?.ytId ||
    (meta?.trailers || []).find((t: any) => t?.type === 'Trailer' || t?.source)?.source;
  return id ? `https://www.youtube.com/watch?v=${id}` : undefined;
};

const seasonOf = (v: any): number | null => {
  const n = Number(v?.season);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

export const getStremioMeta = async ({
  link,
  provider,
}: {
  link: string;
  provider: string;
}): Promise<Info> => {
  const {type, id} = splitLink(link);
  // Start the stream request right away so it runs alongside the meta
  // request instead of after it.
  const streamsPromise =
    type === 'series' ? null : movieStreamsFor(provider, type, id);
  const meta = await fetchRawMeta(provider, type, id);
  const isSeries = type === 'series' || meta.type === 'series';
  const imdbId: string | undefined =
    meta.imdb_id || (/^tt\d+$/i.test(id) ? id : undefined);

  const tags: string[] = [];
  const year = meta.year || (meta.releaseInfo ? String(meta.releaseInfo).slice(0, 4) : '');
  if (year) tags.push(String(year));
  if (Array.isArray(meta.genres)) tags.push(...meta.genres.slice(0, 4).map(String));

  const cast: string[] = Array.isArray(meta.cast)
    ? meta.cast.slice(0, 10).map(String)
    : Array.isArray(meta.app_extras?.cast)
    ? meta.app_extras.cast.slice(0, 10).map((c: any) => String(c?.name || c))
    : [];

  let linkList: Link[];
  let movieStreams: Stream[] = [];
  if (!isSeries) {
    // Movies: the addon's streams feed the details screen's Season /
    // Quality menu so every server/quality is listed up front.
    movieStreams = streamsPromise
      ? await streamsPromise
      : await movieStreamsFor(provider, type, id);
  }
  if (isSeries) {
    const seasons = new Set<number>();
    (meta.videos || []).forEach((v: any) => {
      const s = seasonOf(v);
      if (s !== null) seasons.add(s);
    });
    if (seasons.size === 0) seasons.add(1);
    // Specials (season 0) go last.
    const ordered = Array.from(seasons).sort((a, b) =>
      a === 0 ? 1 : b === 0 ? -1 : a - b,
    );
    linkList = ordered.map(s => ({
      title: `Season ${s}`,
      episodesLink: `${type}/${id}#${s}`,
    }));
  } else if (movieStreams.length > 0) {
    linkList = movieStreams.map((s, i) => {
      const qLabel = s.quality
        ? s.quality === '2160'
          ? '4K'
          : `${s.quality}p`
        : undefined;
      const alreadyInTitle =
        !!qLabel && s.server.toLowerCase().includes(qLabel.toLowerCase());
      return {
        title: s.server,
        quality: qLabel && !alreadyInTitle ? qLabel : undefined,
        description: s.description,
        size: s.size,
        directLinks: [
          {
            title: 'Play',
            link: `${type}/${id}#${i}`,
            type: 'movie' as const,
            size: s.size,
          },
        ],
      };
    });
  } else {
    linkList = [
      {
        title: String(meta.name),
        directLinks: [{title: 'Play', link: `${type}/${id}`, type: 'movie'}],
      },
    ];
  }

  return {
    title: String(meta.name),
    image: meta.background || meta.poster || '',
    poster: meta.poster,
    logo: meta.logo,
    synopsis: meta.description || '',
    imdbId,
    tmdbId: meta.moviedb_id || meta.tmdb_id,
    type: isSeries ? 'series' : 'movie',
    populateMeta: Boolean(imdbId),
    tags,
    cast,
    rating:
      meta.imdbRating || meta.rating
        ? String(meta.imdbRating || meta.rating)
        : catalogHints.get(`${type}/${id}`)?.rating,
    trailerUrl: youtubeUrl(meta),
    linkList,
  };
};

export const getStremioEpisodes = async ({
  url,
  providerValue,
}: {
  url: string;
  providerValue: string;
}): Promise<EpisodeLink[]> => {
  const hashIdx = url.lastIndexOf('#');
  const linkPart = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
  const season = hashIdx >= 0 ? Number(url.slice(hashIdx + 1)) : 1;
  const {type, id} = splitLink(linkPart);
  const meta = await fetchRawMeta(providerValue, type, id);

  const videos: any[] = (meta.videos || []).filter(
    (v: any) => (seasonOf(v) ?? 1) === season,
  );
  const episodes: EpisodeLink[] = videos.map((v, idx) => {
    const ep = Number(v.episode ?? v.number) || idx + 1;
    const name = String(v.title || v.name || '').trim();
    const bare = !name || /^(episode|ep|e)\s*\d+$/i.test(name);
    const videoId = String(v.id || `${id}:${season}:${ep}`);
    return {
      id: videoId,
      title: bare ? `Episode ${ep}` : `E${ep} - ${name}`,
      link: `${type}/${videoId}`,
      image: v.thumbnail,
      description: v.overview || v.description,
      _ep: ep,
    } as EpisodeLink & {_ep: number};
  });
  episodes.sort((a: any, b: any) => a._ep - b._ep);
  episodes.forEach((e: any) => delete e._ep);
  return episodes;
};

// ---------------------------------------------------------------------------
// Streams
// ---------------------------------------------------------------------------

const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.torrent.eu.org:451/announce',
];

const parseQuality = (text: string): string | undefined => {
  if (/(2160p?|\b4k\b|\buhd\b)/i.test(text)) return '2160';
  if (/1080p?/i.test(text)) return '1080';
  if (/720p?/i.test(text)) return '720';
  if (/480p?/i.test(text)) return '480';
  if (/360p?/i.test(text)) return '360';
  return undefined;
};

const buildMagnet = (s: any): string => {
  const trackers: string[] = Array.isArray(s.sources)
    ? s.sources
        .filter((x: any) => typeof x === 'string' && x.startsWith('tracker:'))
        .map((x: string) => x.slice('tracker:'.length))
    : [];
  const list = trackers.length > 0 ? trackers : DEFAULT_TRACKERS;
  const dn = s.behaviorHints?.filename || s.title?.split('\n')[0] || '';
  return (
    `magnet:?xt=urn:btih:${s.infoHash}` +
    (dn ? `&dn=${encodeURIComponent(dn)}` : '') +
    list.map(t => `&tr=${encodeURIComponent(t)}`).join('')
  );
};

const mapSubtitles = (subs: any): TextTracks | undefined => {
  if (!Array.isArray(subs) || subs.length === 0) return undefined;
  const tracks = subs
    .filter(s => s?.url)
    .map(s => ({
      title: String(s.lang || 'Subtitle'),
      language: String(s.lang || 'en').slice(0, 2).toLowerCase() as any,
      type: (/\.vtt(\?|$)/i.test(s.url)
        ? 'text/vtt'
        : 'application/x-subrip') as any,
      uri: String(s.url),
    }));
  return tracks.length > 0 ? tracks : undefined;
};

const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      v => {
        clearTimeout(t);
        resolve(v);
      },
      e => {
        clearTimeout(t);
        reject(e);
      },
    );
  });

// Never rejects: an addon that is slow or down just yields no list.
const movieStreamsFor = async (
  providerValue: string,
  type: string,
  id: string,
): Promise<Stream[]> => {
  try {
    const {manifest} = await loadManifest(getAddonUrl(providerValue));
    if (!hasResource(manifest, 'stream')) return [];
    return await withTimeout(loadStreams(providerValue, type, id), 15000);
  } catch {
    return [];
  }
};

/** Warm the caches for a title (Home calls this when a card is focused). */
export const prefetchStremioDetails = (providerValue: string, link: string): void => {
  try {
    const {type, id} = splitLink(link);
    fetchRawMeta(providerValue, type, id).catch(() => {});
    if (type !== 'series') movieStreamsFor(providerValue, type, id);
  } catch {}
};

let episodePrefetchTimer: ReturnType<typeof setTimeout> | null = null;

const warmStreams = (providerValue: string, links: (string | undefined)[]): void => {
  const seen = new Set<string>();
  for (const link of links) {
    if (!link) continue;
    try {
      const plain = link.includes('#') ? link.slice(0, link.lastIndexOf('#')) : link;
      if (seen.has(plain)) continue;
      seen.add(plain);
      const {type, id} = splitLink(plain);
      loadStreams(providerValue, type, id).catch(() => {});
    } catch {}
  }
};

/**
 * Warm the stream list for episodes the person is likely to open next (the
 * focused one and the ones after it). Debounced, so sweeping across a row of
 * episodes only requests where the cursor comes to rest. Links already
 * cached or in flight are free (loadStreams shares them).
 */
export const scheduleStremioStreamPrefetch = (
  providerValue: string,
  links: (string | undefined)[],
): void => {
  if (episodePrefetchTimer) clearTimeout(episodePrefetchTimer);
  episodePrefetchTimer = setTimeout(() => {
    episodePrefetchTimer = null;
    warmStreams(providerValue, links);
  }, 150);
};

/** Same as above but immediately (a screen just opened on a known target). */
export const prefetchStremioStreams = (
  providerValue: string,
  links: (string | undefined)[],
): void => warmStreams(providerValue, links);

/**
 * Load the manifest of every installed addon (and the Nuvio catalog) in the
 * background so the first meta / stream request skips that round trip.
 */
export const warmStremioAddons = (): void => {
  try {
    extensionStorage
      .getInstalledProviders()
      .filter(p => isStremioProvider(p.value) && !p.disabled && p.source?.url)
      .forEach(p => {
        loadManifest(p.source!.url as string).catch(() => {});
      });
    loadManifest(NUVIO_MANIFEST_URL).catch(() => {});
  } catch {}
};

const STREAM_CACHE_MS = 10 * 60 * 1000;
// An empty list is often a cold/slow addon: don't pin it for 10 minutes.
const EMPTY_STREAM_CACHE_MS = 20 * 1000;
const STREAM_CACHE_MAX = 80;
const streamCache = new Map<string, {at: number; ttl: number; p: Promise<Stream[]>}>();

// Shared by the details screen's movie quality menu, by prefetching and by
// playback, so the addon is asked once and the `#n` indexes used in links
// stay stable.
const loadStreams = (
  providerValue: string,
  type: string,
  id: string,
): Promise<Stream[]> => {
  const key = `${providerValue}|${type}/${id}`;
  const cached = streamCache.get(key);
  if (cached && Date.now() - cached.at < cached.ttl) return cached.p;

  const entry = {at: Date.now(), ttl: STREAM_CACHE_MS, p: fetchStreamList(providerValue, type, id)};
  streamCache.set(key, entry);
  if (streamCache.size > STREAM_CACHE_MAX) {
    // Maps iterate in insertion order: drop the oldest.
    const oldest = streamCache.keys().next().value;
    if (oldest !== undefined) streamCache.delete(oldest);
  }
  entry.p.then(
    list => {
      if (list.length === 0) entry.ttl = EMPTY_STREAM_CACHE_MS;
    },
    () => {
      if (streamCache.get(key) === entry) streamCache.delete(key);
    },
  );
  return entry.p;
};

export const getStremioStreams = async ({
  link,
  providerValue,
}: {
  link: string;
  providerValue: string;
  signal?: AbortSignal;
}): Promise<Stream[]> => {
  // `type/id#n` selects one entry of the (cached) stream list.
  const hashIdx = link.lastIndexOf('#');
  const plain = hashIdx >= 0 ? link.slice(0, hashIdx) : link;
  const pick = hashIdx >= 0 ? Number(link.slice(hashIdx + 1)) : NaN;
  const {type, id} = splitLink(plain);
  const all = await loadStreams(providerValue, type, id);
  if (Number.isInteger(pick) && all[pick]) return [all[pick]];
  return all;
};

const fetchStreamList = async (
  providerValue: string,
  type: string,
  id: string,
): Promise<Stream[]> => {
  const {base, manifest} = await loadManifest(getAddonUrl(providerValue));
  if (!hasResource(manifest, 'stream')) {
    throw new Error(`${manifest.name} does not provide streams`);
  }
  const streamUrl = `${base}/stream/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
  let data: any;
  try {
    data = await fetchJson(streamUrl, undefined, 30000);
  } catch (err) {
    // One quick retry: addons often fail the first (cold) hit.
    await new Promise(r => setTimeout(r, 400));
    data = await fetchJson(streamUrl, undefined, 30000);
  }
  const raw: any[] = Array.isArray(data?.streams) ? data.streams : [];

  const seen = new Set<string>();
  const out: Stream[] = [];
  for (const s of raw) {
    const isTorrent = !s?.url && typeof s?.infoHash === 'string' && s.infoHash;
    if (!s?.url && !isTorrent) continue; // externalUrl / ytId: not playable here
    const streamLink = isTorrent ? buildMagnet(s) : String(s.url);
    if (seen.has(streamLink)) continue;
    seen.add(streamLink);

    const name = String(s.name || manifest.name || 'Stream').replace(/\s*\n\s*/g, ' ').trim();
    const lines = String(s.title || s.description || '')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);
    const headers = s.behaviorHints?.proxyHeaders?.request;

    out.push({
      server: name,
      link: streamLink,
      type: isTorrent
        ? 'torrent'
        : /\.m3u8(\?|$)/i.test(streamLink)
        ? 'm3u8'
        : /\.mkv(\?|$)/i.test(streamLink)
        ? 'mkv'
        : 'mp4',
      quality: parseQuality(`${s.name || ''} ${lines.join(' ')}`),
      tags: lines.slice(0, 3),
      description: lines.join('\n') || undefined,
      size:
        (typeof s.behaviorHints?.videoSize === 'number'
          ? formatBytes(s.behaviorHints.videoSize)
          : undefined) || getFileSizeLabel({description: lines.join(' ')}),
      subtitles: mapSubtitles(s.subtitles),
      ...(headers ? {headers} : {}),
    });
  }
  return out;
};
