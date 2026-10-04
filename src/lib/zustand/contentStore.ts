import {create} from 'zustand';
import {persist, createJSONStorage} from 'zustand/middleware';
import {createZustandStorage} from '../storage/StorageService';
// import {ProvidersList, providersList} from '../constants';
import {extensionStorage, ProviderExtension} from '../storage/extensionStorage';

export interface Content {
  provider: ProviderExtension;
  setProvider: (type: ProviderExtension) => void;
  // Optional 2nd addon source. When set, the Home Screen fetches both the
  // primary `provider`'s catalog (top rows) and this one's catalog (bottom
  // rows) and stitches them into a single list of rows. `null` means only
  // the primary source is active.
  secondaryProvider: ProviderExtension | null;
  setSecondaryProvider: (type: ProviderExtension | null) => void;
  // Extension-based provider management
  installedProviders: ProviderExtension[];
  availableProviders: ProviderExtension[];
  setInstalledProviders: (providers: ProviderExtension[]) => void;
  setAvailableProviders: (providers: ProviderExtension[]) => void;
  activeExtensionProvider: ProviderExtension | null;
  setActiveExtensionProvider: (provider: ProviderExtension | null) => void;
}

const useContentStore = create<Content>()(
  persist(
    (set, _get) => ({
      provider: {
        value: '',
        display_name: '',
        type: 'global',
        installed: false,
        disabled: false,
        version: '0.0.1',
        icon: '',
        source: {author: '', url: ''},
        installedAt: 0,
        lastUpdated: 0,
      },
      secondaryProvider: null,
      installedProviders: extensionStorage
        .getInstalledProviders()
        .sort((a, b) => a.display_name.localeCompare(b.display_name)),
      availableProviders: [],
      activeExtensionProvider: null,

      setProvider: (provider: ProviderExtension) =>
        set(state => ({
          provider,
          // Can't have the same addon active as both primary and
          // secondary -- clear the secondary slot if it now matches.
          secondaryProvider:
            state.secondaryProvider?.value === provider.value
              ? null
              : state.secondaryProvider,
        })),

      setSecondaryProvider: (secondaryProvider: ProviderExtension | null) =>
        set({secondaryProvider}),

      setInstalledProviders: (providers: ProviderExtension[]) =>
        set({
          installedProviders: providers.sort((a, b) =>
            a.display_name.localeCompare(b.display_name),
          ),
        }),

      setAvailableProviders: (providers: ProviderExtension[]) =>
        set({availableProviders: providers}),

      setActiveExtensionProvider: (provider: ProviderExtension | null) =>
        set({activeExtensionProvider: provider}),
    }),
    {
      name: 'content-storage',
      storage: createJSONStorage(() => createZustandStorage()), // Only persist certain fields
      partialize: state => ({
        provider: state.provider,
        secondaryProvider: state.secondaryProvider,
        activeExtensionProvider: state.activeExtensionProvider,
      }),
    },
  ),
);

export default useContentStore;
