import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Image,
  ActivityIndicator,
  Modal,
  ToastAndroid,
} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { TVHeroMeta, TVHeroMedia } from '../../components/tv/TVHeroMeta';
import { TVFocusablePressable } from '../../components/tv/TVFocusablePressable';
import { TVNoProviderFallback } from '../../components/tv/TVNoProviderFallback';
import useContentStore from '../../lib/zustand/contentStore';
import useContinueWatchingStore from '../../lib/zustand/continueWatchingStore';
import { useHomePageData } from '../../lib/hooks/useHomePageData';
import { getMetadata, prefetchMetadata } from '../../lib/services/metadataCache';
import { TVRoute } from '../../components/tv/TVNavigationRail';

const ROW_HEIGHT = 250;
const cinemetaMemoryCache = new Map<string, any>();

const sanitizeQueryTitle = (raw: string): string => {
  return raw
    .replace(/\(.*?\)/g, '')
    .replace(/\[.*?\]/g, '')
    .replace(/season\s*\d+/gi, '')
    .replace(/s\d+/gi, '')
    .replace(/-+/g, ' ')
    .trim();
};

const fetchCinemetaMeta = async (title: string): Promise<any | null> => {
  const clean = sanitizeQueryTitle(title);
  if (!clean) return null;

  if (cinemetaMemoryCache.has(clean.toLowerCase())) {
    return cinemetaMemoryCache.get(clean.toLowerCase());
  }

  try {
    const encoded = encodeURIComponent(clean);
    const movieRes = await fetch(`https://v3-cinemeta.strem.io/catalog/movie/top/search=${encoded}.json`);
    const movieData = await movieRes.json();
    if (movieData?.metas && movieData.metas.length > 0) {
      const match = movieData.metas[0];
      cinemetaMemoryCache.set(clean.toLowerCase(), match);
      return match;
    }

    const seriesRes = await fetch(`https://v3-cinemeta.strem.io/catalog/series/top/search=${encoded}.json`);
    const seriesData = await seriesRes.json();
    if (seriesData?.metas && seriesData.metas.length > 0) {
      const match = seriesData.metas[0];
      cinemetaMemoryCache.set(clean.toLowerCase(), match);
      return match;
    }
  } catch {}

  return null;
};

interface TVHomeScreenProps {
  onSelectItem: (item: any) => void;
  onNavigateRoute?: (route: TVRoute) => void;
  homeFocusTarget?: number | null;
}

