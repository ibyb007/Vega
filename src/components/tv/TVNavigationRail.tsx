import React, { useState, useRef, useEffect, forwardRef, useImperativeHandle } from 'react';
import { View, Text, StyleSheet, findNodeHandle } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import Animated, {
  useAnimatedStyle,
  withTiming,
  Easing,
  useSharedValue,
} from 'react-native-reanimated';
import { TVFocusablePressable } from './TVFocusablePressable';

export type TVRoute = 'home' | 'search' | 'discover' | 'sources' | 'addons' | 'settings';

interface TVNavigationRailProps {
  currentRoute: TVRoute;
  onRouteChange: (route: TVRoute) => void;
  // Fires once per nav item (not just Home) with its native node handle, so
  // every screen can point its leftmost/first-column focusables back at
  // *its own* rail button via `nextFocusLeft` -- previously only Home's
  // handle was ever exposed, so pressing Left from the leftmost content on
  // any other tab fell back to Android's default nearest-neighbor search,
  // which happened to land on Home instead of that tab's own button.
  onRegisterRouteHandle?: (route: TVRoute, handle: number | null) => void;
  // Called when the user presses OK/select on the rail button for the tab
  // they're *already* on. Routing to the same route again is a no-op (see
  // `handleItemSelect`), which used to leave focus stranded on the rail
  // button -- pressing Right happened to fall through to Android's default
  // focus search and land back in the content, but OK had nothing
  // equivalent to fall back on. The screen forces a fresh mount of itself
  // for its route (see TVHomeScreen/App.tsx), which naturally restores
  // focus via its own `hasTVPreferredFocus` logic, and this is how the
  // rail asks for that.
  onRequestContentFocus?: (route: TVRoute) => void;
  // Synchronously fetches the native node handle of whichever card the
  // given route's content last had focus on, or null if unknown. Used to
  // keep the active route's rail button pointed at that exact card via
  // `nextFocusRight` -- refreshed right when the button gains focus, since
  // which card that is can change many times while the user browses
  // without the rail re-rendering at all.
  onGetEntryFocusHandle?: (route: TVRoute) => number | null;
  // Fires whenever the rail's expanded/collapsed state changes (i.e.
  // whether any rail button currently holds focus). Lets the app-level
  // hardware Back handler tell "focus is on the rail itself" apart from
  // "focus is in a tab's content", since Back should behave differently
  // (exit the app) in the former case regardless of which button is
  // focused.
  onExpandedChange?: (expanded: boolean) => void;
}

const NAV_ITEMS: { id: TVRoute; label: string; icon: keyof typeof MaterialCommunityIcons.glyphMap }[] = [
  { id: 'search', label: 'Search', icon: 'magnify' },
  { id: 'home', label: 'Home', icon: 'home-variant' },
  { id: 'discover', label: 'Discover', icon: 'compass-outline' },
  { id: 'sources', label: 'Sources', icon: 'database-outline' },
  { id: 'addons', label: 'Addons', icon: 'puzzle-outline' },
  { id: 'settings', label: 'Settings', icon: 'cog-outline' },
];

const COLLAPSED_WIDTH = 72;
const EXPANDED_WIDTH = 220;
const ITEM_HEIGHT = 46;
const ITEM_GAP = 6;

// Imperative handle exposed via ref, so a screen-level concern (like the
// hardware Back key while on a given tab's content) can move native TV
// focus onto that tab's own rail button without going through a
// declarative nextFocus* prop -- Back isn't a directional key, so there's
// no focus-search edge for it to hook into the way Left/Right do.
export interface TVNavigationRailHandle {
  focusRoute: (route: TVRoute) => void;
}

