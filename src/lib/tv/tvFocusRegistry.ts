// A minimal registry that lets a screen's leftmost row item find its way
// back to the currently active nav-rail button when the D-pad LEFT key is
// pressed.
//
// Why this is needed: Android's native HorizontalScrollView intercepts
// LEFT/RIGHT key events at its own scroll boundary (to decide whether to
// scroll further) before React Native's default geometric focus-search
// ever gets a chance to look for a focusable sibling outside the
// ScrollView. That means the first poster in a horizontal row can never
// reach the nav rail (which lives outside that ScrollView) just by
// relying on default focus search, no matter how close it is visually.
//
// Setting the `nextFocusLeft` native prop explicitly bypasses that native
// scroll-capture entirely, so the rail registers its currently active
// button's node handle here, and any row's first item reads it back.
//
// This is a tiny pub/sub (not just a plain module variable) so that a
// consumer using `useActiveRailFocusHandle()` re-renders as soon as the
// rail registers a handle -- otherwise a screen that mounts before the
// rail's own effect has run would permanently bake in `undefined` as its
// `nextFocusLeft` and never pick up the real handle once it exists.
import { useEffect, useState } from 'react';

let activeRailHandle: number | null = null;
const listeners = new Set<(handle: number | null) => void>();

export const setActiveRailFocusHandle = (handle: number | null) => {
  activeRailHandle = handle;
  listeners.forEach((listener) => listener(handle));
};

export const getActiveRailFocusHandle = (): number | undefined => {
  return activeRailHandle ?? undefined;
};

export const useActiveRailFocusHandle = (): number | undefined => {
  const [handle, setHandle] = useState<number | null>(activeRailHandle);

  useEffect(() => {
    listeners.add(setHandle);
    // Pick up any value registered between initial render and this effect.
    setHandle(activeRailHandle);
    return () => {
      listeners.delete(setHandle);
    };
  }, []);

  return handle ?? undefined;
};