export const TVHomeScreen: React.FC<TVHomeScreenProps> = ({
  onSelectItem,
  onNavigateRoute,
  homeFocusTarget,
}) => {
  const provider = useContentStore((state) => state.provider);
  const installedProviders = useContentStore((state) => state.installedProviders);
  const continueWatchingItems = useContinueWatchingStore((state) => state.items) || [];
  const removeItemFromHistory = useContinueWatchingStore((state) => state.removeItem);

  const [activeHero, setActiveHero] = useState<TVHeroMedia | null>(null);
  const [activeRowIndex, setActiveRowIndex] = useState<number>(0);
  const [itemToDelete, setItemToDelete] = useState<any | null>(null);

  const translateY = useSharedValue(0);
  const initialFocusSetRef = useRef(false);

  const hasProviders = Boolean(
    installedProviders && installedProviders.length > 0 && provider?.value
  );

  const { data: homeData = [], isLoading } = useHomePageData({
    provider,
    enabled: hasProviders,
  });

  const watchHistory = useMemo(() => {
    return [...continueWatchingItems]
      .filter((item) => Boolean(item.providerValue || item.infoUrl))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }, [continueWatchingItems]);

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

  const updateHeroWithBestMetadata = useCallback(
    async (item: any, isHistory: boolean = false) => {
      const posterImage = item.poster || item.background || item.image;
      const targetUrl = item.infoUrl || item.link;
      const targetProvider = item.providerValue || item.provider || provider?.value;

      let backdrop = item.backdrop || item.banner || null;
      let hasLandscape = Boolean(backdrop);
      let description = item.extra || item.description || '';
      let rating = item.rating || null;
      let year = item.year || null;
      let genres = item.genres || [];

      if (targetUrl && targetProvider) {
        try {
          const cached = await getMetadata(targetUrl, targetProvider);
          if (cached) {
            if (cached.background || cached.backdrop) {
              backdrop = cached.background || cached.backdrop;
              hasLandscape = true;
            }
            if (cached.description) description = cached.description;
            if (cached.rating) rating = String(cached.rating);
            if (cached.year) year = String(cached.year);
            if (cached.genres?.length) genres = cached.genres;
          }
        } catch {}
      }

      if (!backdrop && item.title) {
        try {
          const cineMeta = await fetchCinemetaMeta(item.title);
          if (cineMeta) {
            if (cineMeta.background) {
              backdrop = cineMeta.background;
              hasLandscape = true;
            }
            if (!description && cineMeta.description) description = cineMeta.description;
            if (!rating && (cineMeta.imdbRating || cineMeta.rating)) {
              rating = String(cineMeta.imdbRating || cineMeta.rating);
            }
            if (!year && (cineMeta.releaseInfo || cineMeta.year)) {
              year = String(cineMeta.releaseInfo || cineMeta.year);
            }
            if (genres.length === 0 && cineMeta.genres?.length) {
              genres = cineMeta.genres;
            }
          }
        } catch {}
      }

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
        backdropUrl: backdrop || undefined,
        posterUrl: posterImage,
        hasLandscapeBackdrop: hasLandscape,
        overview: isHistory
          ? episodeTitle
            ? `${episodeTitle} • Resume (${progressPercent}%)`
            : `Resume watching (${progressPercent}%)`
          : description || 'Select title to browse stream links and episodes.',
        year: year || '2024',
        rating: rating || '8.2',
        runtime: item.runtime || '114 min',
        genres: genres.length > 0 ? genres : ['Movie'],
      });
    },
    [provider?.value]
  );

  useEffect(() => {
    if (!activeHero && displayRows.length > 0) {
      const firstRow = displayRows[0];
      if (firstRow?.Posts?.length > 0) {
        updateHeroWithBestMetadata(firstRow.Posts[0], Boolean(firstRow.isHistory));
      }
    }
  }, [displayRows, activeHero, updateHeroWithBestMetadata]);

  const handleCardFocus = useCallback(
    (rowIndex: number, item: any, isHistory: boolean = false) => {
      initialFocusSetRef.current = true;
      setActiveRowIndex(rowIndex);

      translateY.value = withTiming(-rowIndex * ROW_HEIGHT, {
        duration: 220,
        easing: Easing.out(Easing.quad),
      });

      updateHeroWithBestMetadata(item, isHistory);

      const targetUrl = item.infoUrl || item.link;
      const targetProvider = item.providerValue || item.provider || provider?.value;
      if (targetUrl && targetProvider) {
        prefetchMetadata(targetUrl, targetProvider);
      }
    },
    [translateY, updateHeroWithBestMetadata, provider?.value]
  );

  const confirmDeleteFromHistory = () => {
    if (!itemToDelete) return;
    const identifier = itemToDelete.id || itemToDelete.infoUrl || itemToDelete.link;
    if (identifier) {
      removeItemFromHistory(identifier);
      ToastAndroid.show('Removed from Continue Watching', ToastAndroid.SHORT);
    }
    setItemToDelete(null);
  };

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
      <View style={styles.fixedHeroContainer}>
        <TVHeroMeta media={activeHero} />
      </View>

      <View style={styles.stageViewport}>
        <Animated.View style={[styles.slidingRowsContainer, animatedRowsStyle]}>
          {displayRows.map((row: any, rowIndex: number) => {
            const rowPosts = row.Posts || [];
            if (rowPosts.length === 0) return null;
            const isHistoryRow = Boolean(row.isHistory);

            return (
              <View key={`${row.filter || row.title}-${rowIndex}`} style={styles.rowContainer}>
                <Text style={styles.rowCategoryTitle}>{row.title}</Text>

                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.horizontalRowScroll}
                  removeClippedSubviews={false}
                >
                  {rowPosts.map((item: any, pIndex: number) => {
                    const isFirstInRow = pIndex === 0;
                    const isPreferred =
                      !initialFocusSetRef.current && rowIndex === 0 && isFirstInRow;
                    const posterImage = item.poster || item.background || item.image;
                    const progressPercent =
                      item.duration && item.position
                        ? Math.min(100, Math.round((item.position / item.duration) * 100))
                        : 0;

                    return (
                      <TVFocusablePressable
                        key={`${item.infoUrl || item.link || item.id}-${pIndex}`}
                        hasTVPreferredFocus={isPreferred}
                        scaleFocused={1.06}
                        focusedBorderColor="#FFFFFF"
                        borderRadius={8}
                        // Leftmost poster explicitly delegates D-pad Left to the Home rail item
                        {...(isFirstInRow && homeFocusTarget
                          ? { nextFocusLeft: homeFocusTarget }
                          : { trapFocusLeft: !isFirstInRow })}
                        onFocus={() => handleCardFocus(rowIndex, item, isHistoryRow)}
                        onPress={() => {
                          if (isHistoryRow) {
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
                        onLongPress={() => {
                          if (isHistoryRow) {
                            setItemToDelete(item);
                          }
                        }}
                        style={[
                          styles.card,
                          isHistoryRow && styles.cardCompact,
                        ]}
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

                            {/* Continue Watching Progress Overlay & Percent Tag */}
                            {isHistoryRow && progressPercent > 0 && (
                              <View style={styles.historyMetaOverlay}>
                                <Text style={styles.historyPercentText}>{progressPercent}%</Text>
                                <View style={styles.progressBarTrack}>
                                  <View
                                    style={[
                                      styles.progressBarFill,
                                      { width: `${progressPercent}%` },
                                    ]}
                                  />
                                </View>
                              </View>
                            )}

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

      <Modal
        visible={Boolean(itemToDelete)}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setItemToDelete(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <MaterialCommunityIcons name="movie-remove-outline" size={38} color="#EF4444" />
            <Text style={styles.modalTitle}>Remove From History?</Text>
            <Text numberOfLines={2} style={styles.modalSubtitle}>
              {itemToDelete?.title}
            </Text>
            <Text style={styles.modalDescription}>
              This will remove the title and its resume progress from your Continue Watching row.
            </Text>

            <View style={styles.modalActions}>
              <TVFocusablePressable
                hasTVPreferredFocus={true}
                scaleFocused={1.05}
                focusedBorderColor="#8A5CF6"
                borderRadius={8}
                onPress={() => setItemToDelete(null)}
                style={styles.cancelBtn}
              >
                {() => <Text style={styles.cancelBtnText}>Cancel</Text>}
              </TVFocusablePressable>

              <TVFocusablePressable
                scaleFocused={1.05}
                focusedBorderColor="#FFFFFF"
                borderRadius={8}
                onPress={confirmDeleteFromHistory}
                style={styles.removeBtn}
              >
                {() => <Text style={styles.removeBtnText}>Remove</Text>}
              </TVFocusablePressable>
            </View>
          </View>
        </View>
      </Modal>
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
    height: 260,
    width: '100%',
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 1,
  },
  stageViewport: {
    position: 'absolute',
    top: 260,
    bottom: 0,
    left: 0,
    right: 0,
    overflow: 'hidden',
    zIndex: 2,
  },
  slidingRowsContainer: {
    paddingLeft: 88,
    paddingTop: 4,
  },
  rowContainer: {
    height: ROW_HEIGHT,
  },
  rowCategoryTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '800',
    marginBottom: 8,
    letterSpacing: 0.2,
  },
  horizontalRowScroll: {
    paddingRight: 60,
    gap: 14,
    paddingVertical: 4,
  },
  card: {
    width: 135,
    height: 195,
    backgroundColor: '#16161E',
    borderRadius: 8,
  },
  cardCompact: {
    width: 130,
    height: 185,
  },
  cardInner: {
    flex: 1,
    borderRadius: 8,
    overflow: 'hidden',
    position: 'relative',
  },
  cardPoster: {
    width: '100%',
    height: '100%',
    borderRadius: 8,
  },
  historyMetaOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(5, 5, 8, 0.85)',
    paddingHorizontal: 6,
    paddingTop: 4,
    paddingBottom: 4,
  },
  historyPercentText: {
    color: '#D1D5DB',
    fontSize: 11,
    fontWeight: '700',
    marginBottom: 2,
  },
  progressBarTrack: {
    width: '100%',
    height: 3,
    backgroundColor: 'rgba(255, 255, 255, 0.25)',
    borderRadius: 1.5,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#8A5CF6',
  },
  focusBorderGlow: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 8,
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
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalBox: {
    width: 440,
    backgroundColor: '#16161E',
    borderRadius: 14,
    padding: 22,
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  modalTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '800',
    marginTop: 10,
    marginBottom: 4,
  },
  modalSubtitle: {
    color: '#D1D5DB',
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 6,
  },
  modalDescription: {
    color: '#9CA3AF',
    fontSize: 12,
    textAlign: 'center',
    lineHeight: 18,
    marginBottom: 20,
  },
  modalActions: {
    flexDirection: 'row',
    gap: 14,
    width: '100%',
    justifyContent: 'center',
  },
  cancelBtn: {
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    paddingVertical: 10,
    paddingHorizontal: 22,
  },
  cancelBtnText: {
    color: '#D1D5DB',
    fontSize: 13,
    fontWeight: '600',
  },
  removeBtn: {
    backgroundColor: '#EF4444',
    paddingVertical: 10,
    paddingHorizontal: 22,
  },
  removeBtnText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
});
