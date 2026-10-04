import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Image, useWindowDimensions } from 'react-native';
import LinearGradient from 'react-native-linear-gradient';

export interface TVHeroMedia {
  title: string;
  // Second header line under the title -- e.g. "S01E02-Trust Fall" for a
  // Continue Watching series entry. Omitted (movies, non-history rows)
  // means the header stays a single line.
  subtitle?: string;
  backdropUrl?: string;
  posterUrl?: string;
  overview?: string;
  year?: string;
  rating?: string;
  runtime?: string;
  genres?: string[];
  cast?: string[];
  hasLandscapeBackdrop?: boolean;
  // Explicitly flags that no genuine landscape backdrop is known yet, so
  // the 3-layer blurred-poster canvas should render instead of the
  // full-bleed image. Not part of the aspect-ratio probing below -- kept
  // for API compatibility with callers that already set it.
  isPosterFallback?: boolean;
}

interface TVHeroMetaProps {
  media: TVHeroMedia | null;
}

// Caches image width/height ratios we've already resolved (by URL) so the
// same artwork never triggers a second network probe across re-renders,
// card-to-card focus changes, or remounts within a session.
const probedAspectRatioCache = new Map<string, number>();
// A ratio at or above this is treated as a genuine 16:9-ish landscape
// backdrop rather than a portrait/near-square poster.
const LANDSCAPE_ASPECT_THRESHOLD = 1.3;

