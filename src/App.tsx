import React, { useState, useEffect } from 'react';
import { View, StyleSheet, StatusBar, Dimensions } from 'react-native';
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

// TV Architecture Components & Screens
import { TVNavigationRail, TVRoute } from './components/tv/TVNavigationRail';
import { TVHomeScreen } from './screens/tv/TVHomeScreen';
import { TVInfoScreen, TVInfoItem } from './screens/tv/TVInfoScreen';
import { TVSourceSelectScreen } from './screens/tv/TVSourceSelectScreen';
import { TVSettingsScreen } from './screens/tv/TVSettingsScreen';
import { TVPlayerScreen } from './screens/tv/TVPlayerScreen';
import TVSearch from './screens/Search';
import Extensions from './screens/settings/Extensions';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

export interface ActiveStreamPayload {
  url: string;
  title: string;
  headers?: Record<string, string>;
}

export default function App() {
  const [currentRoute, setCurrentRoute] = useState<TVRoute>('home');
  const [selectedItem, setSelectedItem] = useState<TVInfoItem | null>(null);
  const [activeStream, setActiveStream] = useState<ActiveStreamPayload | null>(null);
  const currentProvider = useContentStore(state => state.provider);

  useEffect(() => {
    // 1. Hide native bootsplash immediately
    BootSplash.hide({ fade: false }).catch(() => {});

    // 2. Initialize background network & provider tasks safely
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
                  /* Fullscreen TV Player */
                  <TVPlayerScreen
                    streamUrl={activeStream.url}
                    title={activeStream.title}
                    headers={activeStream.headers}
                    onClose={() => setActiveStream(null)}
                  />
                ) : selectedItem ? (
                  /* Fullscreen Info screen: seasons/episodes/quality picker,
                     shown before playback (mirrors the mobile app's Info screen). */
                  <TVInfoScreen
                    item={selectedItem}
                    providerValue={selectedItem.provider || currentProvider?.value}
                    onBack={() => setSelectedItem(null)}
                    onPlay={(payload) => {
                      setActiveStream(payload);
                      setSelectedItem(null);
                    }}
                  />
                ) : (
                  /* Master TV Layout: Collapsible Rail + Viewport */
                  <View style={styles.layout}>
                    <TVNavigationRail
                      currentRoute={currentRoute}
                      onRouteChange={(route) => setCurrentRoute(route)}
                    />

                    <View style={styles.viewport}>
                      {currentRoute === 'home' && (
                        <TVHomeScreen
                          onNavigateRoute={(route) => setCurrentRoute(route)}
                          onSelectItem={(item) => setSelectedItem(item)}
                        />
                      )}

                      {currentRoute === 'search' && (
                        <TVSearch onSelectItem={(item) => setSelectedItem(item)} />
                      )}

                      {currentRoute === 'discover' && (
                        <TVHomeScreen
                          onNavigateRoute={(route) => setCurrentRoute(route)}
                          onSelectItem={(item) => setSelectedItem(item)}
                        />
                      )}

                      {currentRoute === 'sources' && (
                        <TVSourceSelectScreen
                          onNavigateHome={() => setCurrentRoute('home')}
                          onNavigateAddons={() => setCurrentRoute('addons')}
                        />
                      )}

                      {currentRoute === 'addons' && (
                        <Extensions
                          navigation={{
                            navigate: (screen: string) => setCurrentRoute(screen.toLowerCase() as any),
                            goBack: () => setCurrentRoute('home'),
                          } as any}
                          route={{} as any}
                        />
                      )}

                      {currentRoute === 'settings' && <TVSettingsScreen />}
                    </View>
                  </View>
                )}

                {/* Scraper Isolation Sandbox */}
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
