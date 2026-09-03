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
  runtime?: string;
  genres?: string[];
  cast?: string[];
}

interface TVHeroMetaProps {
  media: TVHeroMedia | null;
}

export const TVHeroMeta: React.FC<TVHeroMetaProps> = React.memo(({ media }) => {
  const imageUrl = media?.backdropUrl || media?.posterUrl;

  return (
    <View style={styles.container}>
      {/* Edge-to-Edge Fanart Layer */}
      {imageUrl ? (
        <View style={styles.backdropContainer} pointerEvents="none">
          <Image
            key={imageUrl}
            source={{ uri: imageUrl }}
            style={styles.backdropImage}
            resizeMode="cover"
          />
          {/* Stremio Bottom Fade Gradient */}
          <LinearGradient
            colors={['transparent', 'rgba(10, 10, 14, 0.55)', '#0A0A0E']}
            locations={[0, 0.6, 1]}
            style={styles.bottomGradient}
          />
          {/* Stremio Left Vignette (Protects Text Readability) */}
          <LinearGradient
            colors={['rgba(10, 10, 14, 0.98)', 'rgba(10, 10, 14, 0.75)', 'transparent']}
            locations={[0, 0.45, 0.9]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.leftGradient}
          />
        </View>
      ) : null}

      {/* Stremio Metadata Block */}
      <View style={styles.contentWrapper}>
        <Text numberOfLines={1} style={styles.title}>
          {media?.title || ''}
        </Text>

        <View style={styles.metaRow}>
          {media?.runtime ? <Text style={styles.metaText}>{media.runtime}</Text> : null}
          {media?.year ? <Text style={styles.metaText}>{media.year}</Text> : null}
          {media?.rating ? (
            <View style={styles.ratingBadge}>
              <Text style={styles.ratingText}>★ {media.rating}</Text>
            </View>
          ) : null}
          {media?.genres && media.genres.length > 0 ? (
            <Text numberOfLines={1} style={styles.genresText}>
              {media.genres.join(' | ')}
            </Text>
          ) : null}
        </View>

        <Text numberOfLines={3} style={styles.overview}>
          {media?.overview || ''}
        </Text>

        {media?.cast && media.cast.length > 0 ? (
          <Text numberOfLines={1} style={styles.castText}>
            {media.cast.join(', ')}
          </Text>
        ) : null}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    height: 330,
    width: SCREEN_WIDTH,
    position: 'relative',
    justifyContent: 'flex-end',
    backgroundColor: '#0A0A0E',
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
    width: '78%',
  },
  contentWrapper: {
    paddingLeft: 96,
    paddingBottom: 16,
    maxWidth: 680,
    zIndex: 10,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 38,
    fontWeight: '900',
    letterSpacing: -0.5,
    marginBottom: 8,
    textShadowColor: 'rgba(0, 0, 0, 0.95)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 8,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 10,
  },
  metaText: {
    color: '#D1D5DB',
    fontSize: 13,
    fontWeight: '600',
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
  genresText: {
    color: '#9CA3AF',
    fontSize: 13,
    fontWeight: '500',
  },
  overview: {
    color: '#D1D5DB',
    fontSize: 14,
    lineHeight: 20,
    textShadowColor: 'rgba(0, 0, 0, 0.9)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  castText: {
    color: '#6B7280',
    fontSize: 12,
    fontWeight: '500',
    marginTop: 8,
  },
});
