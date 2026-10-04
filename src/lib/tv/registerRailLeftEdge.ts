import { findNodeHandle } from 'react-native';
import { NavRail, TVRoute } from '../native/NavRail';

/**
 * Call this from the `onFocus` handler of any item that sits at a screen's
 * left edge -- the first card in a horizontal row, the first column of a
 * grid, the first pill in a horizontal chip bar, etc.
 *
 * Why this is needed rather than relying on Android's default geometric
 * focus search: horizontal `ScrollView`s intercept LEFT/RIGHT at their own
 * scroll boundary to decide whether to scroll further, before default
 * focus-search ever gets a chance to look for a focusable sibling outside
 * that ScrollView (the nav rail lives outside every one of these). Explicit
 * `nextFocusLeftId` wiring is the only reliable way out, and the native rail
 * (see TVNavRailView.kt#registerRouteTarget) always points that link at
 * whichever view was most recently registered for the given route -- so
 * calling this on every left-edge focus keeps it pointed at the item the
 * user is actually sitting on, not just wherever the screen happened to
 * mount. It doubles as the rail's Right-key/re-select entry point for the
 * same reason: resume focus where the user left off, not the screen's
 * initial default.
 *
 * Safe to call on every relevant focus event -- it's a single one-way
 * bridge write, not a re-render.
 */
export function registerRailLeftEdge(route: TVRoute, node: unknown) {
  const tag = findNodeHandle(node as any);
  if (tag != null) {
    NavRail.registerRouteHandleTag(route, tag);
  }
}
