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
 * Pulls a leading 4-digit year out of a title if the provider embedded it
 * there directly, e.g. "The Hobbit: An Unexpected Journey (2012)".
 */
export const extractYearFromTitle = (raw: string): string | undefined => {
  const match = raw.match(/\((19|20)\d{2}\)|\b(19|20)\d{2}\b$/);
  if (!match) return undefined;
  const digits = match[0].replace(/[^\d]/g, '');
  return digits.length === 4 ? digits : undefined;
};

/**
 * Normalizes a title for comparison: truncates at the first release/quality
 * marker, lowercases, drops a leading article, strips a trailing embedded
 * year, bracketed/parenthetical noise, punctuation, and collapses
 * whitespace.
 */
export const cleanTitle = (raw: string): string => {
  return truncateAtReleaseMarker(raw || '')
    .toLowerCase()
    .replace(TRAILING_YEAR, '')
    .replace(BRACKETED, ' ')
    .replace(ARTICLE_PREFIX, '')
    .replace(NON_WORD, ' ')
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

  // An exact title match is trusted on its own -- two addons agreeing on
  // the full title is strong enough signal that we don't also gate it on
  // year, which varies too much between sources to be a reliable veto here.
  if (normTarget.length > 0 && normTarget === normCandidate) {
    return true;
  }

  const resolvedTargetYear = targetYear || extractYearFromTitle(targetTitle);
  const resolvedCandidateYear = candidateYear || extractYearFromTitle(candidateTitle);
  if (!yearsAreCompatible(resolvedTargetYear, resolvedCandidateYear)) {
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
