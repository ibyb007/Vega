import React, { useState, useEffect } from 'react';
import './global.css';
import { View, StyleSheet, LogBox, StatusBar } from 'react-native';
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
import { TVSettingsScreen } from './screens/tv/TVSettingsScreen';
import { TVPlayerScreen } from './screens/tv/TVPlayerScreen';
import TVSearch from './screens/Search';
import WatchList from './screens/WatchList';
import Extensions from './screens/settings/Extensions';

LogBox.ignoreLogs([
  'new NativeEventEmitter()',
  'Setting a timer for a long period of time',
  'You have passed a style to FlashList',
]);

export interface ActiveStreamPayload {
  url: string;
  title: string;
}

export default function App() {
  const [currentRoute, setCurrentRoute] = useState<TVRoute>('home');
  const [activeStream, setActiveStream] = useState<ActiveStreamPayload | null>(null);

  useEffect(() => {
    let isMounted = true;

    const hideSplash = async () => {
      try {
        await BootSplash.hide({ fade: true });
      } catch (e) {
        console.warn('[BootSplash] Dismissal error:', e);
      }
    };

    hideSplash();

    const timer = setTimeout(() => {
      if (isMounted) {
        hideSplash();
      }
    }, 400);

    syncDohSettings().catch((e) =>
      console.warn('[DoH] Startup sync failed:', e)
    );

    updateProvidersService.startAutomaticUpdateCheck();

    return () => {
      isMounted = false;
      clearTimeout(timer);
      updateProvidersService.stopAutomaticUpdateCheck();
    };
  }, []);

  return (
    <SafeAreaProvider>
      <GestureHandlerRootView style={styles.root}>
        <M3ThemeProvider>
          <GlobalErrorBoundary>
            <QueryClientProvider client={queryClient}>
              <View style={styles.root}>
                <StatusBar hidden={true} />
                <AppDialogHost />

                {activeStream ? (
                  /* Fullscreen TV Player */
                  <TVPlayerScreen
                    streamUrl={activeStream.url}
                    title={activeStream.title}
                    onClose={() => setActiveStream(null)}
                  />
                ) : (
                  /* Master TV Layout: Collapsible Rail + Dynamic Viewport */
                  <View style={styles.layout}>
                    <TVNavigationRail
                      currentRoute={currentRoute}
                      onRouteChange={(route) => setCurrentRoute(route)}
                    />

                    <View style={styles.viewport}>
                      {currentRoute === 'home' && (
                        <TVHomeScreen
                          onSelectItem={(item) =>
                            setActiveStream({
                              url:
                                item.streamUrl ||
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
                              url:
                                item.streamUrl ||
                                'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
                              title: item.title,
                            })
                          }
                        />
                      )}

                      {currentRoute === 'discover' && (
                        <TVHomeScreen
                          onSelectItem={(item) =>
                            setActiveStream({
                              url:
                                item.streamUrl ||
                                'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
                              title: item.title,
                            })
                          }
                        />
                      )}

                      {currentRoute === 'library' && <WatchList />}

                      {currentRoute === 'addons' && <Extensions navigation={{} as any} route={{} as any} />}

                      {currentRoute === 'settings' && <TVSettingsScreen />}
                    </View>
                  </View>
                )}

                {/* Vega Sandbox Runtime */}
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
  root: {
    flex: 1,
    backgroundColor: '#0A0A0E',
  },
  layout: {
    flex: 1,
    flexDirection: 'row',
  },
  viewport: {
    flex: 1,
    backgroundColor: '#0A0A0E',
  },
});
