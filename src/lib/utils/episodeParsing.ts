// Parses real season/episode numbers out of provider-supplied labels.
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

// Sorts an episode list ascending by parsed episode number. Only reorders
// when a real number can be parsed for essentially every entry (>=80%) --
// if parsing is spotty (mixed/unnumbered titles), a partial sort would
// interleave real positions with parsing guesses, so the provider's
// original order is trusted instead. Entries an episode number can't be
// found for are pushed to the end, keeping their relative order.
export const sortEpisodesChronologically = <T extends { title?: string }>(episodes: T[]): T[] => {
  if (episodes.length <= 1) return episodes;

  const withParsed = episodes.map((ep, originalIndex) => ({
    ep,
    originalIndex,
    num: parseEpisodeNumber(ep.title),
  }));

  const parsedCount = withParsed.filter((e) => e.num !== null).length;
  if (parsedCount / episodes.length < 0.8) {
    return episodes;
  }

  return withParsed
    .slice()
    .sort((a, b) => {
      if (a.num === null && b.num === null) return a.originalIndex - b.originalIndex;
      if (a.num === null) return 1;
      if (b.num === null) return -1;
      if (a.num !== b.num) return (a.num as number) - (b.num as number);
      return a.originalIndex - b.originalIndex;
    })
    .map((e) => e.ep);
};
