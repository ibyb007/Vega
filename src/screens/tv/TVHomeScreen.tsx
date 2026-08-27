import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, Image } from 'react-native';
import { TVHeroMeta, TVHeroMedia } from '../../components/tv/TVHeroMeta';
import { TVFocusablePressable } from '../../components/tv/TVFocusablePressable';

interface TVHomeScreenProps {
  onSelectItem: (item: any) => void;
}

interface MediaItem {
  id: string;
  title: string;
  posterUrl: string;
  backdropUrl: string;
  year?: string | number;
  rating?: string | number;
  duration?: string;
  genres?: string[];
  overview?: string;
  link: string;
}

interface MediaRowProps {
  title: string;
  items: MediaItem[];
  isFirstRow?: boolean;
  onFocusItem: (item: MediaItem) => void;
  onSelectItem: (item: MediaItem) => void;
}

const MediaRow: React.FC<MediaRowProps> = ({
  title,
  items,
  isFirstRow = false,
  onFocusItem,
  onSelectItem,
}) => {
  return (
    <View style={styles.rowContainer}>
      <Text style={styles.rowTitle}>{title}</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.rowScroll}
      >
        {items.map((item, index) => (
          <TVFocusablePressable
            key={item.id || index}
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
                  source={{ uri: item.posterUrl }}
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

export const TVHomeScreen: React.FC<TVHomeScreenProps> = ({ onSelectItem }) => {
  const [activeHero, setActiveHero] = useState<TVHeroMedia | null>(null);

  // Mock catalog rows - replace/bind with Vega catalog providers
  const popularMovies: MediaItem[] = [
    {
      id: '1',
      title: 'Margin Call',
      posterUrl: 'https://image.tmdb.org/t/p/w500/9kkwTszZzWfIuS311F5s3e7qQYc.jpg',
      backdropUrl: 'https://image.tmdb.org/t/p/original/9r1B3p3F3Esl8nK7f0Qh6vTsk2A.jpg',
      year: '2011',
      rating: '7.1',
      duration: '107 min',
      genres: ['Drama', 'Thriller'],
      overview: 'Follows key people at an investment bank over a 24-hour period during the financial crisis.',
      link: '/movie/margin-call',
    },
    {
      id: '2',
      title: 'Obsession',
      posterUrl: 'https://image.tmdb.org/t/p/w500/yF1Vs2Aepn6U3dM6dK2xLq1q.jpg',
      backdropUrl: 'https://image.tmdb.org/t/p/original/mDeZ8l4K6b9xL3v5A.jpg',
      year: '2024',
      rating: '7.9',
      duration: '111 min',
      genres: ['Horror', 'Romance', 'Thriller'],
      overview: 'A novelty charm traps two people in a cycle of dark and supernatural obsession.',
      link: '/movie/obsession',
    },
    {
      id: '3',
      title: 'The Invite',
      posterUrl: 'https://image.tmdb.org/t/p/w500/z6xK7w2xX9L3m1N4x5Y6Z7A.jpg',
      backdropUrl: 'https://image.tmdb.org/t/p/original/p7L8k9M2N1x5Y6Z7A.jpg',
      year: '2024',
      rating: '7.5',
      duration: '101 min',
      genres: ['Comedy', 'Drama'],
      overview: 'A couple invites their neighbors for dinner, setting off an unhinged chain of events.',
      link: '/movie/the-invite',
    },
  ];

  useEffect(() => {
    if (popularMovies.length > 0 && !activeHero) {
      setActiveHero(popularMovies[0]);
    }
  }, []);

  return (
    <View style={styles.container}>
      {/* Dynamic Stremio Fanart / Details Header */}
      <TVHeroMeta media={activeHero} />

      {/* Horizontal Carousel Rows */}
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.rowsWrapper}
      >
        <MediaRow
          title="Popular Movies"
          items={popularMovies}
          isFirstRow={true}
          onFocusItem={(item) => setActiveHero(item)}
          onSelectItem={onSelectItem}
        />
        <MediaRow
          title="Popular TV Series"
          items={popularMovies}
          onFocusItem={(item) => setActiveHero(item)}
          onSelectItem={onSelectItem}
        />
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0E',
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
