import React from 'react';
import { View, Text, Image, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

export interface TVHeroMedia {
  title: string;
  backdropUrl?: string;
  posterUrl?: string;
  year?: string | number;
  rating?: string | number;
  duration?: string;
  genres?: string[];
  overview?: string;
}

interface TVHeroMetaProps {
  media?: TVHeroMedia | null;
}

export const TVHeroMeta: React.FC<TVHeroMetaProps> = ({ media }) => {
  if (!media) {
    return <View style={styles.placeholder} />;
  }

  return (
    <View style={styles.container}>
      {/* Dynamic Fanart Backdrop Image */}
      {media.backdropUrl ? (
        <Image
          source={{ uri: media.backdropUrl }}
          style={StyleSheet.absoluteFillObject}
          resizeMode="cover"
        />
      ) : null}

      {/* Dark Vignette Gradients for Text Readability */}
      <LinearGradient
        colors={['transparent', 'rgba(0, 0, 0, 0.7)', '#0A0A0E']}
        style={StyleSheet.absoluteFillObject}
        start={{ x: 0.5, y: 0.2 }}
        end={{ x: 0.5, y: 1.0 }}
      />
      <LinearGradient
        colors={['#0A0A0E', 'rgba(10, 10, 14, 0.85)', 'transparent']}
        style={StyleSheet.absoluteFillObject}
        start={{ x: 0.0, y: 0.5 }}
        end={{ x: 0.75, y: 0.5 }}
      />

      {/* Metadata Overview Block */}
      <View style={styles.metaContent}>
        <Text numberOfLines={1} style={styles.title}>
          {media.title}
        </Text>

        {/* Badges / Chips */}
        <View style={styles.badgeRow}>
          {media.duration ? <Text style={styles.metaBadge}>{media.duration}</Text> : null}
          {media.year ? <Text style={styles.metaBadge}>{media.year}</Text> : null}
          {media.rating ? (
            <View style={styles.ratingBadge}>
              <Text style={styles.ratingText}>★ {media.rating}</Text>
            </View>
          ) : null}
          {media.genres?.slice(0, 3).map((genre, idx) => (
            <Text key={idx} style={styles.genreText}>
              {genre} {idx < Math.min(media.genres?.length || 0, 3) - 1 ? '•' : ''}
            </Text>
          ))}
        </View>

        {/* Short Synopsis */}
        {media.overview ? (
          <Text numberOfLines={3} style={styles.overview}>
            {media.overview}
          </Text>
        ) : null}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    height: 330,
    width: '100%',
    justifyContent: 'flex-end',
    paddingLeft: 96,
    paddingRight: 48,
    paddingBottom: 24,
  },
  placeholder: {
    height: 330,
    width: '100%',
    backgroundColor: '#0A0A0E',
  },
  metaContent: {
    maxWidth: 700,
    zIndex: 10,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 34,
    fontWeight: '900',
    letterSpacing: 0.4,
    marginBottom: 8,
  },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 10,
    marginBottom: 12,
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
    backgroundColor: '#EAB308',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 4,
  },
  ratingText: {
    color: '#000000',
    fontWeight: '800',
    fontSize: 12,
  },
  genreText: {
    color: '#9CA3AF',
    fontSize: 13,
    fontWeight: '500',
  },
  overview: {
    color: '#9CA3AF',
    fontSize: 14,
    lineHeight: 20,
  },
});
