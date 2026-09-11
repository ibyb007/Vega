import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, StyleSheet, StatusBar, Dimensions, BackHandler } from 'react-native';
import BootSplash from 'react-native-bootsplash';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './lib/client';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { M3ThemeProvider } from './theme/M3ThemeProvider';
import GlobalErrorBoundary from './components/GlobalErrorBoundary';
import WafWebViewDialog from './components/WafWebViewDialog';
import ProviderSandboxHost from './components/ProviderSandboxHost';
import AppDialogHost from './components/AppDialogHost';
import { syncDohSettings } from './lib/services/dohService';
import { updateProvidersService } from './lib/services/UpdateProviders';
import useContentStore from './lib/zustand/contentStore';
import type { TextTracks } from './lib/providers/types';

// TV Components & Screens
import { TVNavigationRail, TVNavigationRailHandle, TVRoute } from './components/tv/TVNavigationRail';
import { TVHomeScreen } from './screens/tv/TVHomeScreen';
import { TVSourceSelectScreen } from './screens/tv/TVSourceSelectScreen';
import { TVSettingsScreen } from './screens/tv/TVSettingsScreen';
import { TVPlayerScreen } from './screens/tv/TVPlayerScreen';
import { TVDetailsScreen } from './screens/tv/TVDetailsScreen';
import { TVDiscoverScreen } from './screens/tv/TVDiscoverScreen';
import TVSearch from './screens/Search';
import Extensions from './screens/settings/Extensions';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

export interface ActiveStreamPayload {
  url: string;
  title: string;
  posterUrl?: string;
  itemLink?: string;
  episodeId?: string;
  providerValue?: string;
  episodes?: any[];
  currentEpisodeIndex?: number;
  servers?: { name: string; url: string; headers?: Record<string, string>; sourceType?: string }[];
  qualities?: { name: string; url: string; headers?: Record<string, string>; sourceType?: string }[];
  headers?: Record<string, string>;
  sourceType?: string;
  subtitles?: TextTracks;
  startPosition?: number;
}

