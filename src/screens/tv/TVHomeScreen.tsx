import React, { useState, useEffect, useRef } from 'react';
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
import { Post } from '../../lib/providers/types';
import { TVRoute } from '../../components/tv/TVNavigationRail';
import useContinueWatchingStore from '../../lib/zustand/continueWatchingStore';

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
  const continueWatchingItems = useContinueWatchingStore((state) => state.items);
  const watchHistory = [...continueWatchingItems]
    .filter((item) => Boolean(item.providerValue))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  
  const [activeHero, setActiveHero] = useState<TVHeroMedia | null>(null);
  const initialFocusSetRef = useRef(false);

  const hasProviders = Boolean(
    installedProviders && installedProviders.length > 0 && provider?.value
  );

  const { data: homeData = [], isLoading } = useHomePageData({
    provider,
    enabled: hasProviders,
  });

  useEffect(() => {
    if (homeData && homeData.length > 0 && !activeHero) {
      const hero = getRandomHeroPost(homeData, provider?.value);
      if (hero) {
        setActiveHero({
          title: hero.title,
          backdropUrl: hero.image,
          posterUrl: hero.image,
          overview: hero.extra || 'Select title to browse stream links and playback streams.',
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
        removeClippedSubviews={false}
      >
        <TVHeroMeta media={activeHero} />

        <View style={styles.rowsWrapper}>
          {/* Continue Watching Row */}
          {Array.isArray(watchHistory) && watchHistory.length > 0 && (
            <View style={styles.rowContainer}>
              <Text style={styles.rowCategoryTitle}>Continue Watching</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.horizontalRowScroll}
                removeClippedSubviews={false}
              >
                {watchHistory.map((item, pIndex: number) => {
                  const posterImage = item.poster || item.background;
                  const progressPercent =
                    item.duration && item.position
                      ? Math.min(100, Math.round((item.position / item.duration) * 100))
                      : 0;
                  const episodeTitle =
                    item.episodeTitle ||
                    (item.episode?.title && item.episode.title !== item.title
                      ? item.episode.title
                      : undefined);

                  return (
                    <TVFocusablePressable
                      key={`history-${item.id || pIndex}`}
                      hasTVPreferredFocus={!initialFocusSetRef.current && pIndex === 0}
                      scaleFocused={1.08}
                      focusedBorderColor="#8A5CF6"
                      borderRadius={10}
                      onFocus={() => {
                        initialFocusSetRef.current = true;
                        setActiveHero({
                          title: item.title,
                          backdropUrl: posterImage,
                          posterUrl: posterImage,
                          overview: episodeTitle
                            ? `${episodeTitle} • Resume (${progressPercent}%)`
                            : `Resume watching (${progressPercent}%)`,
                        });
                      }}
                      onPress={() =>
                        onSelectItem({
                          link: item.infoUrl,
                          provider: item.providerValue,
                          image: posterImage,
                          title: item.title,
                        })
                      }
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
                          {progressPercent > 0 && (
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
          )}

          {/* Scraper Provider Content Rows */}
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
                  removeClippedSubviews={false}
                >
                  {rowPosts.map((item, pIndex) => {
                    const shouldInitialFocus =
                      !initialFocusSetRef.current &&
                      watchHistory.length === 0 &&
                      rowIndex === 0 &&
                      pIndex === 0;

                    return (
                      <TVFocusablePressable
                        key={`${item.link}-${pIndex}`}
                        hasTVPreferredFocus={shouldInitialFocus}
                        scaleFocused={1.08}
                        focusedBorderColor="#8A5CF6"
                        borderRadius={10}
                        onFocus={() => {
                          initialFocusSetRef.current = true;
                          setActiveHero({
                            title: item.title,
                            backdropUrl: item.image,
                            posterUrl: item.image,
                            overview: item.extra || 'Select title to browse stream links.',
                          });
                        }}
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
    paddingLeft: 84,
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
    paddingLeft: 96,
    marginTop: -10,
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
    borderWidth: 2.5,
    borderColor: '#8A5CF6',
  },
});
