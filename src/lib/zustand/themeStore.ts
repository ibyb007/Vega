import {create} from 'zustand';
import {persist, createJSONStorage} from 'zustand/middleware';
import {createZustandStorage} from '../storage/StorageService';
import {settingsStorage} from '../storage';

export type AccentSource = 'wallpaper' | 'custom';

export interface Theme {
  primary: string;
  isCustom: boolean;
  /** Where the Material 3 palette comes from: the device wallpaper or a curated seed. */
  source: AccentSource;
  setPrimary: (type: Theme['primary']) => void;
  setCustom: (isCustom: boolean) => void;
  setSource: (source: AccentSource) => void;
}

const useThemeStore = create<Theme>()(
  persist(
    set => ({
      primary: settingsStorage.getPrimaryColor(),
      isCustom: settingsStorage.isCustomTheme(),
      source: settingsStorage.getAccentSource(),

      setPrimary: (primary: Theme['primary']) => {
        set({primary});
        settingsStorage.setPrimaryColor(primary);
      },
      setCustom: (isCustom: Theme['isCustom']) => {
        set({isCustom});
        settingsStorage.setCustomTheme(isCustom);
      },
      setSource: (source: AccentSource) => {
        set({source});
        settingsStorage.setAccentSource(source);
      },
    }),
    {
      name: 'content-storage',
      storage: createJSONStorage(() => createZustandStorage()),
    },
  ),
);

export default useThemeStore;
