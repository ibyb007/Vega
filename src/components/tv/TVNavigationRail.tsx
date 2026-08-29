import React, { useState } from 'react';
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
const EXPANDED_WIDTH = 210;

export const TVNavigationRail: React.FC<TVNavigationRailProps> = ({
  currentRoute,
  onRouteChange,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);

  const containerStyle = useAnimatedStyle(() => {
    return {
      width: withTiming(isExpanded ? EXPANDED_WIDTH : COLLAPSED_WIDTH, {
        duration: 220,
        easing: Easing.out(Easing.cubic),
      }),
      backgroundColor: withTiming(
        isExpanded ? 'rgba(15, 15, 20, 0.96)' : 'rgba(10, 10, 14, 0.5)',
        { duration: 200 }
      ),
    };
  }, [isExpanded]);

  return (
    <Animated.View style={[styles.container, containerStyle]}>
      {/* Brand Logo Header */}
      <View style={styles.header}>
        <MaterialCommunityIcons name="play-circle" size={32} color="#8A5CF6" />
        {isExpanded && <Text style={styles.brandText}>VEGA TV</Text>}
      </View>

      {/* Navigation Options */}
      <View style={styles.menuContainer}>
        {NAV_ITEMS.map((item) => {
          const isActive = currentRoute === item.id;
          return (
            <TVFocusablePressable
              key={item.id}
              scaleFocused={1.02}
              focusedBorderColor="#8A5CF6"
              borderRadius={10}
              onFocusChange={(focused) => {
                if (focused) setIsExpanded(true);
              }}
              onBlur={() => {
                setTimeout(() => setIsExpanded(false), 80);
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
    zIndex: 100,
    paddingVertical: 24,
    paddingHorizontal: 12,
    borderRightWidth: 1,
    borderRightColor: 'rgba(255, 255, 255, 0.08)',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 32,
    paddingHorizontal: 6,
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
    gap: 8,
  },
  navItem: {
    paddingVertical: 12,
    paddingHorizontal: 10,
    marginVertical: 2,
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
