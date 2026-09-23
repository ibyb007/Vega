=// Parses real season/episode numbers out of provider-supplied labels.
//
// Providers give us free-text titles, not structured data: a season/quality
// chip's `title` might read "S01", "s1", "Season 01", "Season1", "Season 1 -
// 1080p", etc., and an episode's `title` might read "S01E12", "Episode 12",
// "EP12", "12. Some Title", or just be a plain unnumbered name. Two things
// depend on getting real numbers out of that text instead of trusting
// position-in-array:
//
//   1. Cinemeta enrichment (still/synopsis) is matched by season+episode
//      number -- if a source lists episodes newest-first, a positional
//      guess pairs Cinemeta's "Episode 1" data with the source's actual
//      latest episode.
//   2. Chronological ordering for display and for "Next Episode" in the
//      player -- both walk the `episodes` array in order, so a
//      newest-first source needs to be re-sorted before anything reads it.

// Matches S01, S1, Season 01, Season01, Season 1, "Season - 1", case
// insensitive. Deliberately does NOT match a bare "01" here -- season labels
// are short chip text ("1080p", "CAM", "HD") where a stray number is not
// safely assumed to be a season.
export const parseSeasonNumber = (label: string | undefined | null): number | null => {
  if (!label) return null;
  const m = label.match(/\bS(?:eason)?[\s._-]*(\d{1,3})(?!\d)/i);
  return m ? parseInt(m[1], 10) : null;
};

// Matches, in priority order: the E-part of a combined "S01E12" style
// label; "E12"/"EP12"/"Episode 12"; a leading "12." / "12 -" / "12:" style
// numeral prefix; then finally any standalone number anywhere in the
// string, as a last resort.
export const parseEpisodeNumber = (label: string | undefined | null): number | null => {
  if (!label) return null;

  let m = label.match(/\bS\d{1,3}[\s._-]*E(?:p(?:isode)?)?[\s._-]*(\d{1,4})\b/i);
  if (m) return parseInt(m[1], 10);

  m = label.match(/\b(?:Ep(?:isode)?|E)[\s._-]*(\d{1,4})\b/i);
  if (m) return parseInt(m[1], 10);

  m = label.match(/^\s*(\d{1,4})[\s._:)\-]/);
  if (m) return parseInt(m[1], 10);

  m = label.match(/\b(\d{1,4})\b/);
  if (m) return parseInt(m[1], 10);

  return null;
};

// True when an episode "name" is nothing but a season/episode designator
// ("S01 E01", "S01E01", "E5", "EP 12", "Episode 3", "Season 1 Episode 2").
// Providers that have no real episode titles (e.g. MovieBox Web) hand these
// back as the title. That is not a name -- prefixing it with the real
// season/episode numbers would just repeat it ("S01E01-S01 E01").
const BARE_EPISODE_LABEL =
  /^\s*(?:S(?:eason)?[\s._-]*\d{1,3}[\s._,:-]*)?E(?:p(?:isode)?)?[\s._-]*\d{1,4}\s*$/i;

export const isBareEpisodeLabel = (name: string | undefined | null): boolean =>
  Boolean(name) && BARE_EPISODE_LABEL.test(name as string);

// Formats a consistent "S01E02-Title" display label out of real
// season/episode numbers (see parseSeasonNumber/parseEpisodeNumber above)
// plus an episode's name -- used anywhere an episode is shown by itself
// without an already-visible season/episode grouping (the Home hero
// header, episode list rows, the player's "Up Next" popup). Falls back to
// just the name -- or the given placeholder -- when the season/episode
// numbers aren't known. When the name is only a bare designator (the
// provider had no real title, and Cinemeta hasn't supplied one yet) the
// label is just "S01E02" rather than "S01E02-S01 E02".
export const formatEpisodeLabel = (
  season: number | null | undefined,
  episodeNumber: number | null | undefined,
  name: string | undefined | null,
  fallback: string = 'Episode',
): string => {
  const displayName = name || fallback;
  if (season == null || episodeNumber == null) return displayName;
  const s = String(season).padStart(2, '0');
  const e = String(episodeNumber).padStart(2, '0');
  if (!name || isBareEpisodeLabel(name)) return `S${s}E${e}`;
  return `S${s}E${e}-${displayName}`;
};

// Sorts an episode list ascending by season then by parsed episode number,
// and folds out exact (season, episode) duplicates. Only reorders when a
// real number can be parsed for essentially every entry (>=80%) -- if
// parsing is spotty (mixed/unnumbered titles), a partial sort would
// interleave real positions with parsing guesses, so the provider's
// original order is trusted instead. Entries an episode number can't be
// found for are pushed to the end, keeping their relative order.
export const sortEpisodesChronologically = <T extends { title?: string }>(episodes: T[]): T[] => {
  if (episodes.length <= 1) return episodes;

  const withParsed = episodes.map((ep, originalIndex) => ({
    ep,
    originalIndex,
    // Some providers (e.g. a "list every season's episodes in one call"
    // source) don't group by season at all -- every title carries its own
    // "S01 E01" / "S02 E01" prefix instead. Read that out too so those can
    // be grouped season-by-season below rather than only by raw episode
    // number (which would otherwise interleave "episode 1 of every
    // season" together). A normal single-season list has no season token
    // in its titles at all, so this parses to null for every entry and
    // sorting falls back to episode number alone, unchanged from before.
    season: parseSeasonNumber(ep.title),
    num: parseEpisodeNumber(ep.title),
  }));

  const parsedCount = withParsed.filter((e) => e.num !== null).length;
  if (parsedCount / episodes.length < 0.8) {
    return episodes;
  }

  // Some providers hand back the same episode twice within one flattened
  // list (seen with sources that bundle multiple audio/resolution tracks
  // per season block) even though it's really a single episode -- collapse
  // those here, keeping the first occurrence, before sorting. Only a pair
  // with both a season *and* an episode number parsed is treated as a
  // duplicate of each other; anything that couldn't be parsed on either
  // axis is left alone rather than risk merging two genuinely different
  // (but unnumbered) entries.
  const seenKeys = new Set<string>();
  const deduped = withParsed.filter((e) => {
    if (e.season == null || e.num == null) return true;
    const key = `${e.season}-${e.num}`;
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  });

  return deduped
    .slice()
    .sort((a, b) => {
      // Group by season first -- a flattened multi-season list must read
      // top-to-bottom as season 1 in full, then season 2, and so on, not
      // interleaved by matching episode numbers across seasons. Entries
      // without a parseable season (the normal single-season case, where
      // titles never mention a season at all) sort together as before.
      const aSeason = a.season ?? 0;
      const bSeason = b.season ?? 0;
      if (aSeason !== bSeason) return aSeason - bSeason;
      if (a.num === null && b.num === null) return a.originalIndex - b.originalIndex;
      if (a.num === null) return 1;
      if (b.num === null) return -1;
      if (a.num !== b.num) return (a.num as number) - (b.num as number);
      return a.originalIndex - b.originalIndex;
    })
    .map((e) => e.ep);
};
