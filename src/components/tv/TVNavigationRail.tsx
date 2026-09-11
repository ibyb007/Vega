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
  onRegisterRouteHandle?: (route: TVRoute, handle: number | null) => void;
  onRegisterHomeHandle?: (handle: number | null) => void;
  onRegisterDiscoverHandle?: (handle: number | null) => void;
  onRequestContentFocus?: (route: TVRoute) => void;
  onGetEntryFocusHandle?: (route: TVRoute) => number | null;
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

export interface TVNavigationRailHandle {
  focusRoute: (route: TVRoute) => void;
}

export const TVNavigationRail = forwardRef<TVNavigationRailHandle, TVNavigationRailProps>(({
  currentRoute,
  onRouteChange,
  onRegisterRouteHandle,
  onRegisterHomeHandle,
  onRegisterDiscoverHandle,
  onRequestContentFocus,
  onGetEntryFocusHandle,
  onExpandedChange,
}, ref) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const blurTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const focusDepthRef = useRef(0);
  const itemRefs = useRef<(View | null)[]>([]);

  useImperativeHandle(ref, () => ({
    focusRoute: (route: TVRoute) => {
      const idx = NAV_ITEMS.findIndex((it) => it.id === route);
      const node = itemRefs.current[idx] as any;
      node?.focus?.();
    },
  }));

  useEffect(() => {
    onExpandedChange?.(isExpanded);
  }, [isExpanded, onExpandedChange]);

  useEffect(() => {
    return () => {
      onExpandedChange?.(false);
    };
  }, []);

  const activeIndex = NAV_ITEMS.findIndex((it) => it.id === currentRoute);
  const indicatorY = useSharedValue(
    (activeIndex !== -1 ? activeIndex : 1) * (ITEM_HEIGHT + ITEM_GAP)
  );

  useEffect(() => {
    NAV_ITEMS.forEach((item, index) => {
      const node = itemRefs.current[index];
      const handle = node ? findNodeHandle(node) : null;
      onRegisterRouteHandle?.(item.id, handle);
      if (item.id === 'home') onRegisterHomeHandle?.(handle);
      if (item.id === 'discover') onRegisterDiscoverHandle?.(handle);
    });
  }, [onRegisterRouteHandle, onRegisterHomeHandle, onRegisterDiscoverHandle]);

  useEffect(() => {
    const idx = NAV_ITEMS.findIndex((it) => it.id === currentRoute);
    if (idx !== -1) {
      indicatorY.value = withTiming(idx * (ITEM_HEIGHT + ITEM_GAP), {
        duration: 140,
        easing: Easing.out(Easing.quad),
      });
    }
  }, [currentRoute, indicatorY]);

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
      duration: 130,
      easing: Easing.out(Easing.quad),
    });

    const item = NAV_ITEMS[index];
    if (item && item.id === currentRoute && onGetEntryFocusHandle) {
      const handle = onGetEntryFocusHandle(item.id);
      const node = itemRefs.current[index] as any;
      if (handle != null && node?.setNativeProps) {
        node.setNativeProps({ nextFocusRight: handle });
      }
    }
  };

  const scheduleCollapse = (settledRoute: TVRoute) => {
    if (blurTimeoutRef.current) {
      clearTimeout(blurTimeoutRef.current);
    }
    blurTimeoutRef.current = setTimeout(() => {
      blurTimeoutRef.current = null;
      if (focusDepthRef.current > 0) return;
      setIsExpanded(false);
      const idx = NAV_ITEMS.findIndex((it) => it.id === settledRoute);
      if (idx !== -1) {
        indicatorY.value = withTiming(idx * (ITEM_HEIGHT + ITEM_GAP), {
          duration: 140,
          easing: Easing.out(Easing.quad),
        });
      }
    }, 110);
  };

  const handleItemBlur = () => {
    focusDepthRef.current = Math.max(0, focusDepthRef.current - 1);
    scheduleCollapse(currentRoute);
  };

  const handleItemSelect = (route: TVRoute) => {
    focusDepthRef.current = 0;
    scheduleCollapse(route);
    if (route === currentRoute) {
      onRequestContentFocus?.(route);
    } else {
      onRouteChange(route);
    }
  };

  const containerStyle = useAnimatedStyle(() => {
    return {
      width: withTiming(isExpanded ? EXPANDED_WIDTH : COLLAPSED_WIDTH, {
        duration: 140,
        easing: Easing.out(Easing.quad),
      }),
      backgroundColor: withTiming(
        isExpanded ? '#111116' : 'rgba(10, 10, 14, 0.95)',
        { duration: 140 }
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
