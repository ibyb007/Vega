import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, Image, ActivityIndicator } from 'react-native';
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
          overview: 'Select title to browse stream links and episodes.',
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
        <Text style={styles.loadingText}>Loading {provider?.displayTitle || provider?.name} catalog...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <TVHeroMeta media={activeHero} />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.rowsWrapper}
      >
        {homeData.map((row, index) => (
          <View key={`${row.filter || row.title}-${index}`} style={styles.rowContainer}>
            <Text style={styles.rowTitle}>{row.title}</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.rowScroll}
            >
              {(row.Posts || []).map((item, pIndex) => (
                <TVFocusablePressable
                  key={`${item.link}-${pIndex}`}
                  hasTVPreferredFocus={index === 0 && pIndex === 0}
                  scaleFocused={1.08}
                  focusedBorderColor="#8A5CF6"
                  borderRadius={8}
                  onFocus={() =>
                    setActiveHero({
                      title: item.title,
                      backdropUrl: item.image,
                      posterUrl: item.image,
                      overview: 'Select title to browse stream links.',
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
  centerLoading: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#0A0A0E',
    paddingLeft: 32,
  },
  loadingText: {
    color: '#9CA3AF',
    fontSize: 16,
    marginTop: 16,
  },
  rowsWrapper: {
    paddingBottom: 40,
    paddingLeft: 32,
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
