import {create} from 'zustand';
import {createJSONStorage, persist} from 'zustand/middleware';
import {createZustandStorage} from '../storage/StorageService';

/**
 * What the viewer last picked for a title (movie or whole series): which
 * server/quality, and which audio track. Keyed the same way Continue Watching
 * rows are (the title's info-page link), so resuming the title -- or moving on
 * to its next episode -- starts with the same choices instead of the
 * provider's default.
 */
export interface PlaybackPrefs {
  server?: string;
  quality?: string;
  tags?: string[];
  audioLanguage?: string;
  audioTitle?: string;
  updatedAt: number;
}

interface PlaybackPrefsState {
  prefs: Record<string, PlaybackPrefs>;
  setSource: (
    key: string | undefined,
    source: {server?: string; quality?: string; tags?: string[]},
  ) => void;
  setAudio: (
    key: string | undefined,
    audio: {language?: string; title?: string},
  ) => void;
}

const MAX_TITLES = 100;

const trim = (prefs: Record<string, PlaybackPrefs>) => {
  const keys = Object.keys(prefs);
  if (keys.length <= MAX_TITLES) return prefs;
  const keep = keys
    .sort((a, b) => prefs[b].updatedAt - prefs[a].updatedAt)
    .slice(0, MAX_TITLES);
  return Object.fromEntries(keep.map(k => [k, prefs[k]]));
};

const usePlaybackPrefsStore = create<PlaybackPrefsState>()(
  persist(
    set => ({
      prefs: {},
      setSource: (key, source) => {
        if (!key) return;
        set(state =>
          ({
            prefs: trim({
              ...state.prefs,
              [key]: {
                ...state.prefs[key],
                server: source.server || undefined,
                quality: source.quality ? String(source.quality) : undefined,
                tags: source.tags || [],
                updatedAt: Date.now(),
              },
            }),
          }),
        );
      },
      setAudio: (key, audio) => {
        if (!key) return;
        set(state => ({
          prefs: trim({
            ...state.prefs,
            [key]: {
              ...state.prefs[key],
              audioLanguage: audio.language || undefined,
              audioTitle: audio.title || undefined,
              updatedAt: Date.now(),
            },
          }),
        }));
      },
    }),
    {
      name: 'playback-prefs-storage',
      storage: createJSONStorage(() => createZustandStorage()),
    },
  ),
);

export const getPlaybackPrefs = (key?: string): PlaybackPrefs | undefined =>
  key ? usePlaybackPrefsStore.getState().prefs[key] : undefined;

const tagsOf = (stream: any): string => {
  const raw: any[] = Array.isArray(stream?.tags)
    ? stream.tags
    : typeof stream?.tag === 'string'
    ? [stream.tag]
    : [];
  const quality = String(stream?.quality ?? '').trim().toLowerCase();
  return raw
    .map(t => (typeof t === 'string' ? t.trim() : ''))
    .filter(t => Boolean(t) && t.toLowerCase() !== quality)
    .join('|');
};

/**
 * The stream matching what the viewer chose last time for this title: same
 * server (when it has one) and quality, then same tags. Undefined when nothing
 * matches, so the caller keeps its normal default.
 */
export const pickPreferredStream = <T extends {server?: string; quality?: any}>(
  streams: T[],
  prefs?: PlaybackPrefs,
): T | undefined => {
  if (!prefs || (!prefs.server && !prefs.quality)) return undefined;
  const wantTags = (prefs.tags || []).join('|');
  let best: T | undefined;
  let bestScore = -1;
  for (const s of streams) {
    const sameQuality = String(s.quality ?? '') === String(prefs.quality ?? '');
    if (prefs.server) {
      if (s.server !== prefs.server) continue;
    } else if (!sameQuality) {
      continue;
    }
    const score = (sameQuality ? 2 : 0) + (tagsOf(s) === wantTags ? 1 : 0);
    if (score > bestScore) {
      best = s;
      bestScore = score;
    }
  }
  return best;
};

/** Index of the audio track the viewer chose last time, or -1. */
export const findPreferredAudioIndex = (
  tracks: any[],
  prefs?: PlaybackPrefs,
): number => {
  if (!prefs || (!prefs.audioLanguage && !prefs.audioTitle)) return -1;
  const lang = (t: any) => String(t?.language || t?.lang || '').toLowerCase();
  const title = (t: any) => String(t?.title || t?.label || '').trim();
  let best = -1;
  let bestScore = 0;
  tracks.forEach((t, i) => {
    const sameLang = !!prefs.audioLanguage && lang(t) === prefs.audioLanguage;
    const sameTitle = !!prefs.audioTitle && title(t) === prefs.audioTitle;
    const score = (sameLang ? 2 : 0) + (sameTitle ? 1 : 0);
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  return best;
};

export default usePlaybackPrefsStore;