export const TVHeroMeta: React.FC<TVHeroMetaProps> = React.memo(({ media }) => {
  const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = useWindowDimensions();

  // The backdrop canvas (image + gradients) used to stop at a flat 480dp,
  // regardless of the actual screen height. Below that it fell straight
  // through to `container`'s plain `#0A0A0E` background, which on a
  // screen taller than ~480+220dp of rows (i.e. most TVs, especially with
  // few/short rows) showed up as a hard-edged black band across the
  // bottom instead of the backdrop reaching edge to edge. Sizing it to the
  // actual window height instead makes the backdrop -- and its existing
  // fade-to-`#0A0A0E` gradient -- cover all the way down, so any leftover
  // dark space is the same gradual fade used everywhere else, not a
  // separate flat-black region.
  const canvasHeight = Math.max(480, SCREEN_HEIGHT);

  // Many providers only ever return a single image per title, and for a lot
  // of catalogs that single image is itself already a landscape banner --
  // not a true portrait poster -- even though nothing in the data explicitly
  // flags it as a "backdrop". Trusting `hasLandscapeBackdrop` alone in that
  // case makes the hero fall back to the blurred-poster canvas and shrink a
  // perfectly good 16:9 image down into a small centered box. To catch this,
  // whenever the data doesn't already claim a landscape backdrop, probe the
  // actual image dimensions and promote it to the full-bleed layout if it
  // turns out to be landscape-shaped after all.
  const explicitLandscape = Boolean(
    media?.hasLandscapeBackdrop ??
    (media?.backdropUrl && media?.backdropUrl !== media?.posterUrl)
  );
  const probeCandidate = !explicitLandscape ? media?.backdropUrl || media?.posterUrl : undefined;

  const [probedLandscapeSource, setProbedLandscapeSource] = useState<string | null>(null);

  useEffect(() => {
    if (!probeCandidate) {
      setProbedLandscapeSource(null);
      return;
    }

    const cachedRatio = probedAspectRatioCache.get(probeCandidate);
    if (cachedRatio !== undefined) {
      setProbedLandscapeSource(cachedRatio >= LANDSCAPE_ASPECT_THRESHOLD ? probeCandidate : null);
      return;
    }

    let cancelled = false;
    setProbedLandscapeSource(null);
    Image.getSize(
      probeCandidate,
      (w, h) => {
        if (cancelled) return;
        const ratio = h > 0 ? w / h : 0;
        probedAspectRatioCache.set(probeCandidate, ratio);
        setProbedLandscapeSource(ratio >= LANDSCAPE_ASPECT_THRESHOLD ? probeCandidate : null);
      },
      () => {
        if (!cancelled) probedAspectRatioCache.set(probeCandidate, 0);
      },
    );

    return () => {
      cancelled = true;
    };
  }, [probeCandidate]);

  // Determine if we have a real 16:9 landscape backdrop -- either the data
  // already told us so, or the probe above confirmed it.
  const isLandscape = explicitLandscape || Boolean(probedLandscapeSource);

  // When the probe is what promoted us to landscape, the image that turned
  // out to be landscape-shaped is whichever of backdropUrl/posterUrl we
  // actually measured (probeCandidate) -- use that as the full-bleed source.
  const backdropSource = media?.backdropUrl || (probedLandscapeSource ? media?.posterUrl : undefined);
  const posterSource = media?.posterUrl || media?.backdropUrl;

  return (
    <View style={[styles.container, { width: SCREEN_WIDTH }]}>
      {isLandscape && backdropSource ? (
        /* ========================================================== */
        /* CASE 1: Genuine 16:9 Landscape Backdrop                     */
        /* ========================================================== */
        <View style={[styles.canvasLayer, { height: canvasHeight }]} pointerEvents="none">
          <Image
            key={backdropSource}
            source={{ uri: backdropSource }}
            style={styles.fullImage}
            resizeMode="cover"
          />

          {/* Bottom gentle gradient: transparent over most of image, dissolves at row level */}
          <LinearGradient
            colors={['transparent', 'rgba(10, 10, 14, 0.4)', '#0A0A0E']}
            locations={[0, 0.65, 1]}
            style={styles.bottomGradient}
          />

          {/* Left horizontal vignette: protects metadata contrast without blacking out right side */}
          <LinearGradient
            colors={['rgba(10, 10, 14, 0.96)', 'rgba(10, 10, 14, 0.7)', 'transparent']}
            locations={[0, 0.42, 0.85]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.leftGradient}
          />
        </View>
      ) : posterSource ? (
        /* ========================================================== */
        /* CASE 2: Client-Side Fallback (Dynamic 3-Layer Canvas)      */
        /* ========================================================== */
        <View style={[styles.canvasLayer, { height: canvasHeight }]} pointerEvents="none">
          {/* Layer 1: The Blurred Fill (centerCrop + heavy blur + 45% tint) */}
          <Image
            key={`blur-${posterSource}`}
            source={{ uri: posterSource }}
            style={styles.fullImage}
            resizeMode="cover"
            blurRadius={28}
          />
          <View style={styles.blurDarkTint} />

          {/* Layer 2: The Crisp Anchor (unblurred original poster centered/right) */}
          <View style={styles.crispAnchorContainer}>
            <Image
              key={`crisp-${posterSource}`}
              source={{ uri: posterSource }}
              style={styles.crispPosterImage}
              resizeMode="contain"
            />
          </View>

          {/* Layer 3: The UI Gradient Scrims */}
          <LinearGradient
            colors={['rgba(10, 10, 14, 0.98)', 'rgba(10, 10, 14, 0.75)', 'transparent']}
            locations={[0, 0.45, 0.82]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.leftGradient}
          />
          <LinearGradient
            colors={['transparent', 'rgba(10, 10, 14, 0.5)', '#0A0A0E']}
            locations={[0, 0.7, 1]}
            style={styles.bottomGradient}
          />
        </View>
      ) : null}

      {/* Top-Left Metadata Block */}
      <View style={styles.contentWrapper}>
        <Text numberOfLines={1} style={styles.title}>
          {media?.title || ''}
        </Text>

        {media?.subtitle ? (
          <Text numberOfLines={1} style={styles.subtitle}>
            {media.subtitle}
          </Text>
        ) : null}

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

        <Text numberOfLines={4} style={styles.overview}>
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
    height: 300,
    position: 'relative',
    backgroundColor: '#0A0A0E',
    justifyContent: 'flex-start',
    paddingTop: 18,
  },
  canvasLayer: {
    // Height is set inline per-render to the window height (see
    // `canvasHeight` above) so the backdrop reaches the true bottom of the
    // screen instead of stopping at a fixed dp value.
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    overflow: 'hidden',
  },
  fullImage: {
    width: '100%',
    height: '100%',
    position: 'absolute',
    top: 0,
    right: 0,
  },
  blurDarkTint: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(10, 10, 14, 0.45)',
  },
  crispAnchorContainer: {
    position: 'absolute',
    top: 10,
    right: 70,
    width: 280,
    height: 410,
    justifyContent: 'center',
    alignItems: 'center',
  },
  crispPosterImage: {
    width: '100%',
    height: '100%',
  },
  bottomGradient: {
    ...StyleSheet.absoluteFillObject,
  },
  leftGradient: {
    ...StyleSheet.absoluteFillObject,
    width: '80%',
  },
  contentWrapper: {
    position: 'absolute',
    top: 20,
    // Was hardcoded to 88, calibrated back when the row content below it sat
    // at a ~156px total inset (72 rail reserve + 84 row padding). Now that
    // the row padding is trimmed to 20 (92 total), this needs to match so
    // the title/synopsis stay flush with the content underneath instead of
    // sitting well to the right of it.
    left: 20,
    maxWidth: 620,
    zIndex: 10,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 32,
    fontWeight: '900',
    letterSpacing: -0.4,
    marginBottom: 6,
    textShadowColor: 'rgba(0, 0, 0, 0.95)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 6,
  },
  subtitle: {
    color: '#D1D5DB',
    fontSize: 16,
    fontWeight: '700',
    marginTop: -2,
    marginBottom: 8,
    textShadowColor: 'rgba(0, 0, 0, 0.95)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 6,
  },
  metaText: {
    color: '#FFFFFF',
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
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '500',
  },
  overview: {
    color: '#FFFFFF',
    fontSize: 13,
    lineHeight: 18,
    // Narrower than the 620dp `contentWrapper` cap so the synopsis wraps
    // into more, shorter rows instead of stretching a single very wide
    // line across a big chunk of the screen -- the title/badges above can
    // still use the full contentWrapper width, only the paragraph text
    // itself is narrowed.
    maxWidth: 460,
    textShadowColor: 'rgba(0, 0, 0, 0.95)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  castText: {
    color: '#DDE00B',
    fontSize: 12,
    fontWeight: '600',
    marginTop: 4,
    maxWidth: 460,
    textShadowColor: 'rgba(0, 0, 0, 0.95)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 6,
  },
});
