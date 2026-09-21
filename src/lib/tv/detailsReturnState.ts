import type { EpisodeLink } from '../providers/types';
import type { CinemetaMeta } from '../services/cinemetaService';

// App.tsx renders the player *instead of* TVDetailsScreen, so starting
// playback unmounts the details screen and closing the player mounts a
// brand-new one. Everything the person had set up -- which season/quality
// the dropdown was on, which episode they pressed -- would be lost, and the
// screen would reopen on the first season with focus on the first row.
//
// This module-level store (same pattern as TVDiscoverScreen's
// `savedDiscoverState`, and for the same reason: it must outlive the
// component) carries that across the round trip. It is written when
// playback starts and consumed by the next TVDetailsScreen mount for the
// same title. Because it is only ever written on Play, opening a title
// normally -- or backing out of details and reopening it later -- never
// sees any of it.

export interface DetailsReturnState {
  /** Info-page link + provider of the title this state belongs to. */
  itemLink: string;
  providerId: string;
  /** Dropdown selection (index into the quality-filtered link list). */
  seasonIndex: number;
  /**
   * Episode list + Cinemeta result as they were on screen. Restored so the
   * remount paints the *same* layout instantly: re-fetching would swap the
   * list for a spinner (dropping focus) and then grow it again as stills
   * and synopses arrive, shifting the row focus is meant to land on.
   */
  rawEpisodes: EpisodeLink[];
  cinemeta: CinemetaMeta | null;
  /** True once the Cinemeta lookup had finished (found something or not). */
  cinemetaSettled: boolean;
  /** Focus key of the row that was pressed (see `episodeRowKey`). */
  rowKey?: string;
  /** Stable "S{season}E{episode}" key of the last-played episode. */
  episodeKey?: string;
  /** Raw provider link of the last-played row (fallback identity). */
  episodeLink?: string;
}

let pending: DetailsReturnState | null = null;

/** Focus key for an episode row -- shared so App can address a row by episode. */
export const episodeRowKey = (episodeKey: string): string => `ep:${episodeKey}`;
/** Focus key for a source/quality row (not tied to an episode number). */
export const sourceRowKey = (index: number): string => `src:${index}`;

export const saveDetailsReturnState = (state: DetailsReturnState): void => {
  pending = state;
};

/**
 * The saved state for this title, if any. Non-destructive on purpose (a
 * render-phase read must be safe to repeat); the screen calls
 * `clearDetailsReturnState` from a mount effect once it has taken a copy.
 */
export const peekDetailsReturnState = (
  itemLink: string | undefined,
  providerId: string | undefined,
): DetailsReturnState | null => {
  if (!pending || !itemLink || !providerId) return null;
  return pending.itemLink === itemLink && pending.providerId === providerId ? pending : null;
};

export const clearDetailsReturnState = (): void => {
  pending = null;
};

/**
 * Called by App when the player closes: the person may have moved on to a
 * different episode from inside the player (Up Next / the Videos list), and
 * focus should land on the one they *finished on*, not the one they
 * started from. A no-op unless the saved state is for this same title.
 */
export const updateDetailsReturnEpisode = (
  itemLink: string | undefined,
  episode: { episodeKey: string; episodeLink?: string },
): void => {
  if (!pending || !itemLink || pending.itemLink !== itemLink) return;
  pending = {
    ...pending,
    episodeKey: episode.episodeKey,
    episodeLink: episode.episodeLink,
    rowKey: episodeRowKey(episode.episodeKey),
  };
};
