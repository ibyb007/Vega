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

      {/* Gradients blending into the background */}
      <LinearGradient
        colors={['transparent', 'rgba(10, 10, 14, 0.7)', '#0A0A0E']}
        locations={[0, 0.65, 1]}
        style={styles.bottomGradient}
      />
      <LinearGradient
        colors={['#0A0A0E', 'rgba(10, 10, 14, 0.85)', 'transparent']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={styles.leftGradient}
      />

      <View style={styles.contentWrapper}>
        <Text numberOfLines={1} style={styles.title}>
          {media.title}
        </Text>

        <View style={styles.metaRow}>
          {media.year ? <Text style={styles.metaBadge}>{media.year}</Text> : null}
          {media.rating ? (
            <View style={styles.ratingBadge}>
              <Text style={styles.ratingText}>★ {media.rating}</Text>
            </View>
          ) : null}
          {media.genres && media.genres.length > 0 ? (
            <Text style={styles.genreText}>{media.genres.join(' • ')}</Text>
          ) : null}
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
    height: 330,
    width: SCREEN_WIDTH,
    marginLeft: -70, // Align seamlessly to physical screen edge
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
  },
  bottomGradient: {
    ...StyleSheet.absoluteFillObject,
  },
  leftGradient: {
    ...StyleSheet.absoluteFillObject,
    width: '60%',
  },
  contentWrapper: {
    paddingLeft: 96,
    paddingBottom: 24,
    maxWidth: 750,
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
    textShadowRadius: 6,
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
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
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
    color: '#9CA3AF',
    fontSize: 14,
    lineHeight: 21,
  },
});
