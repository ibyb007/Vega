// Small TMDB helpers for the TV details screen:
//   * creator / director + top cast WITH profile photos
//   * per-episode runtime and rating for one season
//
// Everything here is best-effort: no TMDB key, no match or a network error
// resolves to an empty result, never throws. Results are cached in memory for
// the session (promises, so concurrent callers share one request).

import axios from 'axios';
import { getTmdbApiKey } from '../hooks/useTmdbStory';
import { resolveTmdbId, TmdbKind } from './tmdbIdResolver';

const TMDB_API_URL = 'https://api.themoviedb.org/3';
const PROFILE_BASE = 'https://image.tmdb.org/t/p/w185';
const STILL_BASE = 'https://image.tmdb.org/t/p/w500';
const TIMEOUT_MS = 10000;
const CACHE_LIMIT = 40;

export interface CreditPerson {
  id?: number | string;
  name: string;
  // Character (cast) or "Creator" / "Director" (crew).
  role?: string;
  photo?: string;
}

export interface TmdbCredits {
  // Creators (series) or directors (movies).
  directors: CreditPerson[];
  writers: CreditPerson[];
  cast: CreditPerson[];
}

export interface TmdbEpisodeInfo {
  name?: string;
  overview?: string;
  // Full still image URL.
  still?: string;
  // Minutes.
  runtime?: number;
  // TMDB vote average (0-10).
  rating?: number;
}

export interface TmdbIdentityLite {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
}

const remember = <V,>(map: Map<string, V>, key: string, value: V) => {
  map.delete(key);
  map.set(key, value);
  if (map.size > CACHE_LIMIT) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
};

const photoUrl = (path?: string | null): string | undefined =>
  path ? `${PROFILE_BASE}${path}` : undefined;

/** Resolves the TMDB id for a title. Needs a TMDB key for anything beyond Cinemeta's own `moviedb_id`. */
export const resolveTmdbIdentityLite = async (input: {
  tmdbId?: number | string | null;
  imdbId?: string | null;
  title?: string | null;
  year?: string | number | null;
  kind: TmdbKind;
}): Promise<TmdbIdentityLite | null> => {
  try {
    const identity = await resolveTmdbId(input);
    return identity ? { tmdbId: identity.tmdbId, mediaType: identity.mediaType } : null;
  } catch {
    return null;
  }
};

const creditsCache = new Map<string, Promise<TmdbCredits | null>>();

const WRITER_JOBS = new Set(['Writer', 'Screenplay', 'Story', 'Novel', 'Teleplay', 'Author']);

export const fetchTmdbCredits = (
  identity: TmdbIdentityLite,
  castLimit: number = 15,
): Promise<TmdbCredits | null> => {
  const apiKey = getTmdbApiKey();
  if (!apiKey) return Promise.resolve(null);
  const key = `${identity.mediaType}:${identity.tmdbId}:${castLimit}`;
  const cached = creditsCache.get(key);
  if (cached) return cached;

  const isTv = identity.mediaType === 'tv';
  const request = axios
    .get(`${TMDB_API_URL}/${identity.mediaType}/${identity.tmdbId}`, {
      params: {
        api_key: apiKey,
        language: 'en-US',
        append_to_response: isTv ? 'aggregate_credits' : 'credits',
      },
      timeout: TIMEOUT_MS,
    })
    .then((res): TmdbCredits => {
      const data = res.data || {};
      const creditData = isTv ? data.aggregate_credits : data.credits;
      const crew: any[] = creditData?.crew || [];
      const jobsOf = (p: any): string[] =>
        isTv ? (p.jobs || []).map((j: any) => j.job) : [p.job];

      const seen = new Set<string>();
      const take = (source: any[], role: string, max: number): CreditPerson[] => {
        const out: CreditPerson[] = [];
        for (const p of source) {
          const id = String(p.id);
          if (seen.has(id) || !p.name) continue;
          seen.add(id);
          out.push({ id: p.id, name: p.name, role, photo: photoUrl(p.profile_path) });
          if (out.length >= max) break;
        }
        return out;
      };

      // Series: the show's creators. Movies: the director(s).
      const directorSource: any[] = isTv
        ? data.created_by || []
        : crew.filter((p: any) => p.job === 'Director');
      const directors = take(directorSource, isTv ? 'Creator' : 'Director', 2);

      // Writers (most credited first), skipping anyone already listed.
      const writerSource = crew
        .filter((p: any) => jobsOf(p).some((j) => WRITER_JOBS.has(j)))
        .sort(
          (a: any, b: any) =>
            (b.total_episode_count || 0) - (a.total_episode_count || 0),
        );
      const writers = take(writerSource, 'Writer', 2);

      const cast: CreditPerson[] = (creditData?.cast || [])
        .slice(0, castLimit)
        .map((p: any) => ({
          id: p.id,
          name: p.name,
          role: isTv ? p.roles?.[0]?.character : p.character,
          photo: photoUrl(p.profile_path),
        }))
        .filter((p: CreditPerson) => Boolean(p.name));

      return { directors, writers, cast };
    })
    .catch(() => {
      creditsCache.delete(key);
      return null;
    });

  remember(creditsCache, key, request);
  return request;
};

