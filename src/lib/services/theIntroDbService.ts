// Client for TheIntroDB (https://theintrodb.org) -- a community-verified
// database of intro/recap/credits/preview timestamps, matched by TMDB id
// (IMDb as a fallback, less accurate for TV per their own docs).
//
// Used by TVPlayerScreen to power the "Skip Intro"/"Skip Recap" popup for
// streams where the provider itself didn't already supply a `skip` marker
// (see `SkipInterval` in `../providers/types`).
//
// NOTE ON THE CONTRACT: TheIntroDB's public API isn't fully documented
// anywhere Claude could reach while writing this (no OpenAPI/docs page was
// fetchable, and the sandbox this was written in can't reach
// api.theintrodb.org directly to confirm field names against a real
// response). The request shape below (`tmdb_id`/`imdb_id` + `season`/
// `episode` query params) matches how their own Jellyfin/Emby/Kodi plugins
// describe matching content. The response parsing is intentionally
// tolerant of a few likely field-name variants (see `normalizeSegment`)
// so that if the real shape differs slightly, fixing it is a matter of
// adding one more alias below -- not a rewrite. If this needs adjusting,
// the fastest way to confirm the real shape is a manual curl/Postman call
// against a known episode (e.g. a popular show's S01E01) and comparing the
// JSON keys against `normalizeSegment`.
//
// NOTE ON THE API KEY: TheIntroDB's docs describe the key as only
// mattering for prioritizing/seeing *your own* pending submissions --
// reading community-verified segments (all this app needs) should work
// anonymously. Deliberately NOT hardcoding a personal account key here:
// this file ships inside the APK, and anything in it can be pulled back
// out of the compiled bundle. If you want to test with a key locally,
// paste it into INTRO_DB_API_KEY below on your own machine, but don't
// commit it -- ship without one unless testing shows reads genuinely
// require it.
const INTRO_DB_BASE = 'https://api.theintrodb.org';
const INTRO_DB_API_KEY: string | undefined = undefined;

const REQUEST_TIMEOUT_MS = 6000;

export type IntroDbSegmentType = 'intro' | 'recap' | 'credits' | 'preview';

export interface IntroDbSegment {
  type: IntroDbSegmentType;
  from: number;
  to: number;
}

interface FetchIntroDbSegmentsParams {
  tmdbId?: number | string;
  imdbId?: string;
  // Series only. Omit both for movies.
  season?: number;
  episode?: number;
}

const SEGMENT_TYPE_ALIASES: Record<string, IntroDbSegmentType> = {
  intro: 'intro',
  opening: 'intro',
  op: 'intro',
  recap: 'recap',
  recap_summary: 'recap',
  credits: 'credits',
  outro: 'credits',
  ending: 'credits',
  preview: 'preview',
  trailer: 'preview',
};

const toSeconds = (val: unknown): number | null => {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'string') {
    // Accepts plain seconds ("95.5") or clock-style "mm:ss" / "hh:mm:ss".
    if (/^\d+(\.\d+)?$/.test(val.trim())) return parseFloat(val);
    const parts = val.trim().split(':').map(Number);
    if (parts.length >= 2 && parts.every((p) => Number.isFinite(p))) {
      return parts.reduceRight((acc, p, idx, arr) => acc + p * Math.pow(60, arr.length - 1 - idx), 0);
    }
  }
  return null;
};

// Tolerant of several plausible field-name variants for start/end/type,
// since the exact TheIntroDB response schema wasn't confirmable while
// writing this (see the file-level note above).
const normalizeSegment = (raw: any): IntroDbSegment | null => {
  if (!raw || typeof raw !== 'object') return null;

  const rawType = String(
    raw.type ?? raw.segment_type ?? raw.segmentType ?? raw.label ?? ''
  ).toLowerCase();
  const type = SEGMENT_TYPE_ALIASES[rawType];
  if (!type) return null;

  const from = toSeconds(raw.from ?? raw.start ?? raw.start_sec ?? raw.startTime ?? raw.startSec);
  const to = toSeconds(raw.to ?? raw.end ?? raw.end_sec ?? raw.endTime ?? raw.endSec);
  if (from == null || to == null || to <= from) return null;

  return { type, from, to };
};

const extractSegmentArray = (payload: any): any[] => {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.segments)) return payload.segments;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.results)) return payload.results;
  return [];
};

/**
 * Fetches intro/recap/credits/preview segments for one title (movie) or
 * one episode (series) from TheIntroDB. Never throws -- on any network
 * error, timeout, missing ids, or unrecognized response shape it resolves
 * to `[]` so a lookup failure never breaks playback or crashes the player.
 */
export async function fetchIntroDbSegments({
  tmdbId,
  imdbId,
  season,
  episode,
}: FetchIntroDbSegmentsParams): Promise<IntroDbSegment[]> {
  if (!tmdbId && !imdbId) return [];

  const params = new URLSearchParams();
  if (tmdbId) params.set('tmdb_id', String(tmdbId));
  else if (imdbId) params.set('imdb_id', imdbId);
  if (season != null) params.set('season', String(season));
  if (episode != null) params.set('episode', String(episode));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${INTRO_DB_BASE}/v1/segments?${params.toString()}`, {
      method: 'GET',
      headers: INTRO_DB_API_KEY ? { 'X-API-Key': INTRO_DB_API_KEY } : undefined,
      signal: controller.signal,
    });

    if (!res.ok) return [];

    const payload = await res.json();
    return extractSegmentArray(payload)
      .map(normalizeSegment)
      .filter((s): s is IntroDbSegment => s != null)
      .sort((a, b) => a.from - b.from);
  } catch (e) {
    console.warn('[theIntroDbService] segment lookup failed:', e);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}
