import {create} from 'zustand';
import {createJSONStorage, persist} from 'zustand/middleware';
import type {EpisodeLink} from '../providers/types';
import type {CatalogMediaItem} from '../services/stremioCatalog';
import {createZustandStorage} from '../storage/StorageService';

export interface ContinueWatchingItem {
  id: string;
  title: string;
  episodeTitle?: string;
  episode: EpisodeLink;
  // Stable per-episode identity independent of which quality/season-variant
  // link happened to be fetched during this particular play session (e.g.
  // "S1E5"). Raw provider episode links can differ across quality variants,
  // across separate fetches (some providers embed session tokens), and
  // between screens (Discover vs the details screen resolve episodes via
  // different calls) -- so matching resume position by raw link is
  // unreliable. This key, derived from parsed season/episode numbers, is
  // not. Undefined for movies (nothing to disambiguate -- a movie's entry
  // is always the one and only thing to resume).
  episodeKey?: string;
  type: string;
  poster?: string;
  background?: string;
  providerValue: string;
  infoUrl: string;
  position: number;
  duration: number;
  updatedAt: number;
  // Set only when this entry's original stream was played from the
  // Discover screen's page-2 (results) inspector rather than from this
  // title's own provider listing (Home row / Search / a normal details
  // page). Lets the Home screen's Continue Watching card reopen the same
  // Discover results view it was played from instead of the regular
  // details screen -- see TVHomeScreen's history card press handler.
  discoverSource?: CatalogMediaItem & {logo?: string; cast?: string[]; runtime?: string};
}

interface ContinueWatchingState {
  items: ContinueWatchingItem[];
  upsertItem: (item: ContinueWatchingItem) => void;
  updateProgress: (id: string, position: number, duration: number) => void;
  removeItem: (id: string) => void;
}

const useContinueWatchingStore = create<ContinueWatchingState>()(
  persist(
    set => ({
      items: [],
      upsertItem: item =>
        set(state => ({
          items: [
            item,
            ...state.items.filter(existing => existing.id !== item.id),
          ]
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, 30),
        })),
      updateProgress: (id, position, duration) =>
        set(state => ({
          items: state.items
            .map(item =>
              item.id === id
                ? {...item, position, duration, updatedAt: Date.now()}
                : item,
            )
            .sort((a, b) => b.updatedAt - a.updatedAt),
        })),
      removeItem: id =>
        set(state => ({items: state.items.filter(item => item.id !== id)})),
    }),
    {
      name: 'continue-watching-storage',
      storage: createJSONStorage(() => createZustandStorage()),
    },
  ),
);

export default useContinueWatchingStore;
