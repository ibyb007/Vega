// Shared Cinemeta (Stremio's default catalogue/metadata addon) helpers.
//
// Used by TVDetailsScreen and TVDiscoverScreen to enrich provider-scraped
// media with the same canonical title/artwork/episode data Stremio itself
// shows -- providers almost never return per-episode stills or synopses,
// and their scraped titles are often messier than Cinemeta's canonical
// `name`.

import {
  cleanTitle,
  extractYearFromTitle,
  inferMediaKind,
  isAmbiguousYearMatch,
  isStrictMatch,
  normalizeMediaKind,
  toSearchQuery,
} from '../utils/titleMatcher';

const CINEMETA_BASE = 'https://v3-cinemeta.strem.io';

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
  imdb_id?: string;
  // TMDB's numeric id for the same title. Lets a TMDB-only provider be
  // confirmed (or ruled out) exactly, without leaning on title text.
  moviedb_id?: string | number;
  name: string;
  releaseInfo?: string;
  year?: string | number;
  runtime?: string | number;
  logo?: string;
  background?: string;
  description?: string;
  imdbRating?: string | number;
  rating?: string | number;
  genres?: string[];
  cast?: string[];
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

// Loose "same title?" check between Cinemeta's canonical name and a title
// we hold. Compares both a plain normalisation and the release-marker-
// stripped `cleanTitle`, so a scraped provider title such as
// "The Boys [Hindi] S1-S5" still agrees with Cinemeta's "The Boys" -- a
// plain normalisation alone rejected exactly those (very common) titles.
export const titlesAgree = (canonical: string | undefined, providerTitle: string): boolean => {
  if (!canonical || !providerTitle) return true; // nothing to compare against
  return (
    normalizeTitle(canonical) === normalizeTitle(providerTitle) ||
    cleanTitle(canonical) === cleanTitle(providerTitle)
  );
};

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

  const request = fetch(`${CINEMETA_BASE}/meta/${mediaType}/${imdbId}.json`)
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
  return titlesAgree(meta.name, knownTitle || '') ? meta : null;
};

/**
 * Synchronous read of an already-fetched Cinemeta meta (or null). Lets a
 * screen paint episode names/synopses on its very first render when
 * something earlier (hero enrichment, a prewarm) already pulled the meta,
 * instead of blanking and waiting a tick for the promise to resolve.
 */
