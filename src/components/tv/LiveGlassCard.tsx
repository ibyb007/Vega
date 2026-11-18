import React from 'react';
import {Image, StyleSheet, Text, View} from 'react-native';
import LinearGradient from 'react-native-linear-gradient';

/**
 * Wide "liquid glass" card for Live TV channels.
 *
 * Channel artwork is a logo, not a poster: a tall 130x190 poster crops it. This
 * card is 16:9-ish, shows the logo with `contain` (never cropped) on a frosted,
 * translucent panel (soft diagonal sheen, bright top edge, hairline border) with
 * the channel name in a glass strip along the bottom.
 *
 * It's plain translucent layers rather than a real backdrop blur on purpose:
 * rows hold dozens of cards, and a live blur per card is too heavy for TV SoCs.
 */
export const LIVE_CARD_WIDTH = 210;
export const LIVE_CARD_HEIGHT = 120;
export const LIVE_CARD_RADIUS = 18;

interface LiveGlassCardProps {
  title?: string;
  image?: string;
  focused?: boolean;
  /** Small label in the top-left corner, e.g. the post's `tag` ("LIVE"). */
  badge?: string;
}

export const LiveGlassCard = React.memo(function LiveGlassCard({
  title,
  image,
  focused,
  badge,
}: LiveGlassCardProps) {
  return (
    <View style={[styles.glass, focused && styles.glassFocused]}>
      <LinearGradient
        pointerEvents="none"
        colors={
          focused
            ? ['rgba(255,255,255,0.38)', 'rgba(255,255,255,0.10)', 'rgba(255,255,255,0.20)']
            : ['rgba(255,255,255,0.24)', 'rgba(255,255,255,0.04)', 'rgba(255,255,255,0.10)']
        }
        start={{x: 0, y: 0}}
        end={{x: 1, y: 1}}
        style={StyleSheet.absoluteFill}
      />
      {/* Specular highlight along the top edge. */}
      <View pointerEvents="none" style={styles.topEdge} />

      <View style={styles.logoArea}>
        {image ? (
          <Image
            source={{uri: image}}
            style={styles.logo}
            resizeMode="contain"
            resizeMethod="resize"
          />
        ) : (
          <Text numberOfLines={2} style={styles.fallbackTitle}>
            {title}
          </Text>
        )}
      </View>

      <View style={styles.labelStrip}>
        <Text numberOfLines={1} style={styles.label}>
          {title}
        </Text>
      </View>

      {badge ? (
        <View style={styles.badge}>
          <View style={styles.badgeDot} />
          <Text style={styles.badgeText}>{badge}</Text>
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  glass: {
    flex: 1,
    borderRadius: LIVE_CARD_RADIUS - 2,
    overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.22)',
  },
  glassFocused: {
    backgroundColor: 'rgba(255,255,255,0.14)',
    borderColor: 'rgba(255,255,255,0.55)',
  },
  topEdge: {
    position: 'absolute',
    top: 0,
    left: 14,
    right: 14,
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.55)',
  },
  logoArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
    paddingTop: 12,
    paddingBottom: 6,
  },
  logo: {
    width: '100%',
    height: '100%',
  },
  fallbackTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
  },
  labelStrip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: 'rgba(8,8,14,0.38)',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.14)',
  },
  label: {
    color: '#F3F4F6',
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'center',
  },
  badge: {
    position: 'absolute',
    top: 7,
    left: 8,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 8,
    backgroundColor: 'rgba(0,0,0,0.35)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  badgeDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    marginRight: 4,
    backgroundColor: '#FF4D4F',
  },
  badgeText: {
    color: '#FFFFFF',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.6,
  },
});
