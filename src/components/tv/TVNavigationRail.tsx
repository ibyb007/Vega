import React, { useState, useRef } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import Animated, {
  useAnimatedStyle,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import { TVFocusablePressable } from './TVFocusablePressable';

export type TVRoute = 'home' | 'search' | 'discover' | 'sources' | 'addons' | 'settings';

interface TVNavigationRailProps {
  currentRoute: TVRoute;
  onRouteChange: (route: TVRoute) => void;
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

export const TVNavigationRail: React.FC<TVNavigationRailProps> = ({
  currentRoute,
  onRouteChange,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const blurTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const handleItemFocus = () => {
    if (blurTimeoutRef.current) {
      clearTimeout(blurTimeoutRef.current);
      blurTimeoutRef.current = null;
    }
    setIsExpanded(true);
  };

  const handleItemBlur = () => {
    if (blurTimeoutRef.current) {
      clearTimeout(blurTimeoutRef.current);
    }
    blurTimeoutRef.current = setTimeout(() => {
      setIsExpanded(false);
    }, 120);
  };

  const containerStyle = useAnimatedStyle(() => {
    return {
      width: withTiming(isExpanded ? EXPANDED_WIDTH : COLLAPSED_WIDTH, {
        duration: 180,
        easing: Easing.out(Easing.quad),
      }),
      backgroundColor: withTiming(
        isExpanded ? '#111116' : '#0A0A0E',
        { duration: 180 }
      ),
    };
  }, [isExpanded]);

  return (
    <Animated.View style={[styles.container, containerStyle]}>
      <View style={styles.header}>
        <MaterialCommunityIcons name="play-circle" size={32} color="#8A5CF6" />
        {isExpanded && <Text style={styles.brandText}>VEGA TV</Text>}
      </View>

      <View style={styles.menuContainer}>
        {NAV_ITEMS.map((item) => {
          const isActive = currentRoute === item.id;
          return (
            <TVFocusablePressable
              key={item.id}
              scaleFocused={1.03}
              focusedBorderColor="#8A5CF6"
              borderRadius={12}
              onFocusChange={(focused) => {
                if (focused) handleItemFocus();
                else handleItemBlur();
              }}
              onPress={() => onRouteChange(item.id)}
              style={[
                styles.navItem,
                isActive && !isExpanded && styles.activeItemCollapsed,
                isActive && isExpanded && styles.activeItemExpanded,
              ]}
            >
              {({ focused }) => (
                <View style={styles.itemInner}>
                  <MaterialCommunityIcons
                    name={item.icon}
                    size={24}
                    color={focused || isActive ? '#FFFFFF' : '#9CA3AF'}
                  />
                  {isExpanded && (
                    <Text
                      numberOfLines={1}
                      style={[
                        styles.itemLabel,
                        { color: focused || isActive ? '#FFFFFF' : '#9CA3AF' },
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
};

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    zIndex: 9999, // Render on top of everything
    paddingVertical: 24,
    paddingHorizontal: 8,
    borderRightWidth: 1,
    borderRightColor: 'rgba(255, 255, 255, 0.08)',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 28,
    paddingHorizontal: 6,
    height: 36,
  },
  brandText: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '800',
    marginLeft: 12,
    letterSpacing: 1.2,
  },
  menuContainer: {
    flex: 1,
    gap: 6,
  },
  navItem: {
    paddingVertical: 12,
    paddingHorizontal: 10,
    marginVertical: 1,
  },
  itemInner: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  itemLabel: {
    fontSize: 15,
    fontWeight: '600',
    marginLeft: 14,
  },
  activeItemCollapsed: {
    backgroundColor: 'rgba(138, 92, 246, 0.25)',
  },
  activeItemExpanded: {
    backgroundColor: 'rgba(138, 92, 246, 0.35)',
  },
});
