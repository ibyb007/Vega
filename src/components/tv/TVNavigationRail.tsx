import React, { useState, useRef, useEffect } from 'react';
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
  onRegisterHomeHandle?: (handle: number | null) => void;
}

const NAV_ITEMS: { id: TVRoute; label: string; icon: keyof typeof MaterialCommunityIcons.glyphMap }[] = [
  { id: 'search', label: 'Search', icon: 'magnify' },
  { id: 'home', label: 'Home', icon: 'home-variant' },
  { id: 'discover', label: 'Discover', icon: 'compass-outline' },
  { id: 'sources', label: 'Sources', icon: 'database-outline' },
  { id: 'addons', label: 'Addons', icon: 'puzzle-outline' },
  { id: 'settings', label: 'Settings', icon: 'cog-outline' },
];

const COLLAPSED_WIDTH = 68;
const EXPANDED_WIDTH = 220;
const ITEM_HEIGHT = 46;
const ITEM_GAP = 6;

export const TVNavigationRail: React.FC<TVNavigationRailProps> = ({
  currentRoute,
  onRouteChange,
  onRegisterHomeHandle,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const blurTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const homeRef = useRef<View>(null);

  const activeIndex = NAV_ITEMS.findIndex((it) => it.id === currentRoute);
  const indicatorY = useSharedValue(
    (activeIndex !== -1 ? activeIndex : 1) * (ITEM_HEIGHT + ITEM_GAP)
  );

  useEffect(() => {
    if (homeRef.current) {
      const handle = findNodeHandle(homeRef.current);
      if (handle && onRegisterHomeHandle) {
        onRegisterHomeHandle(handle);
      }
    }
  }, [onRegisterHomeHandle]);

  useEffect(() => {
    const idx = NAV_ITEMS.findIndex((it) => it.id === currentRoute);
    if (idx !== -1) {
      indicatorY.value = withTiming(idx * (ITEM_HEIGHT + ITEM_GAP), {
        duration: 180,
        easing: Easing.out(Easing.quad),
      });
    }
  }, [currentRoute, indicatorY]);

  const handleItemFocus = (index: number) => {
    if (blurTimeoutRef.current) {
      clearTimeout(blurTimeoutRef.current);
      blurTimeoutRef.current = null;
    }
    setIsExpanded(true);
    indicatorY.value = withTiming(index * (ITEM_HEIGHT + ITEM_GAP), {
      duration: 160,
      easing: Easing.out(Easing.quad),
    });
  };

  const handleItemBlur = () => {
    if (blurTimeoutRef.current) {
      clearTimeout(blurTimeoutRef.current);
    }
    blurTimeoutRef.current = setTimeout(() => {
      setIsExpanded(false);
      const activeIdx = NAV_ITEMS.findIndex((it) => it.id === currentRoute);
      if (activeIdx !== -1) {
        indicatorY.value = withTiming(activeIdx * (ITEM_HEIGHT + ITEM_GAP), {
          duration: 180,
          easing: Easing.out(Easing.quad),
        });
      }
    }, 140);
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
      {/* Brand Header */}
      <View style={styles.header}>
        <MaterialCommunityIcons name="play-circle" size={30} color="#8A5CF6" />
        {isExpanded && <Text style={styles.brandText}>VEGA TV</Text>}
      </View>

      {/* Navigation List with Single Sliding Pill */}
      <View style={styles.menuContainer}>
        {/* Continuous Stremio-Style Sliding Pill */}
        <Animated.View style={[styles.slidingPill, indicatorStyle]} />

        {NAV_ITEMS.map((item, index) => {
          const isActive = currentRoute === item.id;

          return (
            <View
              key={item.id}
              ref={item.id === 'home' ? homeRef : undefined}
              collapsable={false}
            >
              <TVFocusablePressable
                scaleFocused={1}
                focusedBorderColor="transparent"
                borderRadius={10}
                onFocusChange={(focused) => {
                  if (focused) handleItemFocus(index);
                  else handleItemBlur();
                }}
                onPress={() => onRouteChange(item.id)}
                style={styles.navItem}
              >
                {({ focused }) => (
                  <View style={styles.itemInner}>
                    <MaterialCommunityIcons
                      name={item.icon}
                      size={22}
                      color={focused || isActive ? '#FFFFFF' : '#6B7280'}
                    />
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
            </View>
          );
        })}
      </View>
    </Animated.View>
  );
};

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
    paddingHorizontal: 14,
    zIndex: 1,
  },
  itemInner: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  itemLabel: {
    fontSize: 14,
    marginLeft: 14,
  },
});
