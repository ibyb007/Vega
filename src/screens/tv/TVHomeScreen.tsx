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
import { Post } from '../../lib/providers/types';
import { TVRoute } from '../../components/tv/TVNavigationRail';

interface TVHomeScreenProps {
  onSelectItem: (item: any) => void;
  onNavigateRoute?: (route: TVRoute) => void;
}

interface MediaRowProps {
  title: string;
  posts: Post[];
  isFirstRow?: boolean;
  onFocusItem: (post: Post) => void;
  onSelectItem: (post: Post) => void;
}

const MediaRow: React.FC<MediaRowProps> = ({
  title,
  posts,
  isFirstRow = false,
  onFocusItem,
  onSelectItem,
}) => {
  if (!posts || posts.length === 0) return null;

  return (
    <View style={styles.rowContainer}>
      <Text style={styles.rowCategoryTitle}>{title}</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.horizontalRowScroll}
      >
        {posts.map((item, pIndex) => (
          <TVFocusablePressable
            key={`${item.link}-${pIndex}`}
            hasTVPreferredFocus={isFirstRow && pIndex === 0}
            scaleFocused={1.08}
            focusedBorderColor="#8A5CF6"
            borderRadius={10}
            onFocus={() => onFocusItem(item)}
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
        ))}
      </ScrollView>
    </View>
  );
};

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
      >
        <TVHeroMeta media={activeHero} />

        <View style={styles.rowsWrapper}>
          {homeData.map((row, index) => {
            const rowPosts = row.Posts || [];
            if (rowPosts.length === 0) return null;

            return (
              <MediaRow
                key={`${row.filter || row.title}-${index}`}
                title={row.title}
                posts={rowPosts}
                isFirstRow={index === 0}
                onFocusItem={(post) =>
                  setActiveHero({
                    title: post.title,
                    backdropUrl: post.image,
                    posterUrl: post.image,
                    overview: post.extra || 'Select title to browse stream links.',
                  })
                }
                onSelectItem={onSelectItem}
              />
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
  focusBorderGlow: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 10,
    borderWidth: 2.5,
    borderColor: '#8A5CF6',
  },
});
