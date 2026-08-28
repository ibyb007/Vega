import React, { useState, useEffect } from 'react';
import './global.css';
import { View, StyleSheet, LogBox, StatusBar, Text } from 'react-native';
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
    // 1. Initialize Network & Provider Updates silently
    syncDohSettings().catch(e => console.warn('[DoH] Startup sync failed:', e));
    try {
      updateProvidersService.startAutomaticUpdateCheck();
    } catch (e) {
      console.warn('[UpdateProviders] Init failed:', e);
    }

    // 2. Hide Splash Screen safely after layout has attached
    const hideTimer = setTimeout(async () => {
      try {
        await BootSplash.hide({ fade: true });
      } catch (err) {
        console.warn('[BootSplash] Hide error:', err);
      }
    }, 500);

    return () => {
      clearTimeout(hideTimer);
      try {
        updateProvidersService.stopAutomaticUpdateCheck();
      } catch {}
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
                  /* Fullscreen TV Leanback Player */
                  <TVPlayerScreen
                    streamUrl={activeStream.url}
                    title={activeStream.title}
                    onClose={() => setActiveStream(null)}
                  />
                ) : (
                  /* Master TV Layout: Collapsible Rail + Active Viewport */
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

                      {currentRoute === 'addons' && (
                        <View style={styles.fallbackCenter}>
                          <Text style={styles.fallbackText}>Addons & Extensions Manager</Text>
                        </View>
                      )}

                      {currentRoute === 'settings' && <TVSettingsScreen />}
                    </View>
                  </View>
                )}

                {/* Scraper Isolation Sandbox Runtime */}
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
  fallbackCenter: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#0A0A0E',
  },
  fallbackText: {
    color: '#9CA3AF',
    fontSize: 16,
    fontWeight: '600',
  },
});
