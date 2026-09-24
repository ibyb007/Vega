// Works out a TMDB id for a title when the addon provider didn't supply one,
// so TheIntroDB (which matches on tmdb_id and is far more accurate with it
// than with an imdb_id, especially for TV) can be queried properly.
//
// Resolution order -- stops at the first confident answer:
//   0. A provider-supplied tmdbId is used as is.
//   1. Cinemeta, by imdb id. Its meta carries `moviedb_id` -- needs no TMDB
//      API key at all, and the request is usually already cached because
//      the details screen fetched the same meta.
//   2. TMDB /find by imdb id (needs a TMDB key).
//   3. TMDB /search by title, vetted with the same conservative matcher the
//      rest of the app uses for title matching (titleMatcher.ts). Returns
//      null rather than guessing when several same-titled releases remain.
//
// The TMDB key is whatever `getTmdbApiKey()` returns: the user's own custom
// key from settings when set, otherwise the key bundled at build time. With
// no key at all, tiers 2 and 3 are skipped (tier 1 still works).
//
// Never throws. Confident results are cached on-device for 30 days and
// definitive misses for 12 hours; network failures are never cached, so a
// flaky connection can't poison the cache.

import { cacheStorage } from '../storage';
import { getTmdbApiKey } from '../hooks/useTmdbStory';
import { fetchCinemetaMeta } from './cinemetaService';
import {
  extractYearFromTitle,
  isAmbiguousYearMatch,
  isStrictMatch,
  toSearchQuery,
  cleanTitle,
} from '../utils/titleMatcher';

const TMDB_API_URL = 'https://api.themoviedb.org/3';
const REQUEST_TIMEOUT_MS = 8000;
const CACHE_PREFIX = 'tmdbIdResolver:v1:';
const HIT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 12 * 60 * 60 * 1000;
const SEARCH_CANDIDATE_LIMIT = 8;
const IMDB_ID_RE = /^tt\d{7,10}$/;

export type TmdbKind = 'movie' | 'series';

export interface TmdbIdentity {
  tmdbId: number;
  /** TMDB's own naming for the id space `tmdbId` belongs to. */
  mediaType: 'movie' | 'tv';
  source: 'provider' | 'cinemeta' | 'find' | 'search';
}

export interface ResolveTmdbIdInput {
  /** Provider-supplied id, if any. Used as is when valid. */
  tmdbId?: number | string | null;
  imdbId?: string | null;
  /** Clean show/movie title (not an episode title). */
  title?: string | null;
  /** Release year when known outside the title text. */
  year?: string | number | null;
  /**
   * Required: TMDB movie and TV id spaces overlap, so the kind decides which
   * one is looked up. Episodes => 'series'.
   */
  kind: TmdbKind;
}

interface CacheEntry {
  id: number | null;
  s?: TmdbIdentity['source'];
  t: number;
}

const toMediaType = (kind: TmdbKind): 'movie' | 'tv' => (kind === 'series' ? 'tv' : 'movie');

const asValidId = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const yearOf = (input: string | number | null | undefined): string | undefined =>
  String(input ?? '').match(/(19|20)\d{2}/)?.[0];

const readCache = (key: string): CacheEntry | null => {
  try {
    const entry = cacheStorage.getObject<CacheEntry>(key);
    if (!entry || typeof entry.t !== 'number') return null;
    const ttl = entry.id ? HIT_TTL_MS : MISS_TTL_MS;
    return Date.now() - entry.t <= ttl ? entry : null;
  } catch {
    return null;
  }
};

const writeCache = (key: string, entry: CacheEntry) => {
  try {
    cacheStorage.setObject(key, entry);
  } catch {
    // Cache is a nicety; ignore.
  }
};

// `ok: false` means the request itself failed (network/timeout/HTTP error) --
// as opposed to a successful response with no useful data.
type JsonResult = { ok: true; data: any } | { ok: false };

