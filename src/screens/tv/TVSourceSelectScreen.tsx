import React from 'react';
import { View, Text, StyleSheet, ScrollView, Image } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { TVFocusablePressable } from '../../components/tv/TVFocusablePressable';
import useContentStore from '../../lib/zustand/contentStore';
import { Provider } from '../../lib/providers/types';

interface TVSourceSelectScreenProps {
  onNavigateHome?: () => void;
  onNavigateAddons?: () => void;
}

export const TVSourceSelectScreen: React.FC<TVSourceSelectScreenProps> = ({
  onNavigateHome,
  onNavigateAddons,
}) => {
  const provider = useContentStore((state) => state.provider);
  const setProvider = useContentStore((state) => state.setProvider);
  const installedProviders = useContentStore((state) => state.installedProviders) || [];

  const handleSelectProvider = (item: Provider) => {
    setProvider(item);
    if (onNavigateHome) {
      onNavigateHome();
    }
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
              hasTVPreferredFocus={true}
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
          contentContainerStyle={styles.gridContainer}
        >
          {installedProviders.map((item: any, index: number) => {
            const isSelected = provider?.value === item.value;
            const displayName = item.displayTitle || item.name || item.value || `Source ${index + 1}`;
            const version = item.version ? `v${item.version}` : 'v1.0.0';
            const author = item.author || 'global';

            return (
              <TVFocusablePressable
                key={`${item.value}-${index}`}
                hasTVPreferredFocus={isSelected || index === 0}
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
  gridContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 20,
    paddingBottom: 40,
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
