import { NativeModules, NativeEventEmitter, EmitterSubscription } from 'react-native';

const { NavRailModule } = NativeModules as {
  NavRailModule?: {
    setActiveRoute(route: string): void;
    focusRoute(route: string): void;
    setVisible(visible: boolean): void;
    registerRouteHandle(route: string, reactTag: number): void;
    clearRouteHandle(route: string): void;
    addListener(eventName: string): void;
    removeListeners(count: number): void;
  };
};

export type TVRoute = 'home' | 'search' | 'discover' | 'sources' | 'addons' | 'settings';

const emitter = NavRailModule ? new NativeEventEmitter(NavRailModule as any) : null;

/**
 * JS-side face of the native nav rail (see native-src/android/com/vega/
 * TVNavRailView.kt + NavRailModule.kt). The rail itself is no longer a React
 * component -- it lives directly in the Activity's view hierarchy as a real
 * sibling of the ReactRootView. This module is just the thin two-way seam:
 * a handful of imperative calls out, three events back in.
 *
 * `available` is false on iOS / any build where the native module isn't
 * linked yet -- every method below is a safe no-op in that case so JS code
 * doesn't need to branch on it everywhere.
 */
export const NavRail = {
  available: !!NavRailModule,

  setActiveRoute(route: TVRoute) {
    NavRailModule?.setActiveRoute(route);
  },

  focusRoute(route: TVRoute) {
    NavRailModule?.focusRoute(route);
  },

  setVisible(visible: boolean) {
    NavRailModule?.setVisible(visible);
  },

  /** `tag` is a React node handle, e.g. `findNodeHandle(someRef.current)`. */
  registerRouteHandleTag(route: TVRoute, tag: number | null) {
    if (tag != null) {
      NavRailModule?.registerRouteHandle(route, tag);
    } else {
      NavRailModule?.clearRouteHandle(route);
    }
  },

  clearRouteHandle(route: TVRoute) {
    NavRailModule?.clearRouteHandle(route);
  },

  onRouteChanged(cb: (route: TVRoute) => void): EmitterSubscription | undefined {
    return emitter?.addListener('NavRail:onRouteChanged', (e: { route: TVRoute }) => cb(e.route));
  },

  onRouteReselected(cb: (route: TVRoute) => void): EmitterSubscription | undefined {
    return emitter?.addListener('NavRail:onRouteReselected', (e: { route: TVRoute }) => cb(e.route));
  },

  onExpandedChanged(cb: (expanded: boolean) => void): EmitterSubscription | undefined {
    return emitter?.addListener('NavRail:onExpandedChanged', (e: { expanded: boolean }) => cb(e.expanded));
  },
};

// Matches TVNavRailView.COLLAPSED_WIDTH_DP in the native code. Kept as a
// separate JS constant (rather than queried from native) so layout effects
// stay synchronous; if you ever change one, change the other.
export const NATIVE_RAIL_COLLAPSED_WIDTH = 72;
