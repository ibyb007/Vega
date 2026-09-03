import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Image,
  ActivityIndicator,
  Dimensions,
} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import { TVHeroMeta, TVHeroMedia } from '../../components/tv/TVHeroMeta';
import { TVFocusablePressable } from '../../components/tv/TVFocusablePressable';
import { TVNoProviderFallback } from '../../components/tv/TVNoProviderFallback';
import useContentStore from '../../lib/zustand/contentStore';
import useWatchHistoryStore from '../../lib/zustand/watchHistoryStore';
import { useHomePageData } from '../../lib/hooks/useHomePageData';
import { TVRoute } from '../../components/tv/TVNavigationRail';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');
const ROW_HEIGHT = 280;

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
  const watchHistory = useWatchHistoryStore((state) => state.watchHistory) || [];

  const [activeHero, setActiveHero] = useState<TVHeroMedia | null>(null);
  const [activeRowIndex, setActiveRowIndex] = useState<number>(0);
  const translateY = useSharedValue(0);

  const hasProviders = Boolean(
    installedProviders && installedProviders.length > 0 && provider?.value
  );

  const { data: homeData = [], isLoading } = useHomePageData({
    provider,
    enabled: hasProviders,
  });

  // Combine rows: Continue Watching (if present) followed by catalog sections
  const displayRows = useMemo(() => {
    const rows = [];
    if (watchHistory.length > 0) {
      rows.push({
        title: 'Continue Watching',
        filter: 'continue-watching',
        Posts: watchHistory,
        isHistory: true,
      });
    }
    return rows.concat(homeData.filter((r) => r.Posts && r.Posts.length > 0));
  }, [watchHistory, homeData]);

  // Set initial hero from the first item of the top row immediately
  useEffect(() => {
    if (!activeHero && displayRows.length > 0) {
      const firstRow = displayRows[0];
      if (firstRow?.Posts?.length > 0) {
        const item = firstRow.Posts[0];
        setActiveHero({
          title: item.title,
          backdropUrl: item.backdrop || item.banner || item.image,
          posterUrl: item.image,
          overview: item.extra || item.description || 'Press Select to view streams & episodes.',
          year: item.year || '2024',
          rating: item.rating || '8.2',
          runtime: item.runtime || '114 min',
          genres: item.genres || ['Action', 'Drama'],
        });
      }
    }
  }, [displayRows, activeHero]);

  // Translate rows container up smoothly when moving D-pad Down
  const handleCardFocus = useCallback(
    (rowIndex: number, item: any) => {
      setActiveRowIndex(rowIndex);
      translateY.value = withTiming(-rowIndex * ROW_HEIGHT, {
        duration: 200,
        easing: Easing.out(Easing.quad),
      });

      // Update Hero backdrop & text immediately without debounce lag
      setActiveHero({
        title: item.title,
        backdropUrl: item.backdrop || item.banner || item.image,
        posterUrl: item.image,
        overview: item.extra || item.description || 'Press Select to view streams & episodes.',
        year: item.year || '2024',
        rating: item.rating || '8.2',
        runtime: item.runtime || '114 min',
        genres: item.genres || ['Action', 'Drama', 'Thriller'],
      });
    },
    [translateY]
  );

  const animatedRowsStyle = useAnimatedStyle(() => {
    return {
      transform: [{ translateY: translateY.value }],
    };
  });

  if (!hasProviders) {
    return (
      <TVNoProviderFallback
        onInstallProviders={() => onNavigateRoute?.('addons')}
        onOpenSettings={() => onNavigateRoute?.('settings')}
      />
    );
  }

  if (isLoading && displayRows.length === 0) {
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
      {/* 1. FIXED TOP HERO: Never scrolls or gets pushed off screen */}
      <View style={styles.fixedHeroContainer}>
        <TVHeroMeta media={activeHero} />
      </View>

      {/* 2. SLIDING ROWS STAGE: Rows slide upwards underneath the Hero */}
      <View style={styles.stageViewport}>
        <Animated.View style={[styles.slidingRowsContainer, animatedRowsStyle]}>
          {displayRows.map((row: any, rowIndex: number) => {
            const rowPosts = row.Posts || [];
            if (rowPosts.length === 0) return null;

            return (
              <View
                key={`${row.filter || row.title}-${rowIndex}`}
                style={[
                  styles.rowContainer,
                  // Fade out previous rows that moved above the active row
                  rowIndex < activeRowIndex && styles.rowHiddenAbove,
                ]}
              >
                <Text style={styles.rowCategoryTitle}>{row.title}</Text>

                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.horizontalRowScroll}
                  removeClippedSubviews={false}
                >
                  {rowPosts.map((item: any, pIndex: number) => {
                    const isPreferred = rowIndex === 0 && pIndex === 0;

                    return (
                      <TVFocusablePressable
                        key={`${item.link || item.id}-${pIndex}`}
                        hasTVPreferredFocus={isPreferred}
                        scaleFocused={1.08}
                        focusedBorderColor="#FFFFFF"
                        borderRadius={10}
                        onFocus={() => handleCardFocus(rowIndex, item)}
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
                            {/* Stremio-Style White Focus Border */}
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
        </Animated.View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0E',
    overflow: 'hidden',
  },
  fixedHeroContainer: {
    height: 330,
    width: '100%',
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 1,
  },
  stageViewport: {
    position: 'absolute',
    top: 330,
    bottom: 0,
    left: 0,
    right: 0,
    overflow: 'hidden',
    zIndex: 2,
  },
  slidingRowsContainer: {
    paddingLeft: 96,
    paddingTop: 10,
  },
  rowContainer: {
    height: ROW_HEIGHT,
    marginBottom: 0,
  },
  rowHiddenAbove: {
    opacity: 0,
  },
  rowCategoryTitle: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '800',
    marginBottom: 10,
    letterSpacing: 0.2,
  },
  horizontalRowScroll: {
    paddingRight: 60,
    gap: 16,
    paddingVertical: 6,
  },
  card: {
    width: 150,
    height: 220,
    backgroundColor: '#16161E',
    borderRadius: 10,
  },
  cardInner: {
    flex: 1,
    borderRadius: 10,
    overflow: 'hidden',
  },
  cardPoster: {
    width: '100%',
    height: '100%',
    borderRadius: 10,
  },
  focusBorderGlow: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 10,
    borderWidth: 3,
    borderColor: '#FFFFFF',
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
});