export default function App() {
  const [currentRoute, setCurrentRoute] = useState<TVRoute>('home');
  const [routeHistory, setRouteHistory] = useState<TVRoute[]>(['home']);
  const [selectedItem, setSelectedItem] = useState<any | null>(null);
  const [activeStream, setActiveStream] = useState<ActiveStreamPayload | null>(null);
  const [navHandles, setNavHandles] = useState<Partial<Record<TVRoute, number>>>({});
  const navRailRef = useRef<TVNavigationRailHandle | null>(null);
  const navExpandedRef = useRef(false);
  const currentProvider = useContentStore((state) => state.provider);

  const handleRegisterRouteHandle = useCallback((route: TVRoute, handle: number | null) => {
    setNavHandles((prev) => {
      if (handle == null) {
        if (!(route in prev)) return prev;
        const next = { ...prev };
        delete next[route];
        return next;
      }
      if (prev[route] === handle) return prev;
      return { ...prev, [route]: handle };
    });
  }, []);

  const entryHandleGetterRef = useRef<Partial<Record<TVRoute, () => number | null>>>({});

  const handleRegisterEntryHandleGetter = useCallback(
    (route: TVRoute) => (getter: (() => number | null) | null) => {
      if (getter) {
        entryHandleGetterRef.current[route] = getter;
      } else {
        delete entryHandleGetterRef.current[route];
      }
    },
    []
  );

  const handleGetEntryFocusHandle = useCallback((route: TVRoute) => {
    return entryHandleGetterRef.current[route]?.() ?? null;
  }, []);

  const entryReturnTriggerRef = useRef<Partial<Record<TVRoute, () => void>>>({});

  const handleRegisterReturnFocusTrigger = useCallback(
    (route: TVRoute) => (trigger: (() => void) | null) => {
      if (trigger) {
        entryReturnTriggerRef.current[route] = trigger;
      } else {
        delete entryReturnTriggerRef.current[route];
      }
    },
    []
  );

  const handleRequestContentFocus = useCallback((route: TVRoute) => {
    entryReturnTriggerRef.current[route]?.();
  }, []);

  useEffect(() => {
    BootSplash.hide({ fade: false }).catch(() => {});
    syncDohSettings().catch((e) => console.warn('[DoH] Startup error:', e));
    try {
      updateProvidersService.startAutomaticUpdateCheck();
    } catch (e) {
      console.warn('[UpdateProviders] Init failed:', e);
    }

    return () => {
      try {
        updateProvidersService.stopAutomaticUpdateCheck();
      } catch {}
    };
  }, []);

  const navigateTo = useCallback((route: TVRoute) => {
    setSelectedItem(null);
    setCurrentRoute((prev) => {
      if (prev !== route) {
        setRouteHistory((h) => [...h, route]);
      }
      return route;
    });
  }, []);

  useEffect(() => {
    const handleBackPress = () => {
      if (activeStream) {
        setActiveStream(null);
        return true;
      }

      if (selectedItem) {
        setSelectedItem(null);
        return true;
      }

      // If nav rail itself holds focus, Back exits the app
      if (navExpandedRef.current) {
        BackHandler.exitApp();
        return true;
      }

      // If in any top-level tab content, Back moves focus to that tab's rail button
      if (navRailRef.current) {
        navRailRef.current.focusRoute(currentRoute);
        return true;
      }

      return false;
    };

    const sub = BackHandler.addEventListener('hardwareBackPress', handleBackPress);
    return () => sub.remove();
  }, [activeStream, selectedItem, currentRoute]);

  return (
    <SafeAreaProvider style={styles.rootContainer}>
      <GestureHandlerRootView style={styles.rootContainer}>
        <M3ThemeProvider>
          <GlobalErrorBoundary>
            <QueryClientProvider client={queryClient}>
              <View style={styles.rootContainer}>
                <StatusBar
                  hidden={true}
                  translucent={true}
                  backgroundColor="transparent"
                  barStyle="light-content"
                />
                <AppDialogHost />

                {activeStream ? (
                  <TVPlayerScreen
                    streamUrl={activeStream.url}
                    title={activeStream.title}
                    posterUrl={activeStream.posterUrl}
                    itemLink={activeStream.itemLink}
                    episodeId={activeStream.episodeId}
                    providerValue={activeStream.providerValue || currentProvider?.value}
                    headers={activeStream.headers}
                    sourceType={activeStream.sourceType}
                    subtitles={activeStream.subtitles}
                    episodes={activeStream.episodes}
                    currentEpisodeIndex={activeStream.currentEpisodeIndex}
                    servers={activeStream.servers}
                    qualities={activeStream.qualities}
                    startPosition={activeStream.startPosition}
                    onSelectNextEpisode={(nextEp) => {
                      const nextIndex = (activeStream.currentEpisodeIndex ?? 0) + 1;
                      setActiveStream((prev) =>
                        prev
                          ? {
                              ...prev,
                              url: nextEp.url || prev.url,
                              title: nextEp.title || prev.title,
                              currentEpisodeIndex: nextIndex,
                              headers: nextEp.headers,
                              sourceType: nextEp.sourceType,
                              subtitles: nextEp.subtitles,
                              qualities: nextEp.qualities,
                              servers: undefined,
                            }
                          : null
                      );
                    }}
                    onClose={() => setActiveStream(null)}
                  />
                ) : selectedItem ? (
                  <TVDetailsScreen
                    item={selectedItem}
                    onBack={() => setSelectedItem(null)}
                    onPlayStream={(streamUrl, title, extraMeta) =>
                      setActiveStream({
                        url: streamUrl,
                        title: title || selectedItem.title,
                        posterUrl: selectedItem.image || selectedItem.poster,
                        itemLink: selectedItem.link,
                        providerValue: selectedItem.provider || currentProvider?.value,
                        ...extraMeta,
                      })
                    }
                  />
                ) : (
                  <View style={styles.layout}>
                    <View style={styles.viewport}>
                      {currentRoute === 'home' && (
                        <TVHomeScreen
                          onNavigateRoute={navigateTo}
                          onSelectItem={(item) => setSelectedItem(item)}
                          navFocusTarget={navHandles.home ?? null}
                          onFocusHomeNav={() => navRailRef.current?.focusRoute('home')}
                          onRegisterEntryHandleGetter={handleRegisterEntryHandleGetter('home')}
                          onRegisterReturnFocusTrigger={handleRegisterReturnFocusTrigger('home')}
                        />
                      )}

                      {currentRoute === 'search' && (
                        <TVSearch
                          onSelectItem={(item) => setSelectedItem(item)}
                          navFocusTarget={navHandles.search ?? null}
                          onFocusNav={() => navRailRef.current?.focusRoute('search')}
                        />
                      )}

                      {currentRoute === 'discover' && (
                        <TVDiscoverScreen
                          onNavigateRoute={navigateTo}
                          onSelectItem={(item) => setSelectedItem(item)}
                          onPlayStream={(streamUrl, title, extraMeta) =>
                            setActiveStream({
                              url: streamUrl,
                              title: title || extraMeta?.itemLink || 'Unknown',
                              providerValue: extraMeta?.providerValue || currentProvider?.value,
                              ...extraMeta,
                            })
                          }
                          discoverFocusTarget={navHandles.discover ?? null}
                          onFocusDiscoverNav={() => navRailRef.current?.focusRoute('discover')}
                        />
                      )}

                      {currentRoute === 'sources' && (
                        <TVSourceSelectScreen
                          onNavigateHome={() => navigateTo('home')}
                          onNavigateAddons={() => navigateTo('addons')}
                          navFocusTarget={navHandles.sources ?? null}
                        />
                      )}

                      {currentRoute === 'addons' && (
                        <Extensions
                          navigation={{
                            navigate: (screen: string) => navigateTo(screen.toLowerCase() as any),
                            goBack: () => navigateTo('home'),
                          } as any}
                          route={{} as any}
                          navFocusTarget={navHandles.addons ?? null}
                        />
                      )}

                      {currentRoute === 'settings' && (
                        <TVSettingsScreen navFocusTarget={navHandles.settings ?? null} />
                      )}
                    </View>

                    <TVNavigationRail
                      ref={navRailRef}
                      currentRoute={currentRoute}
                      onRouteChange={navigateTo}
                      onRegisterRouteHandle={handleRegisterRouteHandle}
                      onExpandedChange={(expanded) => {
                        navExpandedRef.current = expanded;
                      }}
                      onRequestContentFocus={handleRequestContentFocus}
                      onGetEntryFocusHandle={handleGetEntryFocusHandle}
                    />
                  </View>
                )}

                <WafWebViewDialog />
                <ProviderSandboxHost />
              </View>
            </QueryClientProvider>
          </GlobalErrorBoundary>
        </M3ThemeProvider>
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  rootContainer: {
    flex: 1,
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT,
    backgroundColor: '#0A0A0E',
  },
  layout: {
    flex: 1,
    position: 'relative',
    width: '100%',
    height: '100%',
  },
  viewport: {
    flex: 1,
    height: '100%',
    backgroundColor: '#0A0A0E',
  },
});
