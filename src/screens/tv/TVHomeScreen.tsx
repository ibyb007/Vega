import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Image,
  ActivityIndicator,
} from 'react-native';
import { TVHeroMeta, TVHeroMedia } from '../../components/tv/TVHeroMeta';
import { TVFocusablePressable } from '../../components/tv/TVFocusablePressable';
import { TVNoProviderFallback } from '../../components/tv/TVNoProviderFallback';
import useContentStore from '../../lib/zustand/contentStore';
import { useHomePageData, getRandomHeroPost } from '../../lib/hooks/useHomePageData';
import { TVRoute } from '../../components/tv/TVNavigationRail';

interface TVHomeScreenProps {
  onSelectItem: (item: any) => void;
  onNavigateRoute?: (route: TVRoute) => void;
}

export const TVHomeScreen: React.FC<TVHomeScreenProps> = ({
  onSelectItem,
  onNavigateRoute,
}) => {
  const provider = useContentStore((state) => state.provider);
  const installedProviders = useContentStore((state) => state.installedProviders);
  const [activeHero, setActiveHero] = useState<TVHeroMedia | null>(null);

  const hasProviders = Boolean(
    installedProviders && installedProviders.length > 0 && provider?.value
  );

  const { data: homeData = [], isLoading } = useHomePageData({
    provider,
    enabled: hasProviders,
  });

  useEffect(() => {
    if (homeData && homeData.length > 0) {
      const hero = getRandomHeroPost(homeData, provider?.value);
      if (hero) {
        setActiveHero({
          title: hero.title,
          backdropUrl: hero.image,
          posterUrl: hero.image,
          overview: hero.extra || 'Select title to browse stream links and episodes.',
          year: '2024',
        });
      }
    }
  }, [homeData, provider?.value]);

  if (!hasProviders) {
    return (
      <TVNoProviderFallback
        onInstallProviders={() => onNavigateRoute?.('addons')}
        onOpenSettings={() => onNavigateRoute?.('settings')}
      />
    );
  }

  if (isLoading && homeData.length === 0) {
    return (
      <View style={styles.centerLoading}>
        <ActivityIndicator size="large" color="#8A5CF6" />
        <Text style={styles.loadingText}>
          Loading {provider?.displayTitle || provider?.name} catalog...
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.verticalScrollContent}
      >
        <TVHeroMeta media={activeHero} />

        <View style={styles.rowsWrapper}>
          {homeData.map((row, rowIndex) => {
            const rowPosts = row.Posts || [];
            if (rowPosts.length === 0) return null;

            return (
              <View key={`${row.filter || row.title}-${rowIndex}`} style={styles.rowContainer}>
                <Text style={styles.rowCategoryTitle}>{row.title}</Text>

                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.horizontalRowScroll}
                >
                  {rowPosts.map((item, pIndex) => {
                    const isFirstInRow = pIndex === 0;

                    return (
                      <TVFocusablePressable
                        key={`${item.link}-${pIndex}`}
                        hasTVPreferredFocus={rowIndex === 0 && isFirstInRow}
                        scaleFocused={1.08}
                        focusedBorderColor="#8A5CF6"
                        borderRadius={10}
                        trapFocusLeft={!isFirstInRow} // Only allow focus to escape left on index 0
                        onFocus={() =>
                          setActiveHero({
                            title: item.title,
                            backdropUrl: item.image,
                            posterUrl: item.image,
                            overview: item.extra || 'Select title to browse stream links.',
                          })
                        }
                        onPress={() => onSelectItem(item)}
                        style={styles.card}
                      >
                        {({ focused }) => (
                          <View style={styles.cardInner}>
                            <Image
                              source={{
                                uri:
                                  item.image ||
                                  'https://placehold.jp/24/363636/ffffff/200x300.png?text=Vega',
                              }}
                              style={styles.cardPoster}
                              resizeMode="cover"
                            />
                            {focused && <View style={styles.focusBorderGlow} />}
                          </View>
                        )}
                      </TVFocusablePressable>
                    );
                  })}
                </ScrollView>
              </View>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0E',
  },
  centerLoading: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#0A0A0E',
  },
  loadingText: {
    color: '#9CA3AF',
    fontSize: 16,
    marginTop: 16,
  },
  verticalScrollContent: {
    paddingBottom: 60,
  },
  rowsWrapper: {
    paddingLeft: 24, // Clean, tight margin next to the rail
    marginTop: -8,
  },
  rowContainer: {
    marginBottom: 28,
  },
  rowCategoryTitle: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 12,
    letterSpacing: 0.3,
  },
  horizontalRowScroll: {
    paddingRight: 60,
    gap: 16,
    paddingVertical: 10,
  },
  card: {
    width: 155,
    height: 232,
    backgroundColor: '#16161E',
    borderRadius: 10,
  },
  cardInner: {
    flex: 1,
    borderRadius: 10,
    overflow: 'hidden',
    position: 'relative',
  },
  cardPoster: {
    width: '100%',
    height: '100%',
    borderRadius: 10,
  },
  focusBorderGlow: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 10,
    borderWidth: 2.5,
    borderColor: '#8A5CF6',
  },
});
