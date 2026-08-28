import React, { useState, useEffect, useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView, Image } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { TVHeroMeta, TVHeroMedia } from '../../components/tv/TVHeroMeta';
import { TVFocusablePressable } from '../../components/tv/TVFocusablePressable';
import useContentStore from '../../lib/zustand/contentStore';
import { useHomePageData, getRandomHeroPost } from '../../lib/hooks/useHomePageData';
import { Post } from '../../lib/providers/types';

interface TVHomeScreenProps {
  onSelectItem: (item: any) => void;
  onNavigateRoute?: (route: 'addons' | 'settings') => void;
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
      <Text style={styles.rowTitle}>{title}</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.rowScroll}
      >
        {posts.map((item, index) => (
          <TVFocusablePressable
            key={`${item.link}-${index}`}
            hasTVPreferredFocus={isFirstRow && index === 0}
            scaleFocused={1.08}
            focusedBorderColor="#8A5CF6"
            borderRadius={8}
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
                      'https://placehold.jp/24/363636/ffffff/100x150.png?text=Vega',
                  }}
                  style={styles.cardPoster}
                  resizeMode="cover"
                />
                {focused && (
                  <View style={styles.cardBadge}>
                    <Text numberOfLines={1} style={styles.cardTitle}>
                      {item.title}
                    </Text>
                  </View>
                )}
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

  const hasProviders = Boolean(installedProviders && installedProviders.length > 0 && provider?.value);

  const { data: homeData = [], isLoading } = useHomePageData({
    provider,
    enabled: hasProviders,
  });

  // Pick hero backdrop when catalog loads
  useEffect(() => {
    if (homeData && homeData.length > 0) {
      const hero = getRandomHeroPost(homeData, provider?.value);
      if (hero) {
        setActiveHero({
          title: hero.title,
          backdropUrl: hero.image,
          posterUrl: hero.image,
          overview: 'Select title to browse stream links and episodes.',
        });
      }
    }
  }, [homeData, provider?.value]);

  // If no extensions/providers are installed, show the TV Tutorial Screen
  if (!hasProviders) {
    return (
      <View style={styles.emptyContainer}>
        <View style={styles.iconCircle}>
          <MaterialCommunityIcons name="package-variant-closed" size={72} color="#8A5CF6" />
        </View>

        <Text style={styles.emptyTitle}>No Provider Installed</Text>
        <Text style={styles.emptySubtitle}>
          Install cloud providers from the Addons repository to browse catalogs and stream media.
        </Text>

        <View style={styles.buttonRow}>
          <TVFocusablePressable
            hasTVPreferredFocus={true}
            scaleFocused={1.06}
            focusedBorderColor="#FFFFFF"
            borderRadius={12}
            onPress={() => onNavigateRoute?.('addons')}
            style={styles.primaryButton}
          >
            {({ focused }) => (
              <View style={styles.btnContent}>
                <MaterialCommunityIcons name="download" size={20} color="#FFFFFF" />
                <Text style={styles.btnText}>Install Cloud Providers</Text>
              </View>
            )}
          </TVFocusablePressable>

          <TVFocusablePressable
            scaleFocused={1.06}
            focusedBorderColor="#8A5CF6"
            borderRadius={12}
            onPress={() => onNavigateRoute?.('settings')}
            style={styles.secondaryButton}
          >
            {({ focused }) => (
              <View style={styles.btnContent}>
                <MaterialCommunityIcons name="cog-outline" size={20} color="#D1D5DB" />
                <Text style={styles.secondaryBtnText}>Settings</Text>
              </View>
            )}
          </TVFocusablePressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Top Dynamic Fanart Header */}
      <TVHeroMeta media={activeHero} />

      {/* Catalog Slider Rows */}
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.rowsWrapper}
      >
        {homeData.map((row, index) => (
          <MediaRow
            key={`${row.filter}-${index}`}
            title={row.title}
            posts={row.Posts}
            isFirstRow={index === 0}
            onFocusItem={(post) =>
              setActiveHero({
                title: post.title,
                backdropUrl: post.image,
                posterUrl: post.image,
                overview: 'Select title to browse stream links.',
              })
            }
            onSelectItem={onSelectItem}
          />
        ))}
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0E',
  },
  emptyContainer: {
    flex: 1,
    backgroundColor: '#0A0A0E',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 40,
    paddingLeft: 88,
  },
  iconCircle: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: 'rgba(138, 92, 246, 0.12)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 24,
  },
  emptyTitle: {
    color: '#FFFFFF',
    fontSize: 28,
    fontWeight: '800',
    marginBottom: 10,
    textAlign: 'center',
  },
  emptySubtitle: {
    color: '#9CA3AF',
    fontSize: 16,
    lineHeight: 24,
    textAlign: 'center',
    maxWidth: 580,
    marginBottom: 32,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 16,
  },
  primaryButton: {
    backgroundColor: '#8A5CF6',
    paddingHorizontal: 24,
    paddingVertical: 14,
  },
  secondaryButton: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    paddingHorizontal: 24,
    paddingVertical: 14,
  },
  btnContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  btnText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  secondaryBtnText: {
    color: '#D1D5DB',
    fontSize: 15,
    fontWeight: '600',
  },
  rowsWrapper: {
    paddingBottom: 40,
    paddingLeft: 84,
  },
  rowContainer: {
    marginBottom: 28,
  },
  rowTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 12,
    letterSpacing: 0.3,
  },
  rowScroll: {
    paddingRight: 40,
    gap: 16,
  },
  card: {
    width: 140,
    height: 210,
  },
  cardInner: {
    flex: 1,
    position: 'relative',
  },
  cardPoster: {
    width: '100%',
    height: '100%',
    borderRadius: 8,
  },
  cardBadge: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(0,0,0,0.85)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderBottomLeftRadius: 8,
    borderBottomRightRadius: 8,
  },
  cardTitle: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '600',
  },
});
