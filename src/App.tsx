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
import type { TextTracks, SkipInterval } from './lib/providers/types';
import { NavRail, NATIVE_RAIL_COLLAPSED_WIDTH, TVRoute } from './lib/native/NavRail';

// TV Components & Screens
import { TVHomeScreen } from './screens/tv/TVHomeScreen';
import { TVSourceSelectScreen } from './screens/tv/TVSourceSelectScreen';
import { TVSettingsScreen } from './screens/tv/TVSettingsScreen';
import { TVPlayerScreen } from './screens/tv/TVPlayerScreen';
import { TVDetailsScreen } from './screens/tv/TVDetailsScreen';
import { TVDiscoverScreen, openDiscoverResultFor } from './screens/tv/TVDiscoverScreen';
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
  skip?: SkipInterval[];
  headers?: Record<string, string>;
  sourceType?: string;
  subtitles?: TextTracks;
  startPosition?: number;
  // Present only when this stream was launched from the Discover screen's
  // page-2 results inspector -- see ContinueWatchingItem.discoverSource.
  discoverSource?: any;
}

export default function App() {
  const [currentRoute, setCurrentRoute] = useState<TVRoute>('home');
  const [routeHistory, setRouteHistory] = useState<TVRoute[]>(['home']);
  const [selectedItem, setSelectedItem] = useState<any | null>(null);
  const [activeStream, setActiveStream] = useState<ActiveStreamPayload | null>(null);
  // Mirrors the old navExpandedRef -- kept as a JS-side fallback for the
  // "rail focused -> Back exits app" rule. In normal operation
  // MainActivity's native dispatchKeyEvent (see NavRailManager.shouldExitOnBack)
  // already intercepts this before JS ever sees the key event; this stays
  // as a defensive second layer in case the native module isn't linked
  // (e.g. mid-migration, or a non-Android build).
  const navExpandedRef = useRef(false);
  // See TVNavRailView's suppress-on-unmount concern from the old JS rail:
  // no longer needed here, since the native rail is hidden via
  // NavRail.setVisible(false) rather than unmounted/remounted, so there's
  // no stray-focus-grab-during-teardown window to guard against.
  const screenBackHandlersRef = useRef<Partial<Record<TVRoute, () => boolean>>>({});
  const currentProvider = useContentStore((state) => state.provider);

  // Marks a tab "dirty" the moment the user actually navigates away from it
  // to a *different* rail tab. The next time that tab is shown again, its
  // screen is told to forget whatever item it last had focused and treat
  // the mount like a fresh launch (see `resetFocusOnMount` below). This is
  // only set on a genuine route change -- opening details/player over the
  // current tab and closing them again never touches `currentRoute`, so
  // that round trip is untouched and normal resume behaviour still applies.
  const routeFocusDirtyRef = useRef<Partial<Record<TVRoute, boolean>>>({});
  const consumeRouteFocusReset = useCallback((route: TVRoute): boolean => {
    const dirty = routeFocusDirtyRef.current[route] === true;
    if (dirty) {
      routeFocusDirtyRef.current[route] = false;
    }
    return dirty;
  }, []);

  // ---- content entry-focus plumbing (unchanged from before) --------------
  // Screens still register "where should focus land if the rail sends you
  // here" the same way they always did. The only thing that changed is who
  // *consumes* that registration: it used to be the JS rail on focus; now
  // it's pushed straight to the native rail via NavRail.registerRouteHandleTag
  // whenever the active route changes (see effect below), so the native
  // TVNavRailView can wire a real nextFocusRightId.
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

  // Each screen registers its own "did I consume this back press?" handler
  // here, same as before.
  const handleRegisterBackHandler = useCallback(
    (route: TVRoute) => (handler: (() => boolean) | null) => {
      if (handler) {
        screenBackHandlersRef.current[route] = handler;
      } else {
        delete screenBackHandlersRef.current[route];
      }
    },
    []
  );

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
        // A genuine tab switch is happening -- flag the tab being left so
        // its content resets to a fresh-launch focus state the next time
        // it's shown, instead of restoring wherever focus was left.
        routeFocusDirtyRef.current[prev] = true;
      }
      return route;
    });
  }, []);

  // Home's Continue Watching card calls this instead of the normal
  // onSelectItem when the entry's own stream was originally played from
  // Discover's page-2 results inspector (ContinueWatchingItem.discoverSource)
  // -- hands the item off to that screen (consumed once on its next mount,
  // see openDiscoverResultFor) and switches to the Discover tab, instead of
  // opening the regular details screen for it.
  const handleOpenDiscoverItem = useCallback(
    (discoverItem: any) => {
      if (!discoverItem) return;
      openDiscoverResultFor(discoverItem);
      navigateTo('discover');
    },
    [navigateTo]
  );

  // Keep the native rail's active-route highlight (and its nextFocusRightId
  // wiring for the currently-active row) in sync with JS route state, and
  // push whatever entry-focus target the active screen has registered.
  useEffect(() => {
    NavRail.setActiveRoute(currentRoute);
    const tag = entryHandleGetterRef.current[currentRoute]?.() ?? null;
    NavRail.registerRouteHandleTag(currentRoute, tag);
  }, [currentRoute]);

  // Native -> JS: rail selection changed / same tab re-selected / expand state.
  useEffect(() => {
    const subs = [
      NavRail.onRouteChanged((route) => navigateTo(route)),
      NavRail.onRouteReselected((route) => handleRequestContentFocus(route)),
      NavRail.onExpandedChanged((expanded) => {
        navExpandedRef.current = expanded;
      }),
    ];
    return () => subs.forEach((s) => s?.remove());
  }, [navigateTo, handleRequestContentFocus]);

  // Hide the native rail entirely behind fullscreen player/details, exactly
  // like the old JS conditionally unmounting <TVNavigationRail>.
  useEffect(() => {
    NavRail.setVisible(!activeStream && !selectedItem);
  }, [activeStream, selectedItem]);

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

      // Defensive fallback only -- see navExpandedRef doc above. Under
      // normal operation MainActivity's dispatchKeyEvent already exits the
      // app before this listener ever runs when the rail holds focus.
      if (navExpandedRef.current) {
        BackHandler.exitApp();
        return true;
      }

      // Let the current screen handle its own internal back-stack (closing a
      // modal, dropping from a results view to a browse view, etc.) first.
      const screenHandler = screenBackHandlersRef.current[currentRoute];
      if (screenHandler && screenHandler()) {
        return true;
      }

      // Otherwise, Back moves focus to that tab's rail button -- now a real
      // native View.requestFocus() under the hood.
      NavRail.focusRoute(currentRoute);
      return true;
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
                    skip={activeStream.skip}
                    startPosition={activeStream.startPosition}
                    discoverSource={activeStream.discoverSource}
                    onSelectNextEpisode={(nextEp) => {
                      // `targetIndex` is set explicitly when the person
                      // jumped to an arbitrary episode from the "Videos"
                      // list; falls back to a plain +1 advance otherwise.
                      const nextIndex =
                        nextEp.targetIndex ?? (activeStream.currentEpisodeIndex ?? 0) + 1;
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
                              skip: nextEp.skip,
                              servers: undefined,
                              startPosition: undefined,
                            }
                          : null
                      );
                    }}
                    onClose={() => {
                      setActiveStream(null);
                    }}
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
                          onOpenDiscoverItem={handleOpenDiscoverItem}
                          onRegisterBackHandler={handleRegisterBackHandler('home')}
                          onRegisterEntryHandleGetter={handleRegisterEntryHandleGetter('home')}
                          onRegisterReturnFocusTrigger={handleRegisterReturnFocusTrigger('home')}
                          resetFocusOnMount={consumeRouteFocusReset('home')}
                        />
                      )}

                      {currentRoute === 'search' && (
                        <TVSearch
                          onSelectItem={(item) => setSelectedItem(item)}
                          onRegisterBackHandler={handleRegisterBackHandler('search')}
                          onRegisterEntryHandleGetter={handleRegisterEntryHandleGetter('search')}
                          onRegisterReturnFocusTrigger={handleRegisterReturnFocusTrigger('search')}
                          resetFocusOnMount={consumeRouteFocusReset('search')}
                        />
                      )}

                      {currentRoute === 'discover' && (
                        <TVDiscoverScreen
                          onNavigateRoute={navigateTo}
                          onSelectItem={(item) => setSelectedItem(item)}
                          onPlayStream={(streamUrl, title, extraMeta) => {
                            setActiveStream({
                              url: streamUrl,
                              title: title || extraMeta?.itemLink || 'Unknown',
                              providerValue: extraMeta?.providerValue || currentProvider?.value,
                              ...extraMeta,
                            });
                          }}
                          onRegisterBackHandler={handleRegisterBackHandler('discover')}
                          onRegisterEntryHandleGetter={handleRegisterEntryHandleGetter('discover')}
                          onRegisterReturnFocusTrigger={handleRegisterReturnFocusTrigger('discover')}
                          resetFocusOnMount={consumeRouteFocusReset('discover')}
                        />
                      )}

                      {currentRoute === 'sources' && (
                        <TVSourceSelectScreen
                          onNavigateHome={() => navigateTo('home')}
                          onNavigateAddons={() => navigateTo('addons')}
                          onRegisterEntryHandleGetter={handleRegisterEntryHandleGetter('sources')}
                          onRegisterReturnFocusTrigger={handleRegisterReturnFocusTrigger('sources')}
                          resetFocusOnMount={consumeRouteFocusReset('sources')}
                        />
                      )}

                      {currentRoute === 'addons' && (
                        <Extensions
                          navigation={{
                            navigate: (screen: string) => navigateTo(screen.toLowerCase() as any),
                            goBack: () => navigateTo('home'),
                          } as any}
                          route={{} as any}
                          onRegisterBackHandler={handleRegisterBackHandler('addons')}
                          onRegisterEntryHandleGetter={handleRegisterEntryHandleGetter('addons')}
                          onRegisterReturnFocusTrigger={handleRegisterReturnFocusTrigger('addons')}
                          resetFocusOnMount={consumeRouteFocusReset('addons')}
                        />
                      )}

                      {currentRoute === 'settings' && (
                        <TVSettingsScreen
                          onRegisterEntryHandleGetter={handleRegisterEntryHandleGetter('settings')}
                          onRegisterReturnFocusTrigger={handleRegisterReturnFocusTrigger('settings')}
                          resetFocusOnMount={consumeRouteFocusReset('settings')}
                        />
                      )}
                    </View>
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
    // The native rail is no longer part of this RN tree at all -- it's a
    // real sibling View overlaid by MainActivity/NavRailManager above the
    // whole ReactRootView. This padding just keeps content from rendering
    // underneath that permanent 72dp-wide strip; it must stay equal to
    // TVNavRailView.COLLAPSED_WIDTH_DP (see NATIVE_RAIL_COLLAPSED_WIDTH).
    paddingLeft: NATIVE_RAIL_COLLAPSED_WIDTH,
  },
});
