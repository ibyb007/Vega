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
  directors: CreditPerson[];
  cast: CreditPerson[];
}

export interface TmdbEpisodeInfo {
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

export const fetchTmdbCredits = (
  identity: TmdbIdentityLite,
  limit: number = 5,
): Promise<TmdbCredits | null> => {
  const apiKey = getTmdbApiKey();
  if (!apiKey) return Promise.resolve(null);
  const key = `${identity.mediaType}:${identity.tmdbId}:${limit}`;
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

      const directorSource: any[] = isTv
        ? data.created_by || []
        : (creditData?.crew || []).filter((p: any) => p.job === 'Director');
      const seen = new Set<string>();
      const directors: CreditPerson[] = [];
      for (const p of directorSource) {
        const id = String(p.id);
        if (seen.has(id) || !p.name) continue;
        seen.add(id);
        directors.push({
          id: p.id,
          name: p.name,
          role: isTv ? 'Creator' : 'Director',
          photo: photoUrl(p.profile_path),
        });
        if (directors.length >= limit) break;
      }

      const cast: CreditPerson[] = (creditData?.cast || [])
        .slice(0, limit)
        .map((p: any) => ({
          id: p.id,
          name: p.name,
          role: isTv ? p.roles?.[0]?.character : p.character,
          photo: photoUrl(p.profile_path),
        }))
        .filter((p: CreditPerson) => Boolean(p.name));

      return { directors, cast };
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
