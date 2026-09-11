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
  // Stable per-episode identity ("S{season}E{episode}") -- see
  // ContinueWatchingItem.episodeKey. Undefined for movies.
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
  // Native node handle for each nav rail button, keyed by route. Populated
  // once by TVNavigationRail on mount (see onRegisterRouteHandle below).
  // Screens use `navHandles[currentRoute]` as the `nextFocusLeft` target for
  // their leftmost/first-column focusables, so pressing Left from the edge
  // of *any* tab's content returns to *that* tab's own rail button instead
  // of always jumping to Home.
  const [navHandles, setNavHandles] = useState<Partial<Record<TVRoute, number>>>({});
  // Lets the hardware Back handler below imperatively move focus onto a
  // rail button (see TVNavigationRailHandle) -- used so Back on the
  // Settings screen always lands focus on the Settings icon instead of
  // navigating away.
  const navRailRef = useRef<TVNavigationRailHandle | null>(null);
  // Tracks whether the nav rail itself currently holds focus (any button),
  // as opposed to focus being inside a tab's content. Read synchronously
  // in the hardware Back handler below, so it's a ref rather than state --
  // state would mean re-subscribing the BackHandler listener on every
  // expand/collapse.
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

  // Per-route getter for "the native node handle of whichever card this
  // screen's content last had focus on" -- only TVHomeScreen registers one
  // today. Kept as a ref rather than state: it's read once, synchronously,
  // right when a rail button receives focus, and re-registering on every
  // poster focus change (which is how often the answer can change) would
  // be wasteful churn for something nothing ever renders off of.
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

  // Per-route "hand focus back to whichever card was last focused" trigger,
  // for when OK is pressed on a rail button whose tab is already active (a
  // no-op route change, so there's nothing for a directional focus search
  // to hook into the way there is for Right). Kept as a ref for the same
  // reason as entryHandleGetterRef above. Only TVHomeScreen registers one
  // today -- it force-remounts just the one poster that needs its
  // `hasTVPreferredFocus` to re-fire. An earlier version of this remounted
  // the *entire* screen instead (reusing the same mount-time focus logic,
  // just at a much bigger scope), which technically worked but was
  // visibly a full refresh and made the rail feel laggy right after, since
  // it re-ran every hook on the screen including the catalog data fetch.
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

  // Continue Watching poster presses now route through `TVDetailsScreen`
  // (via `onSelectItem` + a `resumeHint` on the item, wired in
  // `TVHomeScreen`) instead of being resolved and launched directly from
  // here. Providers' resolved stream links -- and sometimes even their
  // info-page links -- are often short-lived, so silently replaying an old
  // one straight from continue-watching tended to fail with a "provider
  // link invalid" error; going through the normal picker re-fetches
  // everything fresh, and `TVDetailsScreen` handles seeking back to the
  // saved position when the episode picked matches the one being resumed.

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

      // If focus is currently on the nav rail itself (expanded, any button
      // focused), Back always exits the app -- irrespective of which
      // button is selected -- rather than being interpreted as
      // in-app navigation. This takes priority over the Settings-specific
      // rule below, which only applies when focus is in that tab's
      // content, not on the rail button itself.
      if (navExpandedRef.current) {
        BackHandler.exitApp();
        return true;
      }

      // Settings is a dead end for hardware Back: rather than popping to
      // whatever route preceded it (which felt inconsistent depending on
      // how the user got there), Back always just returns focus to the
      // Settings rail button, the same way it would if the user had
      // arrowed all the way to the left edge of the screen.
      if (currentRoute === 'settings') {
        navRailRef.current?.focusRoute('settings');
        return true;
      }

      if (routeHistory.length > 1) {
        const nextHistory = [...routeHistory];
        nextHistory.pop();
        const prevRoute = nextHistory[nextHistory.length - 1] || 'home';
        setRouteHistory(nextHistory);
        setCurrentRoute(prevRoute);
        return true;
      }

      if (currentRoute !== 'home') {
        setCurrentRoute('home');
        setRouteHistory(['home']);
        return true;
      }

      return false;
    };

    const sub = BackHandler.addEventListener('hardwareBackPress', handleBackPress);
    return () => sub.remove();
  }, [activeStream, selectedItem, routeHistory, currentRoute]);

  return (
    <SafeAreaProvider style={styles.rootContainer}>
      <GestureHandlerRootView style={styles.rootContainer}>
        <M3ThemeProvider>
          <GlobalErrorBoundary>
            <QueryClientProvider client={queryClient}>
              <View style={styles.rootContainer}>
                {/* Translucent status bar eliminates the 1.6cm top black letterbox bar */}
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
                          onRegisterEntryHandleGetter={handleRegisterEntryHandleGetter('home')}
                          onRegisterReturnFocusTrigger={handleRegisterReturnFocusTrigger('home')}
                        />
                      )}

                      {currentRoute === 'search' && (
                        <TVSearch
                          onSelectItem={(item) => setSelectedItem(item)}
                          navFocusTarget={navHandles.search ?? null}
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
                          navFocusTarget={navHandles.discover ?? null}
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
    // Removed paddingLeft: 68 so TVHomeScreen can manage its padding cleanly
  },
});
