import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
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
import useContinueWatchingStore from '../../lib/zustand/continueWatchingStore';
import { useHomePageData, getRandomHeroPost } from '../../lib/hooks/useHomePageData';
import { prefetchMetadata } from '../../lib/services/metadataCache';
import { TVRoute } from '../../components/tv/TVNavigationRail';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
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
  const continueWatchingItems = useContinueWatchingStore((state) => state.items) || [];

  const [activeHero, setActiveHero] = useState<TVHeroMedia | null>(null);
  const [activeRowIndex, setActiveRowIndex] = useState<number>(0);
  const translateY = useSharedValue(0);
  const initialFocusSetRef = useRef(false);

  const hasProviders = Boolean(
    installedProviders && installedProviders.length > 0 && provider?.value
  );

  const { data: homeData = [], isLoading } = useHomePageData({
    provider,
    enabled: hasProviders,
  });

  // Sort and filter Continue Watching row items
  const watchHistory = useMemo(() => {
    return [...continueWatchingItems]
      .filter((item) => Boolean(item.providerValue || item.infoUrl))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }, [continueWatchingItems]);

  // Combine rows: Continue Watching (if present) followed by catalog rows
  const displayRows = useMemo(() => {
    const rows: any[] = [];
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

  // Set initial hero details from the top row's first poster or random hero
  useEffect(() => {
    if (!activeHero && displayRows.length > 0) {
      const firstRow = displayRows[0];
      if (firstRow?.Posts?.length > 0) {
        const item = firstRow.Posts[0];
        const posterImage = item.poster || item.background || item.image;
        setActiveHero({
          title: item.title,
          backdropUrl: item.backdrop || item.banner || posterImage,
          posterUrl: posterImage,
          overview: item.extra || item.description || 'Select title to browse stream links and episodes.',
          year: item.year || '2024',
          rating: item.rating || '8.2',
          runtime: item.runtime || '114 min',
          genres: item.genres || ['Action', 'Drama'],
        });
      }
    }
  }, [displayRows, activeHero]);

  // Translate row container upward when navigating down (Stremio style)
  const handleCardFocus = useCallback(
    (rowIndex: number, item: any, isHistory: boolean = false) => {
      initialFocusSetRef.current = true;
      setActiveRowIndex(rowIndex);
      translateY.value = withTiming(-rowIndex * ROW_HEIGHT, {
        duration: 220,
        easing: Easing.out(Easing.quad),
      });

      const posterImage = item.poster || item.background || item.image;
      const progressPercent =
        item.duration && item.position
          ? Math.min(100, Math.round((item.position / item.duration) * 100))
          : 0;
      const episodeTitle =
        item.episodeTitle ||
        (item.episode?.title && item.episode.title !== item.title
          ? item.episode.title
          : undefined);

      setActiveHero({
        title: item.title,
        backdropUrl: item.backdrop || item.banner || posterImage,
        posterUrl: posterImage,
        overview: isHistory
          ? episodeTitle
            ? `${episodeTitle} • Resume (${progressPercent}%)`
            : `Resume watching (${progressPercent}%)`
          : item.extra || item.description || 'Select title to browse stream links.',
        year: item.year || '2024',
        rating: item.rating || '8.2',
        runtime: item.runtime || '114 min',
        genres: item.genres || ['Action', 'Drama', 'Thriller'],
      });

      // Prefetch metadata in background
      const targetUrl = item.infoUrl || item.link;
      const targetProvider = item.providerValue || item.provider || provider?.value;
      if (targetUrl && targetProvider) {
        prefetchMetadata(targetUrl, targetProvider);
      }
    },
    [translateY, provider?.value]
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
      {/* 1. FIXED TOP HERO: Stays stationary at the top */}
      <View style={styles.fixedHeroContainer}>
        <TVHeroMeta media={activeHero} />
      </View>

      {/* 2. SLIDING ROWS STAGE: Shifts upward under the header */}
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
                    const isPreferred =
                      !initialFocusSetRef.current && rowIndex === 0 && pIndex === 0;
                    const posterImage = item.poster || item.background || item.image;
                    const progressPercent =
                      item.duration && item.position
                        ? Math.min(100, Math.round((item.position / item.duration) * 100))
                        : 0;

                    return (
                      <TVFocusablePressable
                        key={`${item.infoUrl || item.link || item.id}-${pIndex}`}
                        hasTVPreferredFocus={isPreferred}
                        scaleFocused={1.08}
                        focusedBorderColor="#FFFFFF"
                        borderRadius={10}
                        onFocus={() => handleCardFocus(rowIndex, item, Boolean(row.isHistory))}
                        onPress={() => {
                          if (row.isHistory) {
                            onSelectItem({
                              link: item.infoUrl || item.link,
                              provider: item.providerValue || item.provider,
                              image: posterImage,
                              title: item.title,
                            });
                          } else {
                            onSelectItem(item);
                          }
                        }}
                        style={styles.card}
                      >
                        {({ focused }) => (
                          <View style={styles.cardInner}>
                            <Image
                              source={{
                                uri:
                                  posterImage ||
                                  'https://placehold.jp/24/363636/ffffff/200x300.png?text=Vega',
                              }}
                              style={styles.cardPoster}
                              resizeMode="cover"
                            />

                            {/* Continue Watching Progress Fill */}
                            {row.isHistory && progressPercent > 0 && (
                              <View style={styles.progressBarTrack}>
                                <View
                                  style={[
                                    styles.progressBarFill,
                                    { width: `${progressPercent}%` },
                                  ]}
                                />
                              </View>
                            )}

                            {/* Focused Glow Border */}
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
    position: 'relative',
  },
  cardPoster: {
    width: '100%',
    height: '100%',
    borderRadius: 10,
  },
  progressBarTrack: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 4,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#8A5CF6',
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
