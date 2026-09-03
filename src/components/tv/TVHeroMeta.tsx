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
  hasLandscapeBackdrop?: boolean;
}

interface TVHeroMetaProps {
  media: TVHeroMedia | null;
}

export const TVHeroMeta: React.FC<TVHeroMetaProps> = React.memo(({ media }) => {
  const isLandscape = Boolean(media?.backdropUrl && media.hasLandscapeBackdrop);
  const posterFallback = media?.posterUrl || media?.backdropUrl;

  return (
    <View style={styles.container}>
      {/* Background Graphic Layer */}
      {isLandscape && media?.backdropUrl ? (
        // 1. Genuine 16:9 Landscape Fanart Layer
        <View style={styles.backdropLayer} pointerEvents="none">
          <Image
            key={media.backdropUrl}
            source={{ uri: media.backdropUrl }}
            style={styles.backdropImage}
            resizeMode="cover"
          />
          <LinearGradient
            colors={['rgba(10, 10, 14, 0.2)', 'rgba(10, 10, 14, 0.65)', '#0A0A0E']}
            locations={[0, 0.55, 1]}
            style={styles.bottomGradient}
          />
          <LinearGradient
            colors={['rgba(10, 10, 14, 0.98)', 'rgba(10, 10, 14, 0.75)', 'transparent']}
            locations={[0, 0.45, 0.85]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.leftGradient}
          />
        </View>
      ) : posterFallback ? (
        // 2. Portrait Poster Fallback (~38% Width, No Cropping/Zooming)
        <View style={styles.posterFallbackLayer} pointerEvents="none">
          <View style={styles.posterContainer}>
            <Image
              key={posterFallback}
              source={{ uri: posterFallback }}
              style={styles.posterImage}
              resizeMode="contain"
            />
            {/* Soft edge blend into dark canvas */}
            <LinearGradient
              colors={['#0A0A0E', 'transparent', 'transparent', '#0A0A0E']}
              locations={[0, 0.15, 0.85, 1]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={StyleSheet.absoluteFill}
            />
            <LinearGradient
              colors={['transparent', 'rgba(10, 10, 14, 0.8)', '#0A0A0E']}
              locations={[0, 0.6, 1]}
              style={StyleSheet.absoluteFill}
            />
          </View>
        </View>
      ) : null}

      {/* Top-Left Stremio Metadata Block */}
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
    height: 230,
    width: SCREEN_WIDTH,
    position: 'relative',
    backgroundColor: '#0A0A0E',
    justifyContent: 'flex-start',
    paddingTop: 12,
  },
  backdropLayer: {
    ...StyleSheet.absoluteFillObject,
    height: 380,
    overflow: 'hidden',
  },
  backdropImage: {
    width: '100%',
    height: '100%',
    position: 'absolute',
    right: 0,
    top: 0,
  },
  posterFallbackLayer: {
    position: 'absolute',
    top: 0,
    right: 32,
    bottom: 0,
    width: '38%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  posterContainer: {
    width: '100%',
    height: 220,
    position: 'relative',
  },
  posterImage: {
    width: '100%',
    height: '100%',
  },
  bottomGradient: {
    ...StyleSheet.absoluteFillObject,
  },
  leftGradient: {
    ...StyleSheet.absoluteFillObject,
    width: '75%',
  },
  contentWrapper: {
    paddingLeft: 88,
    maxWidth: 620,
    zIndex: 10,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 30,
    fontWeight: '900',
    letterSpacing: -0.4,
    marginBottom: 6,
    textShadowColor: 'rgba(0, 0, 0, 0.95)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 6,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 6,
  },
  metaText: {
    color: '#D1D5DB',
    fontSize: 13,
    fontWeight: '600',
  },
  ratingBadge: {
    backgroundColor: '#F59E0B',
    paddingHorizontal: 6,
    paddingVertical: 1,
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
    fontSize: 13,
    lineHeight: 18,
    textShadowColor: 'rgba(0, 0, 0, 0.9)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  castText: {
    color: '#6B7280',
    fontSize: 12,
    fontWeight: '500',
    marginTop: 4,
  },
});