export const peekCinemetaMeta = (
  imdbId: string | undefined | null,
  type: string | undefined | null,
): CinemetaMeta | null => {
  if (!imdbId || !imdbId.startsWith('tt')) return null;
  return metaCache.get(keyFor(imdbId, type === 'series' ? 'series' : 'movie')) ?? null;
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

// Cinemeta usually already returns something like "148 min", but some
// entries (especially series) just give a bare number of minutes -- only
// append the unit ourselves when the value has none, so callers never end
// up displaying a doubled-up "148 min min".
export const formatCinemetaRuntime = (
  runtime: string | number | undefined | null,
): string | undefined => {
  if (runtime === undefined || runtime === null) return undefined;
  const str = String(runtime).trim();
  if (!str) return undefined;
  return /^\d+$/.test(str) ? `${str} min` : str;
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

// Cinemeta's per-episode `released` is an ISO datetime string. Formats it
// down to a short, locale-aware date for display on an episode card --
// falls back to the raw string if it turns out not to be parseable rather
// than hiding the info entirely.
export const formatEpisodeReleaseDate = (
  released: string | undefined | null,
): string | undefined => {
  if (!released) return undefined;
  const date = new Date(released);
  if (isNaN(date.getTime())) return released;
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
};

// ---------------------------------------------------------------------------
// Resolving Cinemeta metadata for a *provider* title
// ---------------------------------------------------------------------------
// Discover starts from a Cinemeta catalog item (canonical title/year/type,
// known imdb id) and asks "which of the provider's search results is this?".
// The details screen starts from the provider's own scraped title and has to
// go the other way -- "which Cinemeta entry is this?" -- but the decision is
// made with the exact same matcher (`isStrictMatch` /
// `isAmbiguousYearMatch`, canonical Cinemeta title as the target and the
// scraped provider title as the candidate), so the two screens agree on what
// counts as the same release.

export interface CinemetaSearchHit {
  imdbId: string;
  type: 'movie' | 'series';
  name: string;
  /** 4-digit start year, when Cinemeta gave one. */
  year?: string;
}

const searchCache = new Map<string, Promise<CinemetaSearchHit[]>>();

const IMDB_ID = /^tt\d+$/i;

/**
 * Searches Cinemeta's `top` catalog for `query`, scoped to one media type.
 * Results keep Cinemeta's own (popularity) ranking. Cached per query for
 * the session; a failed request is not cached so it can be retried.
 */
export const searchCinemetaCatalog = (
  query: string,
  type: 'movie' | 'series',
): Promise<CinemetaSearchHit[]> => {
  const q = (query || '').trim();
  if (!q) return Promise.resolve([]);
  const key = `${type}::${q.toLowerCase()}`;

  const cached = searchCache.get(key);
  if (cached) return cached;

  const request = fetch(`${CINEMETA_BASE}/catalog/${type}/top/search=${encodeURIComponent(q)}.json`)
    .then((res) => (res.ok ? res.json() : null))
    .then((data): CinemetaSearchHit[] => {
      if (!data || !Array.isArray(data.metas)) return [];
      const hits: CinemetaSearchHit[] = [];
      data.metas.forEach((m: any) => {
        const name = m?.name || m?.title;
        const rawId = m?.imdb_id || m?.id;
        if (!name || typeof rawId !== 'string' || !IMDB_ID.test(rawId)) return;
        const year = String(m.releaseInfo ?? m.year ?? '').match(/(19|20)\d{2}/)?.[0];
        hits.push({ imdbId: rawId.toLowerCase(), type, name: String(name), year });
      });
      return hits;
    })
    .catch(() => {
      searchCache.delete(key);
      return [];
    });

  searchCache.set(key, request);
  return request;
};

export interface ProviderTitleQuery {
  /** The provider's own (possibly messy, scraped) title. */
  title: string;
  /** The provider's own `type` field, if it set one. */
  type?: string | null;
  /** Release year, when the provider exposes one outside the title text. */
  year?: string;
  /** Provider-supplied TMDB id, if any. */
  tmdbId?: string | number | null;
  /**
   * When several same-titled series remain and nothing (year, kind, TMDB
   * id) tells them apart, accept Cinemeta's top-ranked (most popular) one
   * instead of giving up. Series only -- a wrong pick for a movie
   * (remakes sharing a title) is far more likely than for a show.
   */
  preferTopRanked?: boolean;
}

// How many of Cinemeta's top search hits are worth fully fetching to
// compare TMDB ids -- beyond this the title clearly isn't ranking.
const TMDB_CHECK_LIMIT = 5;

/**
 * Finds the Cinemeta entry for a provider title that has no usable IMDb
 * id, using the same title/year/kind matching Discover uses. Deliberately
 * conservative -- a wrong show's artwork and episode list is worse than
 * none -- so it returns null rather than guessing when several same-titled
 * releases remain and nothing (year, kind, TMDB id) tells them apart.
 */
export const findCinemetaMetaForProviderTitle = async (
  query: ProviderTitleQuery,
): Promise<CinemetaMeta | null> => {
  const providerTitle = query.title || '';
  const searchText = toSearchQuery(providerTitle);
  if (!searchText) return null;

  const knownKind = inferMediaKind(query.type, providerTitle);
  const kinds: ('movie' | 'series')[] = knownKind ? [knownKind] : ['series', 'movie'];
  const providerYear = query.year || extractYearFromTitle(providerTitle);
  const tmdbId =
    query.tmdbId !== undefined && query.tmdbId !== null && String(query.tmdbId).trim() !== ''
      ? String(query.tmdbId).trim()
      : undefined;

  const hits = (await Promise.all(kinds.map((k) => searchCinemetaCatalog(searchText, k)))).flat();
  if (hits.length === 0) return null;

  // An id is a stronger signal than any text match (same reasoning as
  // Discover's "judged on that id alone"): a hit whose TMDB id equals the
  // provider's wins outright, and one whose TMDB id is known and differs
  // is ruled out below.
  let conflicting = new Set<string>();
  if (tmdbId) {
    const candidates = hits.slice(0, TMDB_CHECK_LIMIT);
    const metas = await Promise.all(candidates.map((h) => fetchCinemetaMeta(h.imdbId, h.type)));
    const exact = metas.find((m) => m && m.moviedb_id != null && String(m.moviedb_id) === tmdbId);
    if (exact) return exact;
    conflicting = new Set(
      candidates
        .filter((_, i) => metas[i]?.moviedb_id != null && String(metas[i]!.moviedb_id) !== tmdbId)
        .map((h) => h.imdbId),
    );
  }

  const viable = hits.filter((h) => !conflicting.has(h.imdbId));

  // A year handed over outside the title text (e.g. a provider's release-
  // date tag) is a hint, not gospel -- providers often report a regional /
  // dub release year that is more than the tolerated gap away from the
  // show's first-air year. So it is tried first, then the title's own year
  // (or none), rather than letting a wrong hint veto every candidate.
  const titleYear = extractYearFromTitle(providerTitle);
  const yearAttempts: (string | undefined)[] = [query.year || titleYear];
  if (query.year && query.year !== titleYear) yearAttempts.push(titleYear);

  let pick: CinemetaSearchHit | undefined;
  let sameTitled: CinemetaSearchHit[] = [];
  for (const year of yearAttempts) {
    pick = viable.find((h) =>
      isStrictMatch(h.name, providerTitle, h.year, year, h.type, knownKind),
    );
    if (pick) break;

    // Titles line up but a year is missing on one side (very common: most
    // scraped titles carry none). Only safe to accept when exactly one
    // same-titled release remains -- otherwise it is a coin flip between
    // e.g. a movie and a series (or two remakes) sharing a name.
    const ambiguous = viable.filter((h) =>
      isAmbiguousYearMatch(h.name, providerTitle, h.year, year, h.type, knownKind),
    );
    if (ambiguous.length === 1) {
      pick = ambiguous[0];
      break;
    }
    if (ambiguous.length > 1 && sameTitled.length === 0) sameTitled = ambiguous;
  }

  // Still several same-titled series and no year to split them: Cinemeta
  // ranks by popularity, and the show a provider lists is overwhelmingly
  // the popular one ("The Boys" -> the 2019 series, not a namesake).
  if (!pick && query.preferTopRanked && knownKind === 'series' && sameTitled.length > 1) {
    pick = sameTitled.find((h) => h.type === 'series');
  }

  if (!pick) return null;
  return fetchCinemetaMeta(pick.imdbId, pick.type);
};

export interface CinemetaResolveInput extends ProviderTitleQuery {
  /** Provider-supplied IMDb id, if any. */
  imdbId?: string | null;
  /** True when the provider explicitly vouches for its imdbId. */
  populateMeta?: boolean;
}

export interface CinemetaResolveResult {
  meta: CinemetaMeta;
  /** How the match was made: by the provider's id, or by title matching. */
  source: 'id' | 'title';
}

/**
 * One entry point for "give me the Cinemeta meta for this provider title":
 *  1. If the provider supplied an IMDb id, use it -- accepted outright when
 *     the provider vouches for it (`populateMeta`), otherwise only when the
 *     canonical title still agrees (so a wrong id can't paint another
 *     show's episodes).
 *  2. Otherwise -- no id, an id Cinemeta doesn't know, or one that failed
 *     the title check -- fall back to title matching (see
 *     `findCinemetaMetaForProviderTitle`).
 */
export const resolveCinemetaMeta = async (
  input: CinemetaResolveInput,
): Promise<CinemetaResolveResult | null> => {
  const imdbId = typeof input.imdbId === 'string' ? input.imdbId.trim() : '';
  if (imdbId && IMDB_ID.test(imdbId)) {
    const providerKind = normalizeMediaKind(input.type);
    // The id is what identifies the title; the provider's own `type` is
    // only a hint about which Cinemeta endpoint to try first (providers
    // frequently leave it at a movie default even for shows).
    const order: ('movie' | 'series')[] =
      providerKind === 'movie' ? ['movie', 'series'] : ['series', 'movie'];
    for (const kind of order) {
      const meta = await fetchCinemetaMeta(imdbId.toLowerCase(), kind);
      if (meta && (input.populateMeta === true || titlesAgree(meta.name, input.title))) {
        return { meta, source: 'id' };
      }
    }
  }

  const byTitle = await findCinemetaMetaForProviderTitle(input);
  return byTitle ? { meta: byTitle, source: 'title' } : null;
};

// ---------------------------------------------------------------------------
// Prewarming
// ---------------------------------------------------------------------------

// Only the first few same-titled hits are worth pulling in full.
const PREWARM_META_LIMIT = 3;

/**
 * Starts the Cinemeta search (and pulls the meta of the best-looking hits)
 * for a provider title *before* the provider's own details have loaded.
 * The details screen otherwise has to wait for the provider response and
 * only then do search -> meta, so episode names/synopses trailed the
 * episode list by two full network round trips. Everything lands in the
 * same caches `resolveCinemetaMeta` reads, so by the time it runs it
 * resolves almost instantly. Fire-and-forget; never throws.
 */
export const prewarmCinemetaForTitle = (
  title: string | undefined | null,
  type?: string | null,
): void => {
  const providerTitle = title || '';
  const searchText = toSearchQuery(providerTitle);
  if (!searchText) return;

  const knownKind = inferMediaKind(type, providerTitle);
  const kinds: ('movie' | 'series')[] = knownKind ? [knownKind] : ['series', 'movie'];
  const wanted = cleanTitle(providerTitle);

  kinds.forEach((kind) => {
    searchCinemetaCatalog(searchText, kind)
      .then((hits) => {
        hits
          .filter((h) => cleanTitle(h.name) === wanted)
          .slice(0, PREWARM_META_LIMIT)
          .forEach((h) => {
            fetchCinemetaMeta(h.imdbId, h.type);
          });
      })
      .catch(() => {});
  });
};
