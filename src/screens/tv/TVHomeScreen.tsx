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
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import KeyEvent from 'react-native-keyevent';
import { TVHeroMeta, TVHeroMedia } from '../../components/tv/TVHeroMeta';
import { TVFocusablePressable } from '../../components/tv/TVFocusablePressable';
import { TVNoProviderFallback } from '../../components/tv/TVNoProviderFallback';
import useContentStore from '../../lib/zustand/contentStore';
import useContinueWatchingStore from '../../lib/zustand/continueWatchingStore';
import { useHomePageData } from '../../lib/hooks/useHomePageData';
import { getMetadata, prefetchMetadata } from '../../lib/services/metadataCache';
import { providerManager } from '../../lib/services/ProviderManager';
import { TVRoute } from '../../components/tv/TVNavigationRail';

const ROW_HEIGHT = 235;
const imdbMetaCache = new Map<string, any>();

let lastFocusedKey: string | null = null;
let lastFocusedRowIndex = 0;

const fetchCinemetaByImdb = async (imdbId: string, type: string = 'movie'): Promise<any | null> => {
  if (!imdbId || !imdbId.startsWith('tt')) return null;

  if (imdbMetaCache.has(imdbId)) {
    return imdbMetaCache.get(imdbId);
  }

  try {
    const mediaType = type === 'series' ? 'series' : 'movie';
    const res = await fetch(`https://v3-cinemeta.strem.io/meta/${mediaType}/${imdbId}.json`);
    const data = await res.json();
    if (data?.meta) {
      imdbMetaCache.set(imdbId, data.meta);
      return data.meta;
    }
  } catch {}

  return null;
};

interface TVHomeScreenProps {
  onSelectItem: (item: any) => void;
  // Called instead of onSelectItem when a Continue Watching card is
  // pressed -- resolves the saved episode/movie link directly and starts
  // playback at the stored position, without detouring through the details
  // screen (which would restart from 0:00).
  onResumeItem?: (item: any) => void;
  onNavigateRoute?: (route: TVRoute) => void;
  homeFocusTarget?: number | null;
}