const seasonCache = new Map<string, Promise<Record<number, TmdbEpisodeInfo>>>();

/** Runtime + rating for every episode of one season, keyed by episode number. */
export const fetchTmdbSeasonEpisodes = (
  tmdbId: number,
  season: number,
): Promise<Record<number, TmdbEpisodeInfo>> => {
  const apiKey = getTmdbApiKey();
  if (!apiKey || !Number.isFinite(season) || season < 0) return Promise.resolve({});
  const key = `${tmdbId}:${season}`;
  const cached = seasonCache.get(key);
  if (cached) return cached;

  const request = axios
    .get(`${TMDB_API_URL}/tv/${tmdbId}/season/${season}`, {
      params: { api_key: apiKey, language: 'en-US' },
      timeout: TIMEOUT_MS,
    })
    .then((res) => {
      const out: Record<number, TmdbEpisodeInfo> = {};
      for (const ep of res.data?.episodes || []) {
        if (typeof ep?.episode_number !== 'number') continue;
        out[ep.episode_number] = {
          name: typeof ep.name === 'string' && ep.name.trim() ? ep.name.trim() : undefined,
          overview: typeof ep.overview === 'string' && ep.overview.trim() ? ep.overview.trim() : undefined,
          still: ep.still_path ? `${STILL_BASE}${ep.still_path}` : undefined,
          runtime: typeof ep.runtime === 'number' && ep.runtime > 0 ? ep.runtime : undefined,
          rating: typeof ep.vote_average === 'number' && ep.vote_average > 0 ? ep.vote_average : undefined,
        };
      }
      return out;
    })
    .catch(() => {
      seasonCache.delete(key);
      return {} as Record<number, TmdbEpisodeInfo>;
    });

  remember(seasonCache, key, request);
  return request;
};

const ratingCache = new Map<string, Promise<string | undefined>>();

/** TMDB's community rating for a title as "7.8" (undefined when unrated / no key). */
export const fetchTmdbRating = (identity: TmdbIdentityLite): Promise<string | undefined> => {
  const apiKey = getTmdbApiKey();
  if (!apiKey) return Promise.resolve(undefined);
  const key = `${identity.mediaType}:${identity.tmdbId}`;
  const cached = ratingCache.get(key);
  if (cached) return cached;

  const request = axios
    .get(`${TMDB_API_URL}/${identity.mediaType}/${identity.tmdbId}`, {
      params: { api_key: apiKey, language: 'en-US' },
      timeout: TIMEOUT_MS,
    })
    .then((res): string | undefined => {
      const avg = Number(res.data?.vote_average);
      const votes = Number(res.data?.vote_count);
      return Number.isFinite(avg) && avg > 0 && votes > 0 ? avg.toFixed(1) : undefined;
    })
    .catch(() => {
      ratingCache.delete(key);
      return undefined;
    });

  remember(ratingCache, key, request);
  return request;
};
