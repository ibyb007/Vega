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
  /\b(dual audio|multi audio|multi[- ]sub(bed)?|dubbed|subbed|hindi|tamil|telugu|kannada|malayalam|punjabi|english|4k|2160p|1080p|720p|480p|bluray|blu-ray|webrip|web[- ]?dl|hdrip|hdcam|camrip|dvdrip|hdtc|hdts|remastered|extended( edition)?|director'?s cut|theatrical cut|unrated|uncut|imax|hdr10?|dolby atmos|dts|x264|x265|hevc|10bit|proper|repack|netflix|prime video|amazon prime|jiohotstar|hotstar|disney\+?|disney plus|hbo max|apple tv\+?|paramount\+?|peacock|zee5|sonyliv|voot|mx player|crunchyroll|added|s\d{1,2}e\d{1,3}|s\d{1,2}(?!\w)|season\s*\d*|complete\s*series|all\s*episodes?)\b/i;

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
 * truncated title first rather than only the absolute end of the raw
 * string -- addons commonly glue the year on with a dot/dash separator
 * followed by more release tags ("2024.webdl.1080p"), not just trailing
 * whitespace.
 *
 * Provider title layouts aren't consistent about *where* the year sits
 * relative to release tags, though -- most put it right after the title
 * ("The Gentlemen (2019) Dual Audio ..."), which the truncated search
 * above catches, but some put it after a tag instead ("The Gentlemen Dual
 * Audio 2019 2160p ..."), which would truncate the year away before this
 * function ever sees it. So if nothing turns up in the truncated portion,
 * this falls back to scanning the *full* raw string -- still preferring a
 * parenthesized year (least ambiguous) over a loose one. A missing year
 * on the correct match is harmless (the permissive "nothing to disqualify
 * on" fallback exists for exactly that), but a year that's present yet
 * unreachable is what let a same-titled wrong-type release slip past the
 * year check entirely.
 */
export const extractYearFromTitle = (raw: string): string | undefined => {
  const truncated = truncateAtReleaseMarker(raw || '');
  const parenMatch = truncated.match(/\((19|20)\d{2}\)/);
  if (parenMatch) return parenMatch[0].replace(/[^\d]/g, '');
  const looseMatch = truncated.match(/\b(19|20)\d{2}\b(?!\d)/);
  if (looseMatch) return looseMatch[0];

  const full = raw || '';
  const fullParenMatch = full.match(/\((19|20)\d{2}\)/);
  if (fullParenMatch) return fullParenMatch[0].replace(/[^\d]/g, '');
  const fullLooseMatch = full.match(/\b(19|20)\d{2}\b(?!\d)/);
  return fullLooseMatch ? fullLooseMatch[0] : undefined;
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

// ---------------------------------------------------------------------------
// Media kind (movie vs series) matching
// ---------------------------------------------------------------------------
// Year tolerance alone doesn't disambiguate a movie and a series that happen
// to share a title and land within YEAR_TOLERANCE of each other (or where
// one side's year is simply missing) -- e.g. the 2019 "The Gentlemen" movie
// vs. the 2024- "The Gentlemen" series. Where the kind of release is actually
// known (from the catalog item's own `type`, a provider's resolved metadata,
// or season/episode markers in the scraped title itself), that's used as an
// extra, independent veto alongside the year check.

const SERIES_TITLE_MARKER =
  /\b(s\d{1,2}e\d{1,3}|s\d{1,2}(?!\w)|season\s*\d*|complete\s*series|all\s*episodes?|episodes?\s*\d+)\b/i;

/** True when the raw scraped title itself carries a season/episode marker. */
export const isSeriesTitle = (raw: string): boolean => SERIES_TITLE_MARKER.test(raw || '');

/**
 * Folds the various spellings addons/Cinemeta use for content kind
 * ('series', 'tv', 'tvSeries', 'show', 'movie', 'film', ...) down to the two
 * kinds this app cares about. Returns undefined for anything unrecognized --
 * callers treat "unrecognized" the same as "unknown", never as a guessed
 * movie.
 */
export const normalizeMediaKind = (raw?: string | null): 'movie' | 'series' | undefined => {
  if (!raw) return undefined;
  const v = String(raw).trim().toLowerCase();
  if (['series', 'tv', 'tvseries', 'tv_series', 'show', 'tvshow', 'tv_show'].includes(v)) return 'series';
  if (['movie', 'film'].includes(v)) return 'movie';
  return undefined;
};

/**
 * Best-effort "is this a series?" read on one side of a match. Prefers an
 * explicit type field (e.g. the catalog item's `type`, or a provider's own
 * resolved metadata `type`) and only falls back to scanning the title text
 * for season/episode markers when no type field is available. Returns
 * undefined -- not `false` -- when there's genuinely no signal either way:
 * the *absence* of "Season"/"S01" in a title is not proof a release is a
 * movie, since plenty of legitimate series posts carry no season tag at all.
 */
export const inferMediaKind = (type?: string | null, title?: string): 'movie' | 'series' | undefined => {
  const fromType = normalizeMediaKind(type);
  if (fromType) return fromType;
  if (title && isSeriesTitle(title)) return 'series';
  return undefined;
};

/**
 * True only when both sides have a *confident* kind and they disagree. Never
 * trips on missing/unknown data on either side -- this is a veto for a known
 * conflict, not a requirement that both sides be classified, so it can't
 * turn into a new source of false negatives when a provider simply doesn't
 * report a type.
 */
export const mediaKindsConflict = (
  targetType?: string | null,
  candidateType?: string | null,
  targetTitle?: string,
  candidateTitle?: string,
): boolean => {
  const targetKind = inferMediaKind(targetType, targetTitle);
  const candidateKind = inferMediaKind(candidateType, candidateTitle);
  if (!targetKind || !candidateKind) return false;
  return targetKind !== candidateKind;
};

/**
 * True when `candidateTitle` should be treated as the same release as
 * `targetTitle` (the poster the user clicked). `targetType`/`candidateType`
 * are optional -- pass them whenever a `'movie' | 'series'` type is known
 * (catalog item type, provider search-result type, resolved metadata type)
 * so an exact-title-and-compatible-year match can still be vetoed when the
 * two sides are confidently different kinds of release.
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

  if (mediaKindsConflict(targetType, candidateType, targetTitle, candidateTitle)) {
    return false;
  }

  const normTarget = cleanTitle(targetTitle);
  const normCandidate = cleanTitle(candidateTitle);

  const resolvedTargetYear = targetYear || extractYearFromTitle(targetTitle);
  const resolvedCandidateYear = candidateYear || extractYearFromTitle(candidateTitle);
  const bothYearsKnown = Boolean(resolvedTargetYear && resolvedCandidateYear);
  const yearsOk = yearsAreCompatible(resolvedTargetYear, resolvedCandidateYear);

  // An exact (year-stripped) title match is only decisive when both sides
  // actually name a year to compare -- e.g. "The Gentlemen" (2024) vs "The
  // Gentlemen (2019)" clean down to the same text but are different
  // releases, so an explicit, incompatible year still vetoes the match.
  // If either side's year is unknown -- including the *target's*, not just
  // the candidate's -- text alone can't rule out a same-titled movie/series
  // pair, so this is left ambiguous (see isAmbiguousYearMatch) for the
  // caller to verify via metadata rather than auto-accepted.
  if (normTarget.length > 0 && normTarget === normCandidate) {
    return bothYearsKnown && yearsOk;
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
 * True when `isStrictMatch` would leave `candidateTitle` undecided against
 * `targetTitle` purely because a year is missing on one side or the other --
 * i.e. the titles line up exactly, but either the target's own year (from
 * the catalog item the user actually clicked) or the candidate's (from the
 * provider's search result) isn't available to compare.
 *
 * That's exactly the shape of bug this was added for: clicking
 * "The Gentlemen (2024-)" (a series) matched a provider's "The Gentlemen"
 * search hit for the unrelated 2019 movie, because that provider's search
 * results never include a year in the title -- even though the same
 * provider's own metadata for that specific link (what its details screen
 * would show, once resolved) does know it's the 2019 release. A missing
 * *target* year (e.g. a catalog manifest that doesn't populate it) opens
 * the identical gap in the other direction, so it's treated the same way.
 *
 * Callers should treat a `true` result here as "needs verification"
 * rather than "safe to show as a matched result": look up the candidate's
 * own metadata (e.g. resolve its imdb/tmdb id and/or its own `type` the
 * same way the details screen does) to see if that resolves the ambiguity.
 * Only fall back to treating it as a match if that metadata *also* has
 * nothing to go on -- at that point there's genuinely no year anywhere for
 * this source to disqualify it with, which is the one case a permissive
 * fallback should still apply to.
 *
 * `targetType`/`candidateType` follow the same contract as in
 * `isStrictMatch`: when both sides confidently resolve to different kinds of
 * release, this returns false outright -- there's no ambiguity left to
 * verify, the candidate is simply the wrong kind.
 */
export const isAmbiguousYearMatch = (
  targetTitle: string,
  candidateTitle: string,
  targetYear?: string,
  candidateYear?: string,
  targetType?: string,
  candidateType?: string,
): boolean => {
  if (!targetTitle || !candidateTitle) return false;

  if (mediaKindsConflict(targetType, candidateType, targetTitle, candidateTitle)) {
    return false;
  }

  const normTarget = cleanTitle(targetTitle);
  const normCandidate = cleanTitle(candidateTitle);
  if (!(normTarget.length > 0 && normTarget === normCandidate)) return false;

  const resolvedTargetYear = targetYear || extractYearFromTitle(targetTitle);
  const resolvedCandidateYear = candidateYear || extractYearFromTitle(candidateTitle);

  return !(resolvedTargetYear && resolvedCandidateYear);
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
