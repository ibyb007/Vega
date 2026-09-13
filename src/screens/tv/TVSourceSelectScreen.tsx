import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Image, Dimensions, findNodeHandle } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { TVFocusablePressable } from '../../components/tv/TVFocusablePressable';
import { registerRailLeftEdge } from '../../lib/tv/registerRailLeftEdge';
import { useTVEntryFocus } from '../../lib/tv/useTVEntryFocus';
import useContentStore from '../../lib/zustand/contentStore';
import { Provider } from '../../lib/providers/types';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
// Trimmed from 96 -- see TVDiscoverScreen.tsx's identical constant for why.
const CONTAINER_PADDING_LEFT = 20;
const CONTAINER_PADDING_RIGHT = 48;
const CARD_WIDTH = 250;
const GRID_GAP = 20;

const GRID_COLUMNS = Math.max(
  1,
  Math.floor(
    (SCREEN_WIDTH - CONTAINER_PADDING_LEFT - CONTAINER_PADDING_RIGHT + GRID_GAP) /
      (CARD_WIDTH + GRID_GAP)
  )
);

interface TVSourceSelectScreenProps {
  onNavigateHome?: () => void;
  onNavigateAddons?: () => void;
  onRegisterEntryHandleGetter?: (getter: (() => number | null) | null) => void;
  onRegisterReturnFocusTrigger?: (trigger: (() => void) | null) => void;
}

// Module-level so it survives this screen unmounting when the user leaves
// the Sources tab and comes back -- same pattern as TVHomeScreen's
// `lastFocusedKey`.
let lastFocusedSourcesKey: string | null = null;