export const TVHomeScreen: React.FC<TVHomeScreenProps> = ({
  onSelectItem,
  onResumeItem,
  onNavigateRoute,
  homeFocusTarget,
}) => {
  const provider = useContentStore((state) => state.provider);
  const installedProviders = useContentStore((state) => state.installedProviders);
  const continueWatchingItems = useContinueWatchingStore((state) => state.items) || [];
  const removeItemFromHistory = useContinueWatchingStore((state) => state.removeItem);

  const [activeHero, setActiveHero] = useState<TVHeroMedia | null>(null);
  const [activeRowIndex, setActiveRowIndex] = useState<number>(lastFocusedRowIndex);
  const [itemToDelete, setItemToDelete] = useState<any | null>(null);
  const [confirmingRemoveAll, setConfirmingRemoveAll] = useState(false);

  const translateY = useSharedValue(-lastFocusedRowIndex * ROW_HEIGHT);

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
      let description = item.extra || item.description || '';
      let rating = item.rating || null;
      let year = item.year || null;
      let runtime = item.runtime || null;
      let genres = item.genres || [];
      let foundImdbId: string | null = null;

      // 1. Check Vega internal metadata cache
      if (targetUrl && targetProvider) {
        try {
          const cached = await getMetadata(targetUrl, targetProvider);
          if (cached) {
            if (cached.background || cached.backdrop) {
              backdrop = cached.background || cached.backdrop;
            }
            if (cached.description) description = cached.description;
            if (cached.rating) rating = String(cached.rating);
            if (cached.year) year = String(cached.year);
            if (cached.runtime) runtime = cached.runtime;
            if (cached.genres?.length) genres = cached.genres;
            if (cached.imdbId && typeof cached.imdbId === 'string') {
              foundImdbId = cached.imdbId;
            }
          }
        } catch {}
      }

      if (!foundImdbId && item.imdbId) {
        foundImdbId = item.imdbId;
      }

      // 2. Fetch Cinemeta landscape fanart if IMDb ID is known
      if (foundImdbId) {
        try {
          const cineMeta = await fetchCinemetaByImdb(foundImdbId, item.type);
          if (cineMeta) {
            if (cineMeta.background) {
              backdrop = cineMeta.background;
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
        backdropUrl: backdrop || posterImage || undefined,
        posterUrl: posterImage,
        overview: isHistory
          ? episodeTitle
            ? `${episodeTitle} • Resume (${progressPercent}%)`
            : `Resume watching (${progressPercent}%)`
          : description || 'Select title to browse stream links and episodes.',
        year: year ? String(year) : undefined,
        rating: rating ? String(rating) : undefined,
        runtime: runtime || undefined,
        genres: genres.length > 0 ? genres : undefined,
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

  // Tracks whichever history-row card currently has focus, and the state
  // for detecting a D-pad OK/select "hold" on it -- see the key listener
  // effect below for why this exists instead of just `onLongPress`.
  const focusedHistoryItemRef = useRef<any>(null);
  const selectHoldStreakRef = useRef(0);
  const selectHoldTriggeredRef = useRef(false);
  const lastSelectKeyTimeRef = useRef(0);

  const handleCardFocus = useCallback(
    (rowIndex: number, item: any, itemKey: string, isHistory: boolean = false) => {
      lastFocusedKey = itemKey;
      lastFocusedRowIndex = rowIndex;
      setActiveRowIndex(rowIndex);

      focusedHistoryItemRef.current = isHistory ? item : null;
      selectHoldStreakRef.current = 0;
      selectHoldTriggeredRef.current = false;

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

  // `onLongPress`/`delayLongPress` (still left in place on the card below
  // as a harmless fallback) rely on React Native's touch-responder timing
  // pipeline, which a hardware remote's D-pad OK/select button frequently
  // never enters on Android TV -- the key event is dispatched as a
  // click, not a touch-down-hold-release gesture, so no long-press timer
  // ever starts. `react-native-keyevent` (already used by the TV player
  // for the same underlying reason) sees the raw key stream instead:
  // Android auto-repeats a held key's key-down event at a steady cadence,
  // so a short run of repeats on OK/select IS a hold, independent of
  // whatever gesture-timing RN's Pressable does or doesn't manage on this
  // device.
  useEffect(() => {
    const KEYCODE_DPAD_CENTER = 23;
    const KEYCODE_ENTER = 66;
    const HOLD_STREAK_THRESHOLD = 3;
    const RELEASE_GAP_MS = 400;

    const handleKeyDown = (e: { keyCode?: number }) => {
      if (e?.keyCode !== KEYCODE_DPAD_CENTER && e?.keyCode !== KEYCODE_ENTER) return;
      if (!focusedHistoryItemRef.current) return;

      const now = Date.now();
      if (now - lastSelectKeyTimeRef.current > RELEASE_GAP_MS) {
        selectHoldStreakRef.current = 0;
        selectHoldTriggeredRef.current = false;
      }
      lastSelectKeyTimeRef.current = now;
      selectHoldStreakRef.current += 1;

      if (selectHoldStreakRef.current >= HOLD_STREAK_THRESHOLD && !selectHoldTriggeredRef.current) {
        selectHoldTriggeredRef.current = true;
        setConfirmingRemoveAll(false);
        setItemToDelete(focusedHistoryItemRef.current);
      }
    };

    KeyEvent.onKeyDownListener(handleKeyDown);
    return () => KeyEvent.removeKeyDownListener();
  }, []);

  const confirmDeleteFromHistory = () => {
    if (!itemToDelete) return;
    const identifier = itemToDelete.id || itemToDelete.infoUrl || itemToDelete.link;
    if (identifier) {
      removeItemFromHistory(identifier);
      ToastAndroid.show('Removed from Continue Watching', ToastAndroid.SHORT);
    }
    setItemToDelete(null);
    setConfirmingRemoveAll(false);
  };

  const confirmRemoveAllHistory = () => {
    watchHistory.forEach((histItem: any) => {
      const identifier = histItem.id || histItem.infoUrl || histItem.link;
      if (identifier) removeItemFromHistory(identifier);
    });
    ToastAndroid.show('Cleared Continue Watching', ToastAndroid.SHORT);
    setItemToDelete(null);
    setConfirmingRemoveAll(false);
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
                    const itemKey = `${item.infoUrl || item.link || item.id}-${rowIndex}-${pIndex}`;
                    const isFirstInRow = pIndex === 0;
                    const shouldFocus = lastFocusedKey
                      ? lastFocusedKey === itemKey
                      : rowIndex === 0 && isFirstInRow;

                    const posterImage = item.poster || item.background || item.image;
                    const progressPercent =
                      item.duration && item.position
                        ? Math.min(100, Math.round((item.position / item.duration) * 100))
                        : 0;

                    return (
                      <TVFocusablePressable
                        key={itemKey}
                        hasTVPreferredFocus={shouldFocus}
                        scaleFocused={1.06}
                        focusedBorderColor="#FFFFFF"
                        borderRadius={8}
                        delayLongPress={350}
                        {...(isFirstInRow && homeFocusTarget
                          ? { nextFocusLeft: homeFocusTarget }
                          : { trapFocusLeft: !isFirstInRow })}
                        onFocus={() => handleCardFocus(rowIndex, item, itemKey, isHistoryRow)}
                        onPress={() => {
                          lastFocusedKey = itemKey;
                          lastFocusedRowIndex = rowIndex;

                          if (selectHoldTriggeredRef.current) {
                            // Already handled as a hold (remove-from-history
                            // prompt just opened) -- swallow the release
                            // tap so it doesn't also navigate in underneath
                            // the modal.
                            selectHoldTriggeredRef.current = false;
                            return;
                          }

                          if (isHistoryRow) {
                            // Route through the same details/episode-picker
                            // screen a fresh poster press uses, instead of
                            // re-resolving the old stored stream link
                            // directly. Providers' resolved stream links
                            // (and sometimes even their info-page links)
                            // are often short-lived, so silently replaying
                            // one from continue-watching later tends to
                            // fail with a "provider link invalid" error.
                            // Going through the picker re-fetches
                            // everything fresh; `resumeHint` lets
                            // `TVDetailsScreen` recognize when the episode
                            // picked is the one being resumed and seek to
                            // the saved position instead of starting over.
                            onSelectItem({
                              link: item.infoUrl || item.link,
                              provider: item.providerValue || item.provider,
                              image: posterImage,
                              title: item.title,
                              resumeHint: {
                                episodeLink: item.episode?.link,
                                position: item.position,
                              },
                            });
                          } else {
                            onSelectItem(item);
                          }
                        }}
                        onLongPress={() => {
                          if (isHistoryRow) {
                            setConfirmingRemoveAll(false);
                            setItemToDelete(item);
                          }
                        }}
                        style={[styles.card, isHistoryRow && styles.cardCompact]}
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
        onRequestClose={() => {
          setItemToDelete(null);
          setConfirmingRemoveAll(false);
        }}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <MaterialCommunityIcons
              name={confirmingRemoveAll ? 'playlist-remove' : 'movie-remove-outline'}
              size={38}
              color="#EF4444"
            />
            <Text style={styles.modalTitle}>
              {confirmingRemoveAll ? 'Clear Continue Watching?' : 'Remove From History?'}
            </Text>
            {confirmingRemoveAll ? (
              <Text style={styles.modalDescription}>
                This will remove all {watchHistory.length} title
                {watchHistory.length === 1 ? '' : 's'} and their resume progress from your
                Continue Watching row.
              </Text>
            ) : (
              <>
                <Text numberOfLines={2} style={styles.modalSubtitle}>
                  {itemToDelete?.title}
                </Text>
                <Text style={styles.modalDescription}>
                  This will remove the title and its resume progress from your Continue Watching
                  row.
                </Text>
              </>
            )}

            <View style={styles.modalActions}>
              <TVFocusablePressable
                hasTVPreferredFocus={true}
                scaleFocused={1.05}
                focusedBorderColor="#8A5CF6"
                borderRadius={8}
                onPress={() => {
                  setItemToDelete(null);
                  setConfirmingRemoveAll(false);
                }}
                style={styles.cancelBtn}
              >
                {() => <Text style={styles.cancelBtnText}>Cancel</Text>}
              </TVFocusablePressable>

              {confirmingRemoveAll ? (
                <TVFocusablePressable
                  scaleFocused={1.05}
                  focusedBorderColor="#FFFFFF"
                  borderRadius={8}
                  onPress={confirmRemoveAllHistory}
                  style={styles.removeBtn}
                >
                  {() => <Text style={styles.removeBtnText}>Clear All</Text>}
                </TVFocusablePressable>
              ) : (
                <>
                  <TVFocusablePressable
                    scaleFocused={1.05}
                    focusedBorderColor="#8A5CF6"
                    borderRadius={8}
                    onPress={() => setConfirmingRemoveAll(true)}
                    style={styles.selectAllBtn}
                  >
                    {() => (
                      <View style={styles.selectAllBtnInner}>
                        <MaterialIcons name="select-all" size={16} color="#D1D5DB" />
                        <Text style={styles.selectAllBtnText}>Remove All</Text>
                      </View>
                    )}
                  </TVFocusablePressable>

                  <TVFocusablePressable
                    scaleFocused={1.05}
                    focusedBorderColor="#FFFFFF"
                    borderRadius={8}
                    onPress={confirmDeleteFromHistory}
                    style={styles.removeBtn}
                  >
                    {() => (
                      <View style={styles.selectAllBtnInner}>
                        <MaterialCommunityIcons
                          name="trash-can-outline"
                          size={16}
                          color="#FFFFFF"
                        />
                        <Text style={styles.removeBtnText}>Remove</Text>
                      </View>
                    )}
                  </TVFocusablePressable>
                </>
              )}
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
    top: 220,
    bottom: 0,
    left: 0,
    right: 0,
    overflow: 'hidden',
    zIndex: 2,
  },
  slidingRowsContainer: {
    paddingLeft: 84,
    paddingTop: 0,
  },
  rowContainer: {
    height: ROW_HEIGHT,
  },
  rowCategoryTitle: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '800',
    marginBottom: 6,
    letterSpacing: 0.2,
  },
  horizontalRowScroll: {
    paddingRight: 60,
    gap: 14,
    paddingVertical: 2,
  },
  card: {
    width: 130,
    height: 190,
    backgroundColor: '#16161E',
    borderRadius: 8,
  },
  cardCompact: {
    width: 125,
    height: 180,
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
    paddingTop: 3,
    paddingBottom: 3,
  },
  historyPercentText: {
    color: '#D1D5DB',
    fontSize: 10,
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
  selectAllBtn: {
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    paddingVertical: 10,
    paddingHorizontal: 18,
  },
  selectAllBtnInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  selectAllBtnText: {
    color: '#D1D5DB',
    fontSize: 13,
    fontWeight: '600',
  },
});
