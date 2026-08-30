import { create } from 'zustand';
import { mainStorage } from '../storage';

export type VideoPlayerType = 'inbuilt' | 'vlc' | 'external';

interface SettingsState {
  defaultPlayer: VideoPlayerType;
  setDefaultPlayer: (player: VideoPlayerType) => void;
}

const getStoredPlayer = (): VideoPlayerType => {
  try {
    const saved = mainStorage.getString('defaultPlayer');
    if (saved === 'vlc' || saved === 'external' || saved === 'inbuilt') {
      return saved;
    }
  } catch {}
  return 'inbuilt';
};

export const useSettingsStore = create<SettingsState>((set) => ({
  defaultPlayer: getStoredPlayer(),
  setDefaultPlayer: (player: VideoPlayerType) => {
    try {
      mainStorage.setString('defaultPlayer', player);
    } catch (e) {
      console.warn('[SettingsStore] Failed to persist defaultPlayer:', e);
    }
    set({ defaultPlayer: player });
  },
}));

export default useSettingsStore;