export const TVSourceSelectScreen: React.FC<TVSourceSelectScreenProps> = ({
  onNavigateHome,
  onNavigateAddons,
  onRegisterEntryHandleGetter,
  onRegisterReturnFocusTrigger,
}) => {
  const { setItemRef, keyFor, shouldPreferFocus } = useTVEntryFocus(
    () => lastFocusedSourcesKey,
    onRegisterEntryHandleGetter,
    onRegisterReturnFocusTrigger
  );
  const provider = useContentStore((state) => state.provider);
  const setProvider = useContentStore((state) => state.setProvider);
  const secondaryProvider = useContentStore((state) => state.secondaryProvider);
  const setSecondaryProvider = useContentStore((state) => state.setSecondaryProvider);
  const installedProviders = useContentStore((state) => state.installedProviders) || [];

  // Native node handle of the "Add / Manage Addons" button, captured once
  // it mounts (see its ref callback below) so the top row of provider
  // cards -- and the empty-state "Install Providers" CTA -- can wire an
  // explicit nextFocusUp to it. Without this, Android's default geometric
  // focus search sometimes prefers the nav rail's own Search button over
  // this pill when pressing Up from the top row: the rail sits closer in
  // both x and y even though "Add / Manage Addons" is the button that's
  // actually directly above with nothing else in between.
  const [manageAddonsHandle, setManageAddonsHandle] = useState<number | null>(null);

  // No local back-stack on this screen — Back is handled centrally by
  // App.tsx, which moves focus to the Sources button on the rail.

  const handleSelectProvider = (item: Provider) => {
    setProvider(item);
    if (onNavigateHome) {
      onNavigateHome();
    }
  };

  const secondaryChoices = installedProviders.filter(
    (item: any) => item.value !== provider?.value,
  );

  const handleSelectSecondaryProvider = (item: Provider) => {
    setSecondaryProvider(secondaryProvider?.value === item.value ? null : item);
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.headerTitle}>Select Provider Source</Text>
          <Text style={styles.headerSubtitle}>
            Choose which provider supplies the catalog and stream links on your Home Screen
          </Text>
        </View>

        {onNavigateAddons && (
          <TVFocusablePressable
            key={keyFor('manage-addons-btn')}
            ref={(el) => {
              setItemRef('manage-addons-btn', el);
              // The header title beside this button isn't focusable, so
              // Left from here has nothing else to land on within the
              // screen -- it should always reach the Sources rail button.
              if (el) registerRailLeftEdge('sources', el);
              const tag = el ? findNodeHandle(el) : null;
              if (tag != null) setManageAddonsHandle(tag);
            }}
            hasTVPreferredFocus={shouldPreferFocus('manage-addons-btn', false)}
            onFocus={() => (lastFocusedSourcesKey = 'manage-addons-btn')}
            scaleFocused={1.05}
            focusedBorderColor="#8A5CF6"
            borderRadius={12}
            onPress={onNavigateAddons}
            style={styles.manageBtn}
          >
            {() => (
              <View style={styles.btnInner}>
                <MaterialCommunityIcons name="puzzle-outline" size={20} color="#FFFFFF" />
                <Text style={styles.manageBtnText}>Add / Manage Addons</Text>
              </View>
            )}
          </TVFocusablePressable>
        )}
      </View>

      {/* Installed Providers List */}
      {installedProviders.length === 0 ? (
        <View style={styles.emptyContainer}>
          <MaterialCommunityIcons name="cloud-off-outline" size={72} color="#4B5563" />
          <Text style={styles.emptyText}>No Providers Installed</Text>
          <Text style={styles.emptySubtext}>
            Head over to the Addons tab to install a provider extension first.
          </Text>
          {onNavigateAddons && (
            <TVFocusablePressable
              key={keyFor('install-now-btn')}
              ref={(el) => {
                setItemRef('install-now-btn', el);
                if (el) registerRailLeftEdge('sources', el);
              }}
              hasTVPreferredFocus={shouldPreferFocus('install-now-btn', true)}
              onFocus={() => (lastFocusedSourcesKey = 'install-now-btn')}
              nextFocusUp={manageAddonsHandle ?? undefined}
              scaleFocused={1.06}
              focusedBorderColor="#FFFFFF"
              borderRadius={12}
              onPress={onNavigateAddons}
              style={styles.installNowBtn}
            >
              {() => (
                <View style={styles.btnInner}>
                  <MaterialCommunityIcons name="download" size={20} color="#FFFFFF" />
                  <Text style={styles.installNowText}>Install Providers</Text>
                </View>
              )}
            </TVFocusablePressable>
          )}
        </View>
      ) : (
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.pageScrollContent}
        >
          <View style={styles.gridContainer}>
            {installedProviders.map((item: any, index: number) => {
              const isSelected = provider?.value === item.value;
              const displayName = item.displayTitle || item.name || item.value || `Source ${index + 1}`;
              const version = item.version ? `v${item.version}` : 'v1.0.0';
              const author = item.author || 'global';
              const cardKey = `provider-${item.value}-${index}`;

              return (
                <TVFocusablePressable
                  key={keyFor(cardKey)}
                  ref={(el) => {
                    setItemRef(cardKey, el);
                    if (index % GRID_COLUMNS === 0 && el) {
                      registerRailLeftEdge('sources', el);
                    }
                  }}
                  hasTVPreferredFocus={shouldPreferFocus(cardKey, isSelected || index === 0)}
                  onFocus={() => (lastFocusedSourcesKey = cardKey)}
                  // Only the first row has nothing else above it -- rows
                  // below correctly fall back to Android's default search,
                  // which finds the row above just fine.
                  nextFocusUp={index < GRID_COLUMNS ? manageAddonsHandle ?? undefined : undefined}
                  scaleFocused={1.04}
                  focusedBorderColor="#8A5CF6"
                  borderRadius={16}
                  onPress={() => handleSelectProvider(item)}
                  style={[
                    styles.providerCard,
                    isSelected && styles.providerCardSelected,
                  ]}
                >
                  {({ focused }) => (
                    <View style={styles.cardContent}>
                      <View style={styles.cardTop}>
                        <View
                          style={[
                            styles.iconCircle,
                            isSelected && styles.iconCircleSelected,
                          ]}
                        >
                          {item.icon ? (
                            <Image
                              source={{ uri: item.icon }}
                              style={styles.providerIconImage}
                              resizeMode="contain"
                            />
                          ) : (
                            <MaterialCommunityIcons
                              name="server"
                              size={28}
                              color={isSelected || focused ? '#8A5CF6' : '#9CA3AF'}
                            />
                          )}
                        </View>
                        {isSelected ? (
                          <View style={styles.activePill}>
                            <MaterialCommunityIcons name="check" size={14} color="#FFFFFF" />
                            <Text style={styles.activePillText}>Active</Text>
                          </View>
                        ) : null}
                      </View>

                      <View style={styles.cardMiddle}>
                        <Text numberOfLines={1} style={styles.providerTitle}>
                          {displayName}
                        </Text>
                        <Text numberOfLines={1} style={styles.providerDetails}>
                          {version} • {author}
                        </Text>
                      </View>

                      <Text style={[styles.actionHint, isSelected && styles.actionHintActive]}>
                        {isSelected ? 'Loaded on Home Screen' : 'Press OK to Switch'}
                      </Text>
                    </View>
                  )}
                </TVFocusablePressable>
              );
            })}
          </View>

          {/* Secondary Source (fills the bottom rows on Home) */}
          {secondaryChoices.length > 0 && (
            <View style={styles.secondarySection}>
              <Text style={styles.secondaryHeading}>2nd Source (optional)</Text>
              <Text style={styles.secondarySubheading}>
                Adds a second addon's catalog to the bottom of your Home Screen, below{' '}
                {provider?.display_name || 'the primary source'}
              </Text>

              <View style={styles.chipRow}>
                <TVFocusablePressable
                  key={keyFor('secondary-none')}
                  ref={(el) => {
                    setItemRef('secondary-none', el);
                    // Fixed first chip in this row -- another left-edge row
                    // on this screen, below the main provider grid.
                    if (el) registerRailLeftEdge('sources', el);
                  }}
                  hasTVPreferredFocus={shouldPreferFocus('secondary-none', false)}
                  onFocus={() => (lastFocusedSourcesKey = 'secondary-none')}
                  scaleFocused={1.05}
                  focusedBorderColor="#8A5CF6"
                  borderRadius={16}
                  onPress={() => setSecondaryProvider(null)}
                  style={[
                    styles.secondaryChip,
                    !secondaryProvider && styles.secondaryChipSelected,
                  ]}
                >
                  {() => (
                    <Text
                      style={[
                        styles.secondaryChipText,
                        !secondaryProvider && styles.secondaryChipTextSelected,
                      ]}
                    >
                      None
                    </Text>
                  )}
                </TVFocusablePressable>

                {secondaryChoices.map((item: any) => {
                  const isSelected = secondaryProvider?.value === item.value;
                  const displayName =
                    item.displayTitle || item.name || item.display_name || item.value;
                  const chipKey = `secondary-${item.value}`;
                  return (
                    <TVFocusablePressable
                      key={keyFor(chipKey)}
                      ref={(el) => setItemRef(chipKey, el)}
                      hasTVPreferredFocus={shouldPreferFocus(chipKey, false)}
                      onFocus={() => (lastFocusedSourcesKey = chipKey)}
                      scaleFocused={1.05}
                      focusedBorderColor="#8A5CF6"
                      borderRadius={16}
                      onPress={() => handleSelectSecondaryProvider(item)}
                      style={[
                        styles.secondaryChip,
                        isSelected && styles.secondaryChipSelected,
                      ]}
                    >
                      {() => (
                        <Text
                          style={[
                            styles.secondaryChipText,
                            isSelected && styles.secondaryChipTextSelected,
                          ]}
                          numberOfLines={1}
                        >
                          {displayName}
                        </Text>
                      )}
                    </TVFocusablePressable>
                  );
                })}
              </View>
            </View>
          )}
        </ScrollView>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0E',
    paddingLeft: 96,
    paddingRight: 48,
    paddingTop: 36,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 32,
  },
  headerTitle: {
    color: '#FFFFFF',
    fontSize: 26,
    fontWeight: '800',
  },
  headerSubtitle: {
    color: '#9CA3AF',
    fontSize: 14,
    marginTop: 4,
  },
  manageBtn: {
    backgroundColor: '#8A5CF6',
    paddingVertical: 12,
    paddingHorizontal: 18,
  },
  manageBtnText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  btnInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  pageScrollContent: {
    paddingBottom: 40,
  },
  gridContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 20,
  },
  secondarySection: {
    marginTop: 36,
    paddingTop: 24,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.08)',
  },
  secondaryHeading: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '800',
  },
  secondarySubheading: {
    color: '#9CA3AF',
    fontSize: 13,
    marginTop: 4,
    marginBottom: 16,
    maxWidth: 640,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  secondaryChip: {
    backgroundColor: '#16161E',
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 16,
    paddingHorizontal: 18,
    paddingVertical: 12,
    maxWidth: 220,
  },
  secondaryChipSelected: {
    backgroundColor: '#1E1B2E',
    borderColor: '#8A5CF6',
  },
  secondaryChipText: {
    color: '#D1D5DB',
    fontSize: 14,
    fontWeight: '600',
  },
  secondaryChipTextSelected: {
    color: '#8A5CF6',
    fontWeight: '700',
  },
  providerCard: {
    width: 250,
    height: 165,
    backgroundColor: '#16161E',
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    padding: 16,
  },
  providerCardSelected: {
    backgroundColor: '#1E1B2E',
    borderColor: '#8A5CF6',
  },
  cardContent: {
    flex: 1,
    justifyContent: 'space-between',
  },
  cardTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  iconCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  iconCircleSelected: {
    backgroundColor: 'rgba(138, 92, 246, 0.15)',
  },
  providerIconImage: {
    width: 32,
    height: 32,
    borderRadius: 6,
  },
  activePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#8A5CF6',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
  },
  activePillText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
  },
  cardMiddle: {
    marginVertical: 4,
  },
  providerTitle: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '700',
  },
  providerDetails: {
    color: '#9CA3AF',
    fontSize: 12,
    marginTop: 3,
  },
  actionHint: {
    color: '#6B7280',
    fontSize: 12,
    fontWeight: '500',
  },
  actionHintActive: {
    color: '#8A5CF6',
    fontWeight: '600',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingBottom: 80,
  },
  emptyText: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '700',
    marginTop: 16,
  },
  emptySubtext: {
    color: '#9CA3AF',
    fontSize: 14,
    marginTop: 6,
    marginBottom: 24,
  },
  installNowBtn: {
    backgroundColor: '#8A5CF6',
    paddingVertical: 14,
    paddingHorizontal: 22,
  },
  installNowText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
});

export default TVSourceSelectScreen;
