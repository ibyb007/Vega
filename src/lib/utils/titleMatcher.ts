const ARTICLE_PREFIX = /^(the|a|an)\s+/i;
const TRAILING_YEAR = /\(?\b(19|20)\d{2}\b\)?\s*$/;
// Covers [...], (...), and {...} -- addons use all three for the same kind
// of noise: quality/audio tags, or release-tracking notes like
// "{S01E04 Added}".
const BRACKETED = /\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g;
const NON_WORD = /[^\w\s]/gi;
const WHITESPACE = /\s+/g;

// Marks where release/scene metadata starts in a scraped addon title
// Everything from the first match onward is truncated rather than just
// stripped in place, since addons chain an open-ended, unpredictable list
// of these after the real title with no consistent delimiter -- trying to
// enumerate every combination as a strip-in-place word list is a losing
// game, but the *boundary* where the title ends is reliably one of these.
// Streaming platform names are included here too -- addons often tag a
// title with where it's sourced from ("Lanterns Netflix", "Movie Prime
// Video"), which is never part of the actual title.
const RELEASE_MARKER =
  /\b(dual audio|multi audio|multi[- ]sub(bed)?|dubbed|subbed|hindi|tamil|telugu|kannada|malayalam|punjabi|english|4k|2160p|1080p|720p|480p|bluray|blu-ray|webrip|web[- ]?dl|hdrip|hdcam|camrip|dvdrip|hdtc|hdts|remastered|extended( edition)?|director'?s cut|theatrical cut|unrated|uncut|imax|hdr10?|dolby atmos|dts|x264|x265|hevc|10bit|proper|repack|netflix|prime video|amazon prime|jiohotstar|hotstar|disney\+?|disney plus|hbo max|apple tv\+?|paramount\+?|peacock|zee5|sonyliv|voot|mx player|crunchyroll|added|s\d{1,2}e\d{1,3})\b/i;

/** Cuts a scraped title off at the first release/quality/audio marker. */
const truncateAtReleaseMarker = (raw: string): string => {
  const match = raw.match(RELEASE_MARKER);
  if (!match || match.index === undefined || match.index === 0) return raw;
  return raw.slice(0, match.index);
};

// How many years apart two release dates can be while still counting as
// the same title. Loosened from a hard 1-year cutoff -- addons frequently
// disagree on festival vs. wide-release year, or region-specific dates.
const YEAR_TOLERANCE = 2;

/**
 * Pulls a 4-digit year out of a title if the provider embedded it there,
 * e.g. "The Hobbit: An Unexpected Journey (2012)" or
 * "The Gentlemen.2024.webdl.1080p". Looks within the release-marker-
 * truncated title rather than only the absolute end of the raw string --
 * addons commonly glue the year on with a dot/dash separator followed by
 * more release tags ("2024.webdl.1080p"), not just trailing whitespace.
 */
export const extractYearFromTitle = (raw: string): string | undefined => {
  const truncated = truncateAtReleaseMarker(raw || '');
  const parenMatch = truncated.match(/\((19|20)\d{2}\)/);
  if (parenMatch) return parenMatch[0].replace(/[^\d]/g, '');
  const looseMatch = truncated.match(/\b(19|20)\d{2}\b(?!\d)/);
  return looseMatch ? looseMatch[0] : undefined;
};

/**
 * Normalizes a title for comparison: truncates at the first release/quality
 * marker, lowercases, strips bracketed/parenthetical noise, normalizes all
 * punctuation to spaces, then -- only once punctuation can no longer hide a
 * trailing year token behind a "." or "-" (e.g. "Gentlemen.2024.") -- strips
 * a trailing embedded year and a leading article.
 */
export const cleanTitle = (raw: string): string => {
  const truncated = truncateAtReleaseMarker(raw || '').toLowerCase();
  const withoutBrackets = truncated.replace(BRACKETED, ' ');
  const withoutPunctuation = withoutBrackets
    .replace(NON_WORD, ' ')
    .replace(WHITESPACE, ' ')
    .trim();
  return withoutPunctuation
    .replace(TRAILING_YEAR, '')
    .replace(ARTICLE_PREFIX, '')
    .replace(WHITESPACE, ' ')
    .trim();
};

const splitMainAndSubtitle = (raw: string): [string, string] => {
  const parts = raw.split(/[:\-–]/);
  const main = cleanTitle(parts[0] || '');
  const subtitle = cleanTitle(parts.slice(1).join(' '));
  return [main, subtitle];
};

const yearsAreCompatible = (targetYear?: string, candidateYear?: string): boolean => {
  if (!targetYear || !candidateYear) return true; // nothing to disqualify on
  const tY = parseInt(targetYear, 10);
  const cY = parseInt(candidateYear, 10);
  if (isNaN(tY) || isNaN(cY)) return true;
  return Math.abs(tY - cY) <= YEAR_TOLERANCE;
};

/**
 * True when `candidateTitle` should be treated as the same release as
 * `targetTitle` (the poster the user clicked).
 */
export const isStrictMatch = (
  targetTitle: string,
  candidateTitle: string,
  targetYear?: string,
  candidateYear?: string,
): boolean => {
  if (!targetTitle || !candidateTitle) return false;

  const normTarget = cleanTitle(targetTitle);
  const normCandidate = cleanTitle(candidateTitle);

  const resolvedTargetYear = targetYear || extractYearFromTitle(targetTitle);
  const resolvedCandidateYear = candidateYear || extractYearFromTitle(candidateTitle);
  const yearsOk = yearsAreCompatible(resolvedTargetYear, resolvedCandidateYear);

  // An exact (year-stripped) title match is trusted on its own *unless*
  // both sides actually name a year and those years disagree -- e.g. "The
  // Gentlemen" (2024) vs "The Gentlemen (2019)" clean down to the same
  // text but are different releases, so an explicit, incompatible year
  // must still veto the match. Missing year on either side stays
  // permissive (yearsAreCompatible already treats "nothing to disqualify
  // on" as compatible).
  if (normTarget.length > 0 && normTarget === normCandidate) {
    return yearsOk;
  }

  if (!yearsOk) {
    return false;
  }

  // Multi-part titles ("Main: Subtitle") need both halves to line up, or a
  // sequel/prequel sharing the same main title (e.g. "The Hobbit: The
  // Desolation of Smaug") would otherwise pass as a match.
  const hasDelimiter = /[:\-–]/.test(targetTitle) || /[:\-–]/.test(candidateTitle);
  if (!hasDelimiter) {
    return false;
  }

  const [targetMain, targetSub] = splitMainAndSubtitle(targetTitle);
  const [candidateMain, candidateSub] = splitMainAndSubtitle(candidateTitle);

  if (!targetMain || targetMain !== candidateMain) {
    return false;
  }

  // Both sides still need a subtitle for this fallback path -- an addon
  // indexing every installment under the bare main title would otherwise
  // match all of them at once.
  if (!targetSub || !candidateSub) {
    return false;
  }

  return candidateSub.includes(targetSub) || targetSub.includes(candidateSub);
};

// ---------------------------------------------------------------------------
// External id (IMDb/TMDB) matching
// ---------------------------------------------------------------------------
// Some provider search results embed the actual IMDb or TMDB id for the
// title they scraped. When that's present it's a far stronger signal than
// any amount of text/year normalization -- so it's treated as the *only*
// criterion for that candidate, overriding the text-matching path entirely
// (both to accept things text matching would miss, and to reject
// same-titled-but-different-release results text matching would wrongly
// accept). Only candidates with no id at all fall back to `isStrictMatch`.

export interface ExternalIds {
  imdbId?: string;
  tmdbId?: string;
}

const IMDB_ID_PATTERN = /^tt\d+$/i;
const TMDB_PREFIXED_ID_PATTERN = /^tmdb[:\-]?(\d+)$/i;

/**
 * Pulls an IMDb id and/or TMDB id out of an object's common id-ish fields.
 * Providers and catalog metas spell these differently (imdb_id, imdbId,
 * imdbID, tmdb_id, tmdbId), or fold the source right into a Stremio-style
 * `id` field ("tt1234567" for IMDb-based addons, "tmdb:527774" for
 * TMDB-based ones) -- this normalizes all of those into one shape so
 * callers can compare like-for-like.
 */
export const extractExternalIds = (obj: any): ExternalIds => {
  if (!obj || typeof obj !== 'object') return {};

  const rawImdb = obj.imdb_id ?? obj.imdbId ?? obj.imdbID ?? obj.imdb;
  const rawTmdb = obj.tmdb_id ?? obj.tmdbId ?? obj.tmdbID ?? obj.tmdb;

  let imdbId: string | undefined =
    typeof rawImdb === 'string' && IMDB_ID_PATTERN.test(rawImdb.trim())
      ? rawImdb.trim().toLowerCase()
      : undefined;
  let tmdbId: string | undefined =
    rawTmdb !== undefined && rawTmdb !== null && String(rawTmdb).trim() !== ''
      ? String(rawTmdb).trim()
      : undefined;

  const rawId = typeof obj.id === 'string' ? obj.id.trim() : undefined;
  if (rawId) {
    if (!imdbId && IMDB_ID_PATTERN.test(rawId)) {
      imdbId = rawId.toLowerCase();
    }
    if (!tmdbId) {
      const tmdbMatch = rawId.match(TMDB_PREFIXED_ID_PATTERN);
      if (tmdbMatch) tmdbId = tmdbMatch[1];
    }
  }

  return { imdbId, tmdbId };
};

/** True when an object had a usable IMDb or TMDB id extracted from it. */
export const hasExternalId = (ids: ExternalIds): boolean =>
  Boolean(ids.imdbId || ids.tmdbId);

/**
 * True when both sides name the same external id. Only ever consulted once
 * the candidate is known to have *some* id (see `hasExternalId`) -- a
 * target with no id of the matching kind simply fails to agree, it doesn't
 * fall back to text matching (that fallback only applies when the
 * candidate has no id at all).
 */
export const hasMatchingExternalId = (target: ExternalIds, candidate: ExternalIds): boolean => {
  if (target.imdbId && candidate.imdbId) return target.imdbId === candidate.imdbId;
  if (target.tmdbId && candidate.tmdbId) return target.tmdbId === candidate.tmdbId;
  return false;
};
