// Client for TheIntroDB (https://theintrodb.org) -- a community-verified
// database of intro/recap/credits/preview timestamps.
//
// Used by TVPlayerScreen to power the "Skip Intro"/"Skip Recap" popup for
// streams where the provider itself didn't already supply a `skip` marker
// (see `SkipInterval` in `../providers/types`).
//
// Contract (API v3, per the published OpenAPI spec):
//   GET https://api.theintrodb.org/v3/media
//     ?tmdb_id=<int> | imdb_id=tt1234567    (tmdb_id preferred; imdb_id is
//                                            resolved server-side, slower and
//                                            less accurate for TV)
//     &season=<int>&episode=<int>           (TV only -- OMIT both for movies;
//                                            the API infers movie vs tv from
//                                            their presence)
//     &duration_ms=<int>                    (optional; picks the matching
//                                            release: theatrical/extended/...)
//   200 -> { tmdb_id, type, season?, episode?,
//            intro?:   [{ start_ms|null, end_ms }],
//            recap?:   [{ start_ms|null, end_ms }],
//            credits?: [{ start_ms, end_ms|null }],   // null end = end of media
//            preview?: [{ start_ms, end_ms|null }] }
//   404 -> no accepted data for this title/episode (normal, not an error)
//   429 -> rate/usage limit (unauthenticated: 500 /media requests/day per IP)
//
// Notes on the API key: reading accepted community data works anonymously.
// The key only adds the caller's own *pending* submissions to the result, so
// this client deliberately ships without one -- anything embedded in the APK
// can be extracted from the bundle.
//
// Because the daily limit is per IP (a whole household shares one) results
// are cached in memory, including "no data" results, so quality switches and
// re-opening an episode don't spend quota.

const INTRO_DB_BASE = 'https://api.theintrodb.org/v3';
const REQUEST_TIMEOUT_MS = 6000;
const USER_AGENT = 'Vega-TV';

export type IntroDbSegmentType = 'intro' | 'recap' | 'credits' | 'preview';

export interface IntroDbSegment {
  type: IntroDbSegmentType;
  /** Seconds. */
  from: number;
  /** Seconds. A null API end (credits/preview = "until end of media") is resolved to the video duration. */
  to: number;
}

interface FetchIntroDbSegmentsParams {
  tmdbId?: number | string;
  imdbId?: string;
  // Series only. Provide BOTH or neither (movie). Both must be >= 1.
  season?: number;
  episode?: number;
  // Total video duration in seconds, once known. Sent as `duration_ms` so the
  // API can pick the right release version, and used to resolve open-ended
  // (null-end) credits/preview segments.
  durationSec?: number;
}

interface RawSegment {
  start_ms?: number | null;
  end_ms?: number | null;
}

const SEGMENT_TYPES: IntroDbSegmentType[] = ['intro', 'recap', 'credits', 'preview'];
const IMDB_ID_RE = /^tt\d{7,8}$/;

const isMs = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

const normalizeSegment = (
  type: IntroDbSegmentType,
  raw: RawSegment,
  durationSec: number | undefined
): IntroDbSegment | null => {
  if (!raw || typeof raw !== 'object') return null;

  // Intro/recap: start may be null/0 ("from the very beginning"), end is required.
  // Credits/preview: start is required; end may be null ("until end of media").
  // The API uses 0 to mean "no segment", which the checks below drop.
  const startOptional = type === 'intro' || type === 'recap';

  const startMs = raw.start_ms == null ? (startOptional ? 0 : null) : raw.start_ms;
  if (!isMs(startMs)) return null;
  if (!startOptional && startMs <= 0) return null;

  let endMs: number | null;
  if (raw.end_ms == null) {
    if (startOptional) return null; // end is mandatory for intro/recap
    if (!durationSec || durationSec <= 0) return null;
    endMs = Math.round(durationSec * 1000);
  } else if (isMs(raw.end_ms)) {
    endMs = raw.end_ms;
  } else {
    return null;
  }

  if (endMs <= startMs) return null;
  return { type, from: startMs / 1000, to: endMs / 1000 };
};

// Successful lookups (200 and 404) are memoised for the app session.
// Network errors, timeouts and 429s are NOT cached so a later attempt can retry.
const cache = new Map<string, IntroDbSegment[]>();
const CACHE_MAX_ENTRIES = 200;

const remember = (key: string, value: IntroDbSegment[]) => {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
};

/**
 * Fetches intro/recap/credits/preview segments for one title (movie) or one
 * episode (series) from TheIntroDB. Never throws -- on any network error,
 * timeout, missing/invalid ids, 404, 429 or unrecognised response it resolves
 * to `[]` so a lookup failure never breaks playback.
 */
export async function fetchIntroDbSegments({
  tmdbId,
  imdbId,
  season,
  episode,
  durationSec,
}: FetchIntroDbSegmentsParams): Promise<IntroDbSegment[]> {
  const tmdb = Number(tmdbId);
  const hasTmdb = Number.isInteger(tmdb) && tmdb >= 1;
  const hasImdb = typeof imdbId === 'string' && IMDB_ID_RE.test(imdbId);
  if (!hasTmdb && !hasImdb) return [];

  // Series: need a valid season AND episode (API requires >= 1; specials /
  // season 0 would 400). Without them a series id must not be sent as a movie:
  // TMDB movie and TV id spaces overlap, so it could match an unrelated film.
  const isSeries = season != null || episode != null;
  if (isSeries) {
    if (!Number.isInteger(season) || !Number.isInteger(episode)) return [];
    if ((season as number) < 1 || (episode as number) < 1) return [];
  }

  const durationMs =
    durationSec && Number.isFinite(durationSec) && durationSec > 0
      ? Math.round(durationSec * 1000)
      : undefined;

  const params = new URLSearchParams();
  if (hasTmdb) params.set('tmdb_id', String(tmdb));
  else params.set('imdb_id', imdbId as string);
  if (isSeries) {
    params.set('season', String(season));
    params.set('episode', String(episode));
  }
  if (durationMs != null) params.set('duration_ms', String(durationMs));

  const key = params.toString();
  const cached = cache.get(key);
  if (cached) return cached;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${INTRO_DB_BASE}/media?${key}`, {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });

    if (res.status === 404 || res.status === 204) {
      remember(key, []); // "no community data for this one" -- don't ask again
      return [];
    }
    if (!res.ok) {
      if (res.status === 429) console.warn('[theIntroDbService] rate/usage limit hit (429)');
      return [];
    }

    const payload = await res.json();
    const segments: IntroDbSegment[] = [];
    for (const type of SEGMENT_TYPES) {
      const list = payload?.[type];
      if (!Array.isArray(list)) continue;
      for (const raw of list) {
        const seg = normalizeSegment(type, raw, durationSec);
        if (seg) segments.push(seg);
      }
    }
    segments.sort((a, b) => a.from - b.from);
    remember(key, segments);
    return segments;
  } catch (e) {
    console.warn('[theIntroDbService] segment lookup failed:', e);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}