export const TVNavigationRail = forwardRef<TVNavigationRailHandle, TVNavigationRailProps>(({
  currentRoute,
  onRouteChange,
  onRegisterRouteHandle,
  onRequestContentFocus,
  onGetEntryFocusHandle,
  onExpandedChange,
}, ref) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const blurTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // How many rail items currently report themselves as focused. Normally
  // this is 0 or 1, but a blur for the previously-focused item and a focus
  // for the newly-focused one aren't guaranteed to arrive in that order --
  // Android's focus dispatch can deliver focus(new) before blur(old). With
  // a plain boolean, that ordering used to let the *old* item's delayed
  // collapse timeout fire 140ms later and yank the rail shut (or leave the
  // width/label state disagreeing with each other) even though a different
  // item was still legitimately focused. Counting depth and re-checking it
  // inside the timeout makes the collapse decision immune to that ordering.
  const focusDepthRef = useRef(0);
  // Must point at the focusable Pressable itself (not an inner decorative
  // View) -- see the comment in TVFocusablePressable for why.
  const itemRefs = useRef<(View | null)[]>([]);

  useImperativeHandle(ref, () => ({
    focusRoute: (route: TVRoute) => {
      const idx = NAV_ITEMS.findIndex((it) => it.id === route);
      if (idx === -1) return;

      // This is called synchronously from the hardware Back key handler
      // (BackHandler's 'hardwareBackPress' listener) -- i.e. from *inside*
      // Android's dispatch of that very key event. Calling node.focus()
      // in that same tick is unreliable on Android TV/Fire TV: the native
      // focus engine is still mid-key-event and can silently ignore an
      // imperative focus request that arrives before it's settled. A
      // single requestAnimationFrame defer isn't always enough either --
      // how long the native side takes to settle varies by device. So
      // this fires the same focus() call at several increasing delays
      // (next frame, then a couple of short timeouts). Calling .focus()
      // again on a node that's already focused is a harmless no-op, so
      // stacking attempts like this is safe -- it just means whichever
      // attempt is the first to land after native focus has settled is
      // the one that actually takes effect.
      const attemptFocus = () => {
        (itemRefs.current[idx] as any)?.focus?.();
      };

      attemptFocus();
      requestAnimationFrame(attemptFocus);
      setTimeout(attemptFocus, 50);
      setTimeout(attemptFocus, 150);
    },
  }));

  useEffect(() => {
    onExpandedChange?.(isExpanded);
  }, [isExpanded, onExpandedChange]);

  // Guards against the parent holding a stale "expanded" reading if this
  // component ever unmounts while still expanded (e.g. a screen transition
  // that yanks the rail out from under a focused button).
  useEffect(() => {
    return () => {
      onExpandedChange?.(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeIndex = NAV_ITEMS.findIndex((it) => it.id === currentRoute);
  const indicatorY = useSharedValue(
    (activeIndex !== -1 ? activeIndex : 1) * (ITEM_HEIGHT + ITEM_GAP)
  );

  useEffect(() => {
    if (!onRegisterRouteHandle) return;
    NAV_ITEMS.forEach((item, index) => {
      const node = itemRefs.current[index];
      const handle = node ? findNodeHandle(node) : null;
      onRegisterRouteHandle(item.id, handle);
    });
  }, [onRegisterRouteHandle]);

  useEffect(() => {
    const idx = NAV_ITEMS.findIndex((it) => it.id === currentRoute);
    if (idx !== -1) {
      indicatorY.value = withTiming(idx * (ITEM_HEIGHT + ITEM_GAP), {
        duration: 180,
        easing: Easing.out(Easing.quad),
      });
    }
  }, [currentRoute, indicatorY]);

  // Any pending collapse must never fire after this component (or this
  // particular mount of it) is gone -- guards the same class of stale-timer
  // issue described above for the unmount case.
  useEffect(() => {
    return () => {
      if (blurTimeoutRef.current) {
        clearTimeout(blurTimeoutRef.current);
        blurTimeoutRef.current = null;
      }
    };
  }, []);

  const handleItemFocus = (index: number) => {
    focusDepthRef.current += 1;
    if (blurTimeoutRef.current) {
      clearTimeout(blurTimeoutRef.current);
      blurTimeoutRef.current = null;
    }
    setIsExpanded(true);
    indicatorY.value = withTiming(index * (ITEM_HEIGHT + ITEM_GAP), {
      duration: 160,
      easing: Easing.out(Easing.quad),
    });

    // If this is the button for the tab the user is already on, refresh
    // its Right-key target to whichever card that screen's content last
    // had focus on. Applied imperatively via setNativeProps (the same
    // direct-manipulation API `nextFocusLeft` ultimately goes through)
    // rather than as a render prop, because the right answer can change on
    // every poster the user focuses while browsing -- long before they
    // ever arrow over to this button -- and nothing here re-renders for
    // that. Without this, Right fell back to Android's default
    // nearest-neighbor search, which always landed on the same nearest
    // card regardless of where the user actually came from.
    const item = NAV_ITEMS[index];
    if (item && item.id === currentRoute && onGetEntryFocusHandle) {
      const handle = onGetEntryFocusHandle(item.id);
      const node = itemRefs.current[index] as any;
      if (handle != null && node?.setNativeProps) {
        node.setNativeProps({ nextFocusRight: handle });
      }
    }
  };

  // Schedules the collapse-back-to-narrow animation, landing the indicator
  // on `settledRoute` once it actually fires. Shared by the real blur path
  // and the "user just selected a route" path below, since both end with
  // the same "wait a beat, then collapse if nothing is focused" behavior.
  const scheduleCollapse = (settledRoute: TVRoute) => {
    if (blurTimeoutRef.current) {
      clearTimeout(blurTimeoutRef.current);
    }
    blurTimeoutRef.current = setTimeout(() => {
      blurTimeoutRef.current = null;
      // Re-check rather than trusting that this timeout is still the only
      // thing that could decide the collapsed state -- if another item
      // focused in the meantime (even if its focus event arrived before
      // this blur did), depth will be > 0 here and we leave the rail alone.
      if (focusDepthRef.current > 0) return;
      setIsExpanded(false);
      const idx = NAV_ITEMS.findIndex((it) => it.id === settledRoute);
      if (idx !== -1) {
        indicatorY.value = withTiming(idx * (ITEM_HEIGHT + ITEM_GAP), {
          duration: 180,
          easing: Easing.out(Easing.quad),
        });
      }
    }, 140);
  };

  const handleItemBlur = () => {
    focusDepthRef.current = Math.max(0, focusDepthRef.current - 1);
    scheduleCollapse(currentRoute);
  };

  // Pressing a rail item always means focus is about to move into that
  // tab's content -- but we can't count on a real blur event ever arriving
  // for it. When the newly-selected screen mounts a poster/row with
  // `hasTVPreferredFocus`, Android sometimes hands that view focus directly
  // without dispatching a blur on the rail button that was just pressed
  // (this is the case that was slipping through before: select Home from
  // another tab, then immediately arrow through posters -- the rail never
  // got the blur it was waiting on, so it stayed expanded-but-desynced
  // until something else, like opening a details screen, remounted it).
  // Treating "selected" itself as a guaranteed blur closes that gap: the
  // collapse gets scheduled unconditionally the moment the user commits to
  // leaving the rail, instead of depending on an event that may not come.
  const handleItemSelect = (route: TVRoute) => {
    focusDepthRef.current = 0;
    scheduleCollapse(route);
    if (route === currentRoute) {
      // Already on this tab -- routing again would be a no-op and leave
      // focus stuck on this button. Hand focus back into the content
      // instead, same intent as pressing Right, but targeted at the exact
      // card the screen last had focused.
      onRequestContentFocus?.(route);
    } else {
      onRouteChange(route);
    }
  };

  const containerStyle = useAnimatedStyle(() => {
    return {
      width: withTiming(isExpanded ? EXPANDED_WIDTH : COLLAPSED_WIDTH, {
        duration: 180,
        easing: Easing.out(Easing.quad),
      }),
      backgroundColor: withTiming(
        isExpanded ? '#111116' : 'rgba(10, 10, 14, 0.95)',
        { duration: 180 }
      ),
    };
  }, [isExpanded]);

  const indicatorStyle = useAnimatedStyle(() => {
    return {
      transform: [{ translateY: indicatorY.value }],
    };
  });

  return (
    <Animated.View style={[styles.container, containerStyle]}>
      <View style={styles.header}>
        <MaterialCommunityIcons name="play-circle" size={30} color="#8A5CF6" />
        {isExpanded && <Text style={styles.brandText}>VEGA TV</Text>}
      </View>

      <View style={styles.menuContainer}>
        {/* Continuous sliding pill */}
        <Animated.View style={[styles.slidingPill, indicatorStyle]} />

        {NAV_ITEMS.map((item, index) => {
          const isActive = currentRoute === item.id;

          return (
            <TVFocusablePressable
              key={item.id}
              ref={(el) => {
                itemRefs.current[index] = el;
              }}
              scaleFocused={1}
              focusedBorderColor="transparent"
              borderRadius={10}
              onFocusChange={(focused) => {
                if (focused) handleItemFocus(index);
                else handleItemBlur();
              }}
              onPress={() => handleItemSelect(item.id)}
              style={styles.navItem}
            >
              {({ focused }) => (
                <View collapsable={false} style={styles.itemInner}>
                  <View style={styles.itemIconBox}>
                    <MaterialCommunityIcons
                      name={item.icon}
                      size={22}
                      color={focused || isActive ? '#FFFFFF' : '#6B7280'}
                    />
                  </View>
                  {isExpanded && (
                    <Text
                      numberOfLines={1}
                      style={[
                        styles.itemLabel,
                        {
                          color: focused || isActive ? '#FFFFFF' : '#9CA3AF',
                          fontWeight: isActive ? '800' : '600',
                        },
                      ]}
                    >
                      {item.label}
                    </Text>
                  )}
                </View>
              )}
            </TVFocusablePressable>
          );
        })}
      </View>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    zIndex: 9999,
    paddingVertical: 20,
    paddingHorizontal: 8,
    borderRightWidth: 1,
    borderRightColor: 'rgba(255, 255, 255, 0.06)',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 26,
    paddingHorizontal: 10,
    height: 36,
  },
  brandText: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '800',
    marginLeft: 12,
    letterSpacing: 1,
  },
  menuContainer: {
    flex: 1,
    position: 'relative',
    gap: ITEM_GAP,
  },
  slidingPill: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: ITEM_HEIGHT,
    backgroundColor: '#8A5CF6',
    borderRadius: 10,
    zIndex: 0,
  },
  navItem: {
    height: ITEM_HEIGHT,
    justifyContent: 'center',
    paddingHorizontal: 12,
    zIndex: 1,
  },
  itemInner: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  // Fixed, centered box around each glyph. MaterialCommunityIcons is a font
  // icon, and a few glyphs (e.g. "compass-outline") have off-center advance
  // widths that were getting clipped against the right edge of the
  // collapsed rail when the icon sat directly against the item's padding
  // with no room to breathe. Centering it in its own box -- independent of
  // the exact collapsed rail width -- fixes that regardless of which glyph
  // is rendered.
  itemIconBox: {
    width: 26,
    height: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  itemLabel: {
    fontSize: 14,
    marginLeft: 14,
  },
});
