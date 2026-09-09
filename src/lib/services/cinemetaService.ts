// Shared Cinemeta (Stremio's default catalogue/metadata addon) helpers.
//
// Used by TVDetailsScreen and TVDiscoverScreen to enrich provider-scraped
// media with the same canonical title/artwork/episode data Stremio itself
// shows -- providers almost never return per-episode stills or synopses,
// and their scraped titles are often messier than Cinemeta's canonical
// `name`.

export interface CinemetaVideo {
  id?: string;
  season?: number;
  episode?: number;
  number?: number;
  name?: string;
  title?: string;
  overview?: string;
  thumbnail?: string;
  released?: string;
}

export interface CinemetaMeta {
  id: string;
  name: string;
  releaseInfo?: string;
  year?: string | number;
  logo?: string;
  background?: string;
  description?: string;
  imdbRating?: string | number;
  rating?: string | number;
  genres?: string[];
  videos?: CinemetaVideo[];
}

const metaCache = new Map<string, CinemetaMeta>();
const metaInFlight = new Map<string, Promise<CinemetaMeta | null>>();

const keyFor = (imdbId: string, mediaType: string) => `${mediaType}::${imdbId}`;

// Normalizes a title for loose equality checks (strip punctuation/case/
// year suffixes) so a Cinemeta match can be sanity-checked against the
// provider's own title before its artwork/episode data is trusted --
// avoids clobbering a correct provider title with an unrelated Cinemeta
// hit for a similarly-named title.
export const normalizeTitle = (t: string | undefined | null): string =>
  (t || '')
    .toLowerCase()
    .replace(/\(\d{4}\)/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export const fetchCinemetaMeta = (
  imdbId: string | undefined,
  type: string | undefined,
): Promise<CinemetaMeta | null> => {
  if (!imdbId || !imdbId.startsWith('tt')) return Promise.resolve(null);
  const mediaType = type === 'series' ? 'series' : 'movie';
  const key = keyFor(imdbId, mediaType);

  const cached = metaCache.get(key);
  if (cached) return Promise.resolve(cached);

  const pending = metaInFlight.get(key);
  if (pending) return pending;

  const request = fetch(`https://v3-cinemeta.strem.io/meta/${mediaType}/${imdbId}.json`)
    .then((res) => res.json())
    .then((data) => {
      const meta: CinemetaMeta | null = data?.meta || null;
      metaInFlight.delete(key);
      if (meta) metaCache.set(key, meta);
      return meta;
    })
    .catch(() => {
      metaInFlight.delete(key);
      return null;
    });

  metaInFlight.set(key, request);
  return request;
};

// Only returns a meta object when its canonical title actually matches the
// title we already trust (or we have nothing to compare against) -- same
// safety gate the hero backdrop enrichment uses, so a bad imdbId guess
// can't paint the wrong show's episodes/title.
export const fetchMatchingCinemetaMeta = async (
  imdbId: string | undefined,
  type: string | undefined,
  knownTitle: string | undefined,
): Promise<CinemetaMeta | null> => {
  const meta = await fetchCinemetaMeta(imdbId, type);
  if (!meta) return null;
  const titleMatches =
    !knownTitle || !meta.name || normalizeTitle(meta.name) === normalizeTitle(knownTitle);
  return titleMatches ? meta : null;
};

// Providers' `EpisodeLink[]` has no real season/episode numbers, only
// order -- so season/episode here are positional (1-based): season is the
// index of the selected `Link` within `Info.linkList`, episode is the
// index within that season's episode list. This matches how Cinemeta's
// own `videos` entries are ordered for the vast majority of shows.
export const findCinemetaEpisode = (
  meta: CinemetaMeta | null | undefined,
  seasonNumber: number,
  episodeNumber: number,
): CinemetaVideo | null => {
  if (!meta?.videos?.length) return null;
  return (
    meta.videos.find(
      (v) => (v.season ?? 0) === seasonNumber && (v.episode ?? v.number ?? 0) === episodeNumber,
    ) || null
  );
};

// Mirrors how Stremio formats a title under its poster/hero art
// finished one, "Movie Title (2019)" for a movie. `releaseInfo` already
// comes pre-formatted as that year or year-range straight from Cinemeta.
export const formatCinemetaTitle = (
  name: string | undefined,
  releaseInfo: string | number | undefined,
): string | undefined => {
  if (!name) return undefined;
  if (!releaseInfo) return name;
  return `${name} (${releaseInfo})`;
};
