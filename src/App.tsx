import React, { useState, useEffect } from 'react';
import './global.css';
import { View, StyleSheet, LogBox, StatusBar } from 'react-native';
import BootSplash from 'react-native-bootsplash';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './lib/client';
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
import Search from './screens/Search';
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

    // Fail-safe immediate native splash screen dismissal
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
    }, 800);

    // Initialize 1.1.1.1 Cloudflare DNS-over-HTTPS
    syncDohSettings().catch((e) =>
      console.warn('[DoH] Startup sync failed:', e)
    );

    // Initialize scraper provider auto-updater
    updateProvidersService.startAutomaticUpdateCheck();

    return () => {
      isMounted = false;
      clearTimeout(timer);
      updateProvidersService.stopAutomaticUpdateCheck();
    };
  }, []);

  return (
    <GlobalErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <View style={styles.root}>
          <StatusBar hidden={true} />
          <AppDialogHost />

          {activeStream ? (
            /* Leanback Video Player with D-pad OSD & External Intent Pass-through */
            <TVPlayerScreen
              streamUrl={activeStream.url}
              title={activeStream.title}
              onClose={() => setActiveStream(null)}
            />
          ) : (
            /* Master TV Layout: Collapsible Navigation Rail + Active Viewport */
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

                {currentRoute === 'search' && <Search />}

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

                {currentRoute === 'addons' && <Extensions />}

                {currentRoute === 'settings' && <TVSettingsScreen />}
              </View>
            </View>
          )}

          {/* Vega Captcha Resolver & Isolated Scraper Sandbox Engine */}
          <WafWebViewDialog />
          <ProviderSandboxHost />
        </View>
      </QueryClientProvider>
    </GlobalErrorBoundary>
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
