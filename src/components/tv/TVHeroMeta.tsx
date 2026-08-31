import React from 'react';
import { View, Text, StyleSheet, Image, Dimensions } from 'react-native';
import LinearGradient from 'react-native-linear-gradient';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

export interface TVHeroMedia {
  title: string;
  backdropUrl?: string;
  posterUrl?: string;
  overview?: string;
  year?: string;
  rating?: string;
  genres?: string[];
}

interface TVHeroMetaProps {
  media: TVHeroMedia | null;
}

export const TVHeroMeta: React.FC<TVHeroMetaProps> = ({ media }) => {
  if (!media) return <View style={styles.container} />;

  const imageUrl = media.backdropUrl || media.posterUrl;

  return (
    <View style={styles.container}>
      {imageUrl ? (
        <View style={styles.backdropContainer}>
          <Image
            source={{ uri: imageUrl }}
            style={styles.backdropImage}
            resizeMode="cover"
          />
        </View>
      ) : null}

      <LinearGradient
        colors={['transparent', 'rgba(10, 10, 14, 0.65)', '#0A0A0E']}
        locations={[0, 0.6, 1]}
        style={styles.bottomGradient}
      />
      <LinearGradient
        colors={['rgba(10, 10, 14, 0.95)', 'rgba(10, 10, 14, 0.7)', 'transparent']}
        locations={[0, 0.45, 0.85]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={styles.leftGradient}
      />

      {/* Hero text positioned safely to the right of the navigation rail */}
      <View style={styles.contentWrapper}>
        <Text numberOfLines={1} style={styles.title}>
          {media.title}
        </Text>

        <View style={styles.metaRow}>
          {media.year && <Text style={styles.metaBadge}>{media.year}</Text>}
          {media.rating && (
            <View style={styles.ratingBadge}>
              <Text style={styles.ratingText}>★ {media.rating}</Text>
            </View>
          )}
          {media.genres && media.genres.length > 0 && (
            <Text style={styles.genreText}>{media.genres.join(' • ')}</Text>
          )}
        </View>

        <Text numberOfLines={3} style={styles.overview}>
          {media.overview || 'Select title to browse stream links and episodes.'}
        </Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    height: 340,
    width: SCREEN_WIDTH,
    position: 'relative',
    justifyContent: 'flex-end',
  },
  backdropContainer: {
    ...StyleSheet.absoluteFillObject,
    overflow: 'hidden',
  },
  backdropImage: {
    width: '100%',
    height: '100%',
    position: 'absolute',
    right: 0,
    top: 0,
  },
  bottomGradient: {
    ...StyleSheet.absoluteFillObject,
  },
  leftGradient: {
    ...StyleSheet.absoluteFillObject,
    width: '75%',
  },
  contentWrapper: {
    position: 'absolute',
    bottom: 24,
    left: 88, // Inset past the sidebar
    maxWidth: 680,
    zIndex: 10,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 34,
    fontWeight: '800',
    letterSpacing: 0.4,
    marginBottom: 8,
    textShadowColor: 'rgba(0, 0, 0, 0.9)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 8,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 8,
  },
  metaBadge: {
    color: '#D1D5DB',
    fontSize: 13,
    fontWeight: '600',
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 4,
  },
  ratingBadge: {
    backgroundColor: '#F59E0B',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  ratingText: {
    color: '#000000',
    fontSize: 12,
    fontWeight: '800',
  },
  genreText: {
    color: '#9CA3AF',
    fontSize: 13,
    fontWeight: '500',
  },
  overview: {
    color: '#D1D5DB',
    fontSize: 14,
    lineHeight: 21,
    textShadowColor: 'rgba(0, 0, 0, 0.8)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
});
