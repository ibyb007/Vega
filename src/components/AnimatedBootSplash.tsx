import React, { useCallback, useEffect, useRef } from 'react';
import { StyleSheet } from 'react-native';
import Video, { ResizeMode, VideoRef } from 'react-native-video';
import BootSplash from 'react-native-bootsplash';

// This is the one thing that has to line up: splash.mp4's own FIRST FRAME
// needs to be a pixel match for the static native splash (same banner/
// background) so BootSplash.hide() below can swap the native layer out
// for this video with no visible jump. Everything after that first frame
// -- the logo/wordmark reveal itself -- is baked into the clip's own
// pixels, which is the whole point of this rewrite: the old version tried
// to reverse-engineer react-native-bootsplash's internal logo layout
// (`logo.style.top`) to position an overlaid text reveal by hand, and that
// math broke (twice) because it depended on values the hook never
// actually guaranteed. A pre-rendered clip has nothing left to keep in
// sync in JS -- no logo/text position math, no hand-tuned stagger timing.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const splashSource = require('../../assets/bootsplash/splash.mp4');

// Buffer above splash.mp4's real (sub-2s) length. Same purpose as the old
// component's fail-safe timeout: if `onEnd` never fires for whatever
// reason (a codec hiccup, a fast-refresh remount mid-playback in dev),
// don't leave this covering the app forever.
const FAIL_SAFE_MS = 4000;

type Props = {
  onAnimationEnd: () => void;
};

/**
 * Renders on top of the (already-visible) native boot splash the instant
 * JS is ready, plays splash.mp4 once, then hands control back to the app
 * (which has been mounting/fetching behind this overlay the whole time --
 * see AnimatedBootSplash's usage in App.tsx).
 */
const AnimatedBootSplash: React.FC<Props> = ({ onAnimationEnd }) => {
  const videoRef = useRef<VideoRef>(null);
  const finishedRef = useRef(false);
  const hiddenRef = useRef(false);

  // Idempotent by design (react-native-bootsplash no-ops if already
  // hidden), so every path below -- mount, ready, error, fail-safe -- can
  // safely call this without worrying about double-hiding.
  const hideNativeSplash = useCallback(() => {
    if (hiddenRef.current) return;
    hiddenRef.current = true;
    BootSplash.hide({ fade: false }).catch(() => {});
  }, []);

  const finish = useCallback(() => {
    // Always hide the native splash on the way out, no matter which path
    // got us here -- this was the actual bug last time: the fail-safe
    // path called onAnimationEnd() but never hide(), so if the video
    // never fired a ready callback, the native splash silently stayed on
    // screen forever (above this component, so its own video was never
    // even visible, just hidden underneath it).
    hideNativeSplash();
    if (finishedRef.current) return;
    finishedRef.current = true;
    onAnimationEnd();
  }, [hideNativeSplash, onAnimationEnd]);

  // Called on mount rather than waiting on a video callback. This IS the
  // fix: `onReadyForDisplay` wasn't firing reliably here, and since this
  // overlay's own background (below) already matches the native splash's
  // background color 1:1, there's nothing to gain by waiting for it --
  // worst case is a solid black frame for a few ms before the video's
  // first frame paints, which is visually identical to the native splash
  // that was already showing.
  useEffect(() => {
    hideNativeSplash();
  }, [hideNativeSplash]);

  useEffect(() => {
    const failSafe = setTimeout(finish, FAIL_SAFE_MS);
    return () => clearTimeout(failSafe);
  }, [finish]);

  return (
    // StyleSheet.absoluteFillObject (position/edges) is what keeps this a
    // true full-screen overlay regardless of where it's mounted in
    // App.tsx's flex tree -- without it this becomes a flex sibling again
    // and gets squeezed by whatever else is in that column, which is
    // exactly what caused an earlier bug. elevation/zIndex are a
    // belt-and-suspenders on top of that for Android's paint order.
    // backgroundColor matches manifest.json's "background": "#000000" so
    // any gap before the video's first frame paints is invisible.
    <Video
      ref={videoRef}
      source={splashSource}
      style={[StyleSheet.absoluteFillObject, styles.overlay]}
      resizeMode={ResizeMode.COVER}
      muted
      repeat={false}
      paused={false}
      controls={false}
      onEnd={finish}
      onError={finish}
    />
  );
};

const styles = StyleSheet.create({
  overlay: {
    backgroundColor: '#000000',
    elevation: 999,
    zIndex: 999,
  },
});

export default AnimatedBootSplash;
