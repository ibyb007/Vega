import { create } from 'zustand';
import { mainStorage } from '../storage';

export type VideoPlayerType = 'inbuilt' | 'vlc' | 'external';
export type AudioBoostProfile = 'off' | 'rich' | 'dialogue';

interface SettingsState {
  defaultPlayer: VideoPlayerType;
  setDefaultPlayer: (player: VideoPlayerType) => void;
  audioBoostProfile: AudioBoostProfile;
  setAudioBoostProfile: (profile: AudioBoostProfile) => void;
  cycleAudioBoostProfile: () => AudioBoostProfile;
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

const getStoredAudioBoost = (): AudioBoostProfile => {
  try {
    const saved = mainStorage.getString('audioBoostProfile');
    if (saved === 'rich' || saved === 'dialogue' || saved === 'off') {
      return saved;
    }
  } catch {}
  return 'off';
};

export const useSettingsStore = create<SettingsState>((set, get) => ({
  defaultPlayer: getStoredPlayer(),
  setDefaultPlayer: (player: VideoPlayerType) => {
    try {
      mainStorage.setString('defaultPlayer', player);
    } catch (e) {
      console.warn('[SettingsStore] Failed to persist defaultPlayer:', e);
    }
    set({ defaultPlayer: player });
  },

  audioBoostProfile: getStoredAudioBoost(),
  setAudioBoostProfile: (profile: AudioBoostProfile) => {
    try {
      mainStorage.setString('audioBoostProfile', profile);
    } catch (e) {
      console.warn('[SettingsStore] Failed to persist audioBoostProfile:', e);
    }
    set({ audioBoostProfile: profile });
  },

  cycleAudioBoostProfile: () => {
    const current = get().audioBoostProfile;
    const next: AudioBoostProfile =
      current === 'off' ? 'rich' : current === 'rich' ? 'dialogue' : 'off';
    try {
      mainStorage.setString('audioBoostProfile', next);
    } catch (e) {
      console.warn('[SettingsStore] Failed to persist audioBoostProfile:', e);
    }
    set({ audioBoostProfile: next });
    return next;
  },
}));

export default useSettingsStore;