const getJson = async (path: string, params: Record<string, string>): Promise<JsonResult> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`${TMDB_API_URL}/${path}?${qs}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false };
    return { ok: true, data: await res.json() };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timeout);
  }
};

const cacheKeyFor = (input: ResolveTmdbIdInput, imdbId: string | null): string | null => {
  if (imdbId) return `${CACHE_PREFIX}${input.kind}:${imdbId}`;
  const title = cleanTitle(input.title || '');
  if (!title) return null;
  const year = yearOf(input.year) || extractYearFromTitle(input.title || '') || '';
  return `${CACHE_PREFIX}${input.kind}:t:${title}|${year}`;
};

// ---- Tier 1 ---------------------------------------------------------------

const resolveViaCinemeta = async (imdbId: string, kind: TmdbKind): Promise<number | null> => {
  const meta = await fetchCinemetaMeta(imdbId, kind);
  return asValidId(meta?.moviedb_id);
};

// ---- Tier 2 ---------------------------------------------------------------

interface StepResult {
  id: number | null;
  /** True when a request failed, so "no result" isn't a definitive miss. */
  networkError: boolean;
}

const resolveViaFind = async (
  apiKey: string,
  imdbId: string,
  kind: TmdbKind,
): Promise<StepResult> => {
  const res = await getJson(`find/${imdbId}`, {
    api_key: apiKey,
    external_source: 'imdb_id',
    language: 'en-US',
  });
  if (!res.ok) return { id: null, networkError: true };

  const data = res.data || {};
  if (kind === 'series') {
    const direct = asValidId(data.tv_results?.[0]?.id);
    if (direct) return { id: direct, networkError: false };
    // An episode-level imdb id resolves to the parent show here.
    return { id: asValidId(data.tv_episode_results?.[0]?.show_id), networkError: false };
  }
  return { id: asValidId(data.movie_results?.[0]?.id), networkError: false };
};

// ---- Tier 3 ---------------------------------------------------------------

interface TmdbSearchResult {
  id: number;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  release_date?: string;
  first_air_date?: string;
}

const resolveViaSearch = async (
  apiKey: string,
  title: string,
  yearHint: string | undefined,
  kind: TmdbKind,
): Promise<StepResult> => {
  const query = toSearchQuery(title);
  if (query.length < 2) return { id: null, networkError: false };

  // The year is deliberately NOT sent to TMDB: a provider's year is often a
  // season's release year rather than the show's first-air year, and TMDB
  // would then exclude the right show. It's applied locally instead, with
  // the matcher's own tolerance.
  const res = await getJson(kind === 'series' ? 'search/tv' : 'search/movie', {
    api_key: apiKey,
    query,
    language: 'en-US',
    include_adult: 'false',
    page: '1',
  });
  if (!res.ok) return { id: null, networkError: true };

  const results: TmdbSearchResult[] = (
    Array.isArray(res.data?.results) ? res.data.results : []
  ).slice(0, SEARCH_CANDIDATE_LIMIT);

  const targetYear = yearHint || extractYearFromTitle(title);

  const candidateFields = (r: TmdbSearchResult) => ({
    names: [r.title || r.name, r.original_title || r.original_name].filter(
      (n): n is string => Boolean(n),
    ),
    year: (r.release_date || r.first_air_date || '').slice(0, 4) || undefined,
  });

  const matchesWith = (
    fn: typeof isStrictMatch | typeof isAmbiguousYearMatch,
    r: TmdbSearchResult,
  ): boolean => {
    const { names, year } = candidateFields(r);
    return names.some((n) => fn(title, n, targetYear, year, kind, kind));
  };

  // Titles agree AND both years are known and compatible.
  const strict = results.filter((r) => asValidId(r.id) && matchesWith(isStrictMatch, r));
  if (strict.length === 1) return { id: asValidId(strict[0].id), networkError: false };
  if (strict.length > 1) {
    // Several same-titled releases within tolerance (remakes, reboots): only
    // an exact-year hit that is unique is trustworthy.
    if (targetYear) {
      const exact = strict.filter((r) => candidateFields(r).year === targetYear);
      if (exact.length === 1) return { id: asValidId(exact[0].id), networkError: false };
    }
    return { id: null, networkError: false };
  }

  // Titles agree but our own year is unknown, so nothing can be vetoed on it.
  const ambiguous = results.filter((r) => asValidId(r.id) && matchesWith(isAmbiguousYearMatch, r));
  if (ambiguous.length === 1) return { id: asValidId(ambiguous[0].id), networkError: false };
  // Series only: TMDB ranks by relevance/popularity, and a wrong pick is far
  // less likely for a show than for a movie with remakes.
  if (ambiguous.length > 1 && kind === 'series') {
    return { id: asValidId(ambiguous[0].id), networkError: false };
  }
  return { id: null, networkError: false };
};

// ---- Public API -----------------------------------------------------------

/**
 * Resolves a TMDB id for one title. Resolves to `null` (never throws) when
 * no confident match exists.
 */
export async function resolveTmdbId(input: ResolveTmdbIdInput): Promise<TmdbIdentity | null> {
  try {
    const mediaType = toMediaType(input.kind);

    const direct = asValidId(input.tmdbId);
    if (direct) return { tmdbId: direct, mediaType, source: 'provider' };

    const imdbId = input.imdbId && IMDB_ID_RE.test(input.imdbId) ? input.imdbId : null;
    const hasTitle = Boolean(input.title && cleanTitle(input.title));
    if (!imdbId && !hasTitle) return null;

    const key = cacheKeyFor(input, imdbId);
    if (key) {
      const cached = readCache(key);
      if (cached) {
        return cached.id
          ? { tmdbId: cached.id, mediaType, source: cached.s ?? 'search' }
          : null;
      }
    }

    const finish = (id: number, source: TmdbIdentity['source']): TmdbIdentity => {
      if (key) writeCache(key, { id, s: source, t: Date.now() });
      return { tmdbId: id, mediaType, source };
    };

    // Tier 1: Cinemeta (no TMDB key needed).
    if (imdbId) {
      const id = await resolveViaCinemeta(imdbId, input.kind);
      if (id) return finish(id, 'cinemeta');
    }

    // Tiers 2-3 need a TMDB key (custom key from settings, else bundled).
    const apiKey = getTmdbApiKey();
    if (!apiKey) return null;

    let networkError = false;

    if (imdbId) {
      const found = await resolveViaFind(apiKey, imdbId, input.kind);
      if (found.id) return finish(found.id, 'find');
      networkError = networkError || found.networkError;
    }

    if (hasTitle) {
      const searched = await resolveViaSearch(
        apiKey,
        input.title as string,
        yearOf(input.year),
        input.kind,
      );
      if (searched.id) return finish(searched.id, 'search');
      networkError = networkError || searched.networkError;
    }

    // Only a clean "TMDB looked and found nothing" is worth remembering.
    // With an imdb id, Cinemeta's lookup can't distinguish miss from failure,
    // so a miss is only cached when TMDB itself answered.
    if (key && !networkError) writeCache(key, { id: null, t: Date.now() });
    return null;
  } catch (e) {
    console.warn('[tmdbIdResolver] resolution failed:', e);
    return null;
  }
}
