const ARTICLE_PREFIX = /^(the|a|an)\s+/i;
const TRAILING_YEAR = /\(?\b(19|20)\d{2}\b\)?\s*$/;
// Covers [...], (...), and {...} -- addons use all three for the same kind
// of noise: quality/audio tags, or release-tracking notes like
// "{S01E04 Added}".
const BRACKETED = /\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g;
const NON_WORD = /[^\w\s]/gi;
const WHITESPACE = /\s+/g;

// Unambiguous season/episode markers in a raw (un-truncated) title --
// "S01E04", "S01", "Season 2", "Complete Series", "Episode 5". Deliberately
// narrow: this is only ever used to *disqualify* a match, so it must never
// fire on a plain movie title. It does not try to detect "this is a movie"
// the same way -- absence of a marker proves nothing, since plenty of
// legitimate movie and series titles alike carry neither.
const SERIES_MARKER =
  /\b(s\d{1,2}e\d{1,3}|s\d{1,2}(?![a-z\d])|season\s*\d+|complete\s*(series|season)|all\s*episodes?|episodes?\s*\d+)\b/i;

/** True when raw title text itself unambiguously reads as series/episode content. */
export const isSeriesTitle = (raw?: string): boolean => SERIES_MARKER.test(raw || '');

type ReleaseKind = 'series' | 'movie' | 'unknown';

/**
 * Classifies a side of a match as 'series', 'movie', or 'unknown' -- an
 * explicit `type` field (from the catalog item or a provider result that
 * happens to carry one) is trusted first; only when that's absent does raw
 * title text get a chance, and only to detect 'series' (see SERIES_MARKER
 * above). Everything else stays 'unknown' rather than being guessed at,
 * since a false 'movie' classification would wrongly veto a real match.
 */
const classifyReleaseKind = (explicitType: string | undefined, title: string): ReleaseKind => {
  if (explicitType === 'series' || explicitType === 'tv') return 'series';
  if (explicitType === 'movie') return 'movie';
  return isSeriesTitle(title) ? 'series' : 'unknown';
};

/**
 * True only when there's confident, independent evidence the two sides are
 * different kinds of release (a movie result under a series target, or vice
 * versa) -- an explicit `type` field disagreeing, or one side's raw title
 * carrying an unambiguous season/episode marker the other side's classified
 * kind contradicts. This never asserts a match on its own, only a veto: if
 * either side can't be classified, it returns false and leaves the
 * decision to the rest of the title/year logic.
 *
 * This exists as its own export (not folded silently into `isStrictMatch`)
 * because it's also the right guard for the *permissive* fallback paths
 * that accept a candidate specifically because the year couldn't be
 * resolved (an ambiguous-year match with no per-candidate metadata, or a
 * metadata lookup that errored out) -- exactly the case a type mismatch
 * needs to still be able to veto, since those paths have nothing else left
 * to disqualify with.
 */
export const hasTypeMismatch = (
  targetTitle: string,
  candidateTitle: string,
  targetType?: string,
  candidateType?: string,
): boolean => {
  const targetKind = classifyReleaseKind(targetType, targetTitle);
  const candidateKind = classifyReleaseKind(candidateType, candidateTitle);
  if (targetKind === 'unknown' || candidateKind === 'unknown') return false;
  return targetKind !== candidateKind;
};

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
  targetType?: string,
  candidateType?: string,
): boolean => {
  if (!targetTitle || !candidateTitle) return false;

  // A confidently-known type mismatch (movie vs series) is an instant veto,
  // ahead of everything else -- title/year normalization alone can't tell
  // "The Gentlemen (2019)" the movie from "The Gentlemen" the running
  // series when a provider's search result happens to omit a usable year,
  // but a season/episode marker or an explicit type field settles it.
  if (hasTypeMismatch(targetTitle, candidateTitle, targetType, candidateType)) {
    return false;
  }

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

/**
 * True when `isStrictMatch` would accept `candidateTitle` as the same
 * release as `targetTitle` purely on the *permissive* branch of the
 * year check -- i.e. the titles line up exactly, we know the target's
 * year (from the catalog item the user actually clicked), but the
 * candidate's own search result carries no year at all (neither an
 * explicit year field nor one embedded in its scraped title).
 *
 * That's exactly the shape of bug this was added for: clicking
 * "The Gentlemen (2024-)" (a series) matched a provider's "The Gentlemen"
 * search hit for the unrelated 2019 movie, because that provider's search
 * results never include a year in the title -- even though the same
 * provider's own metadata for that specific link (what its details screen
 * would show, once resolved) does know it's the 2019 release.
 *
 * Callers should treat a `true` result here as "needs verification"
 * rather than "safe to show as a matched result": look up the candidate's
 * own metadata (e.g. resolve its imdb/tmdb id the same way the details
 * screen does) to see if a year turns up after all. Only fall back to
 * treating it as a match if that metadata *also* has nothing to go on --
 * at that point there's genuinely no year anywhere for this source to
 * disqualify it with, which is the one case the permissive fallback
 * should still apply to.
 */
export const isAmbiguousYearMatch = (
  targetTitle: string,
  candidateTitle: string,
  targetYear?: string,
  candidateYear?: string,
): boolean => {
  if (!targetTitle || !candidateTitle) return false;

  const normTarget = cleanTitle(targetTitle);
  const normCandidate = cleanTitle(candidateTitle);
  if (!(normTarget.length > 0 && normTarget === normCandidate)) return false;

  const resolvedTargetYear = targetYear || extractYearFromTitle(targetTitle);
  const resolvedCandidateYear = candidateYear || extractYearFromTitle(candidateTitle);

  return Boolean(resolvedTargetYear) && !resolvedCandidateYear;
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
