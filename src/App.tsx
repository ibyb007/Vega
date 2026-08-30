import React, { useState, useEffect, useCallback } from 'react';
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

// TV Architecture Components & Screens
import { TVNavigationRail, TVRoute } from './components/tv/TVNavigationRail';
import { TVHomeScreen } from './screens/tv/TVHomeScreen';
import { TVSourceSelectScreen } from './screens/tv/TVSourceSelectScreen';
import { TVSettingsScreen } from './screens/tv/TVSettingsScreen';
import { TVPlayerScreen } from './screens/tv/TVPlayerScreen';
import TVSearch from './screens/Search';
import Extensions from './screens/settings/Extensions';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

export interface ActiveStreamPayload {
  url: string;
  title: string;
  tracks?: any[];
}

export default function App() {
  const [currentRoute, setCurrentRoute] = useState<TVRoute>('home');
  const [routeHistory, setRouteHistory] = useState<TVRoute[]>(['home']);
  const [activeStream, setActiveStream] = useState<ActiveStreamPayload | null>(null);

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
    setCurrentRoute((prev) => {
      if (prev !== route) {
        setRouteHistory((history) => [...history, route]);
      }
      return route;
    });
  }, []);

  // Back button handler for TV remote
  useEffect(() => {
    const handleBackPress = () => {
      if (activeStream) {
        setActiveStream(null);
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
  }, [activeStream, routeHistory, currentRoute]);

  return (
    <SafeAreaProvider style={styles.rootContainer}>
      <GestureHandlerRootView style={styles.rootContainer}>
        <M3ThemeProvider>
          <GlobalErrorBoundary>
            <QueryClientProvider client={queryClient}>
              <View style={styles.rootContainer}>
                <StatusBar hidden={true} />
                <AppDialogHost />

                {activeStream ? (
                  <TVPlayerScreen
                    streamUrl={activeStream.url}
                    title={activeStream.title}
                    onClose={() => setActiveStream(null)}
                  />
                ) : (
                  <View style={styles.layout}>
                    <TVNavigationRail
                      currentRoute={currentRoute}
                      onRouteChange={navigateTo}
                    />

                    <View style={styles.viewport}>
                      {currentRoute === 'home' && (
                        <TVHomeScreen
                          onNavigateRoute={navigateTo}
                          onSelectItem={(item) =>
                            setActiveStream({
                              url:
                                item.streamUrl ||
                                item.link ||
                                'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
                              title: item.title,
                            })
                          }
                        />
                      )}

                      {currentRoute === 'search' && (
                        <TVSearch
                          onSelectItem={(item) =>
                            setActiveStream({
                              url: item.streamUrl || item.link,
                              title: item.title,
                            })
                          }
                        />
                      )}

                      {currentRoute === 'discover' && (
                        <TVHomeScreen
                          onNavigateRoute={navigateTo}
                          onSelectItem={(item) =>
                            setActiveStream({
                              url: item.streamUrl || item.link,
                              title: item.title,
                            })
                          }
                        />
                      )}

                      {currentRoute === 'sources' && (
                        <TVSourceSelectScreen
                          onNavigateHome={() => navigateTo('home')}
                          onNavigateAddons={() => navigateTo('addons')}
                        />
                      )}

                      {currentRoute === 'addons' && (
                        <Extensions
                          navigation={{
                            navigate: (screen: string) => navigateTo(screen.toLowerCase() as any),
                            goBack: () => navigateTo('home'),
                          } as any}
                          route={{} as any}
                        />
                      )}

                      {currentRoute === 'settings' && <TVSettingsScreen />}
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
    flexDirection: 'row',
    width: '100%',
    height: '100%',
  },
  viewport: {
    flex: 1,
    height: '100%',
    backgroundColor: '#0A0A0E',
  },
});
