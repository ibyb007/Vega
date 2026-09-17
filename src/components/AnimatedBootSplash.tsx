import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Image, StyleSheet, Text, View } from 'react-native';
import BootSplash from 'react-native-bootsplash';

import manifest from '../../assets/bootsplash/manifest.json';
// This is the "White" launcher-color variant -- the default look for
// anyone who hasn't changed their launcher icon color in Settings -- so
// the handoff below is pixel-identical to what the native splash was
// already showing. See assets/bootsplash/android/drawable-*/bootsplash_
// logo_{variant}.png for the other launcher-color recolors; matching one
// of those instead per the user's saved icon choice is a nice future
// improvement but isn't needed for the "no visible jump" guarantee below,
// since this only has to line up with the *default* boot theme.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const logoSource = require('../../assets/bootsplash/logo.png');

const WORDMARK = 'VEGA TV';

// How long the reveal takes before the whole splash fades away. Tuned to
// feel like a deliberate brand beat rather than a wait: this time overlaps
// whatever the app was already going to spend on its own startup work
// (provider init, first screen's data fetch, etc. all keep running behind
// this overlay the entire time -- see AnimatedBootSplash's usage in
// App.tsx), it doesn't add to it. The native splash already occupies the
// screen for some baseline amount of time on every cold start regardless
// of this component; this just gives that unavoidable window a proper
// animated handoff instead of an instant, jarring cut to a static logo.
const LOGO_IN_MS = 320;
const LETTER_STAGGER_MS = 70;
const LETTER_IN_MS = 240;
const HOLD_MS = 320;
const FADE_OUT_MS = 380;

type Props = {
  onAnimationEnd: () => void;
};

/**
 * Renders on top of the (already-visible) native boot splash the instant JS
 * is ready, using react-native-bootsplash's useHideAnimation so the initial
 * frame is pixel-identical to what the native layer was already showing --
 * the native splash is swapped out for this exact same image with zero
 * visible jump -- then plays a one-shot "VEGA TV" letter-by-letter reveal
 * on top of it before fading out and handing control back to the app
 * (which has been mounting/fetching behind this overlay the whole time).
 */
const AnimatedBootSplash: React.FC<Props> = ({ onAnimationEnd }) => {
  const containerOpacity = useRef(new Animated.Value(1)).current;
  const logoOpacity = useRef(new Animated.Value(0)).current;
  const logoScale = useRef(new Animated.Value(0.85)).current;

  const letters = useMemo(() => WORDMARK.split(''), []);
  const letterAnims = useRef(letters.map(() => new Animated.Value(0))).current;

  const { container, logo } = BootSplash.useHideAnimation({
    manifest,
    logo: logoSource,

    animate: () => {
      Animated.sequence([
        Animated.parallel([
          Animated.timing(logoOpacity, {
            toValue: 1,
            duration: LOGO_IN_MS,
            useNativeDriver: true,
          }),
          Animated.spring(logoScale, {
            toValue: 1,
            useNativeDriver: true,
            friction: 6,
            tension: 80,
          }),
        ]),
        Animated.stagger(
          LETTER_STAGGER_MS,
          letterAnims.map((value) =>
            Animated.timing(value, {
              toValue: 1,
              duration: LETTER_IN_MS,
              useNativeDriver: true,
            })
          )
        ),
        Animated.delay(HOLD_MS),
        Animated.timing(containerOpacity, {
          toValue: 0,
          duration: FADE_OUT_MS,
          useNativeDriver: true,
        }),
      ]).start(() => {
        onAnimationEnd();
      });
    },
  });

  // Safety net: if anything above ever throws before `start`'s completion
  // callback fires (e.g. a fast-refresh remount mid-animation in dev),
  // don't leave the splash stuck covering the app forever.
  useEffect(() => {
    const failSafe = setTimeout(
      onAnimationEnd,
      LOGO_IN_MS + letters.length * LETTER_STAGGER_MS + LETTER_IN_MS + HOLD_MS + FADE_OUT_MS + 1500
    );
    return () => clearTimeout(failSafe);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Animated.View {...container} style={[container.style, { opacity: containerOpacity }]}>
      <Animated.Image
        {...logo}
        style={[
          logo.style,
          {
            opacity: logoOpacity,
            transform: [{ scale: logoScale }],
          },
        ]}
      />

      <View
        style={[
          styles.wordmarkRow,
          {
            // Sits directly under the logo box the hook positioned above,
            // regardless of screen size -- computed from the same manifest
            // dimensions it used, not a guessed fixed offset.
            top:
              (typeof logo.style?.top === 'number' ? logo.style.top : 0) +
              (typeof logo.style?.height === 'number' ? logo.style.height : manifest.logo.height) +
              24,
          },
        ]}
      >
        {letters.map((letter, index) => {
          const anim = letterAnims[index];
          return (
            <Animated.Text
              key={`${letter}-${index}`}
              style={[
                styles.letter,
                letter === ' ' ? styles.letterSpace : null,
                {
                  opacity: anim,
                  transform: [
                    {
                      translateY: anim.interpolate({
                        inputRange: [0, 1],
                        outputRange: [14, 0],
                      }),
                    },
                  ],
                },
              ]}
            >
              {letter}
            </Animated.Text>
          );
        })}
      </View>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  wordmarkRow: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
  },
  letter: {
    color: '#FFFFFF',
    fontSize: 28,
    fontWeight: '800',
    letterSpacing: 1,
  },
  letterSpace: {
    width: 12,
  },
});

export default AnimatedBootSplash;
