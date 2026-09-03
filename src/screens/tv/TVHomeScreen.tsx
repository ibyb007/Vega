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

const ROW_HEIGHT = 245;

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
          const cachedMeta = await getMetadata(targetUrl, targetProvider);
          if (cachedMeta) {
            if (cachedMeta.background) {
              backdrop = cachedMeta.background;
              hasLandscape = true;
            }
            if (cachedMeta.description) description = cachedMeta.description;
            if (cachedMeta.rating) rating = String(cachedMeta.rating);
            if (cachedMeta.year) year = String(cachedMeta.year);
            if (cachedMeta.genres?.length) genres = cachedMeta.genres;
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
      {/* 1. Stationary Stremio Header Over Backdrop */}
      <View style={styles.fixedHeroContainer}>
        <TVHeroMeta media={activeHero} />
      </View>

      {/* 2. Sliding Row Viewport */}
      <View style={styles.stageViewport}>
        <Animated.View style={[styles.slidingRowsContainer, animatedRowsStyle]}>
          {displayRows.map((row: any, rowIndex: number) => {
            const rowPosts = row.Posts || [];
            if (rowPosts.length === 0) return null;

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
                        scaleFocused={1.07}
                        focusedBorderColor="#FFFFFF"
                        borderRadius={8}
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
                        onLongPress={() => {
                          if (row.isHistory) {
                            setItemToDelete(item);
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

                            {/* Continue Watching Progress */}
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

      {/* Remove from Continue Watching Confirmation Modal */}
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
    height: 230,
    width: '100%',
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 1,
  },
  stageViewport: {
    position: 'absolute',
    top: 230,
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
  progressBarTrack: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 4,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
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
