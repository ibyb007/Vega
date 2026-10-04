// Minimal client for the Stremio addon protocol's `subtitles` resource.
// See https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/requests/defineSubtitlesHandler.md
//
//   GET {addonBase}/subtitles/{type}/{id}.json
//   -> { subtitles: [{ id, url, lang }, ...] }
//
// `id` is the IMDb id for movies and `tt1234567:{season}:{episode}` for
// series episodes.

export interface SubtitleAddon {
  /** Name shown in the player's subtitle menu. */
  name: string;
  manifestUrl: string;
}

// Subtitle addons offered in the TV player's subtitle menu. Add more
// entries here to list additional Stremio subtitle addons.
export const SUBTITLE_ADDONS: SubtitleAddon[] = [
  {
    name: 'OpenSubtitles v3',
    manifestUrl: 'https://opensubtitles-v3.strem.io/manifest.json',
  },
];

export interface AddonSubtitle {
  id: string;
  url: string;
  lang: string;
}

const toBaseEndpoint = (manifestUrl: string): string =>
  manifestUrl.replace(/\/manifest\.json\s*$/i, '').replace(/\/+$/, '');

// Addons report ISO 639-2 ('eng') or 639-1 ('en').
const isEnglish = (lang?: string): boolean => {
  const l = (lang || '').toLowerCase();
  return l === 'en' || l === 'eng' || l.startsWith('en-') || l === 'english';
};

const cache = new Map<string, Promise<AddonSubtitle[]>>();

export const fetchEnglishAddonSubtitles = (opts: {
  manifestUrl: string;
  imdbId: string;
  isSeries: boolean;
  season?: number;
  episode?: number;
  limit?: number;
}): Promise<AddonSubtitle[]> => {
  const { manifestUrl, imdbId, isSeries, season, episode, limit = 5 } = opts;
  const videoId =
    isSeries && season != null && episode != null
      ? `${imdbId}:${season}:${episode}`
      : imdbId;
  const type = isSeries ? 'series' : 'movie';
  const key = `${manifestUrl}|${type}|${videoId}|${limit}`;

  const cached = cache.get(key);
  if (cached) return cached;

  const request = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const url = `${toBaseEndpoint(manifestUrl)}/subtitles/${type}/${encodeURIComponent(
        videoId,
      )}.json`;
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const list: any[] = Array.isArray(data?.subtitles) ? data.subtitles : [];
      const seen = new Set<string>();
      const out: AddonSubtitle[] = [];
      for (const s of list) {
        if (!s?.url || typeof s.url !== 'string' || !isEnglish(s.lang)) continue;
        if (seen.has(s.url)) continue;
        seen.add(s.url);
        out.push({ id: String(s.id ?? s.url), url: s.url, lang: s.lang });
        if (out.length >= limit) break;
      }
      return out;
    } finally {
      clearTimeout(timer);
    }
  })();

  cache.set(key, request);
  // Don't cache failures so reopening the menu retries.
  request.catch(() => cache.delete(key));
  return request;
};
