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
// component's fail-safe timeout: if `onEnd`/`onError` never fire for
// whatever reason (a codec hiccup, a fast-refresh remount mid-playback in
// dev), don't leave this covering the app forever.
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

  const finish = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    onAnimationEnd();
  }, [onAnimationEnd]);

  // Deliberately NOT called on mount. Mounting this component doesn't
  // mean the video decoder has produced a visible frame yet -- hiding the
  // native splash before that would show a black flash in the gap between
  // "native splash gone" and "video actually painting". `onReadyForDisplay`
  // is react-native-video's callback for "first frame is on screen now",
  // which is the actual moment the handoff is safe.
  const handleReadyForDisplay = useCallback(() => {
    BootSplash.hide({ fade: false }).catch(() => {});
  }, []);

  // If the video source fails to load entirely, still get the native
  // splash off screen (don't leave the user stuck on it) and close out.
  const handleError = useCallback(() => {
    BootSplash.hide({ fade: false }).catch(() => {});
    finish();
  }, [finish]);

  useEffect(() => {
    const failSafe = setTimeout(finish, FAIL_SAFE_MS);
    return () => clearTimeout(failSafe);
  }, [finish]);

  return (
    // StyleSheet.absoluteFillObject (position/edges) is what keeps this a
    // true full-screen overlay regardless of where it's mounted in
    // App.tsx's flex tree -- without it this becomes a flex sibling again
    // and gets squeezed by whatever else is in that column, which is
    // exactly what caused the last two bugs. elevation/zIndex are a
    // belt-and-suspenders on top of that for Android's paint order.
    <Video
      ref={videoRef}
      source={splashSource}
      style={[StyleSheet.absoluteFillObject, styles.overlay]}
      resizeMode={ResizeMode.COVER}
      muted
      repeat={false}
      paused={false}
      controls={false}
      onReadyForDisplay={handleReadyForDisplay}
      onEnd={finish}
      onError={handleError}
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
