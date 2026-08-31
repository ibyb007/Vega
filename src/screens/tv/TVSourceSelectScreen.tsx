import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Modal,
  ToastAndroid,
} from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { TVFocusablePressable } from '../../components/tv/TVFocusablePressable';
import useContentStore from '../../lib/zustand/contentStore';
import useThemeStore from '../../lib/zustand/themeStore';
import { Provider } from '../../lib/providers/types';

interface TVSourceSelectScreenProps {
  onNavigateHome?: () => void;
  onNavigateAddons?: () => void;
}

export const TVSourceSelectScreen: React.FC<TVSourceSelectScreenProps> = ({
  onNavigateHome,
  onNavigateAddons,
}) => {
  const primaryColor = useThemeStore((state) => state.primaryColor) || '#8A5CF6';
  const provider = useContentStore((state) => state.provider);
  const setProvider = useContentStore((state) => state.setProvider);
  const installedProviders = useContentStore((state) => state.installedProviders);
  const setInstalledProviders = useContentStore((state) => state.setInstalledProviders);

  const [providerToDelete, setProviderToDelete] = useState<Provider | null>(null);

  const handleSelectProvider = (item: Provider) => {
    setProvider(item);
    ToastAndroid.show(`Active source: ${item.displayTitle || item.name}`, ToastAndroid.SHORT);
    if (onNavigateHome) {
      onNavigateHome();
    }
  };

  const handleConfirmDelete = () => {
    if (!providerToDelete) return;
    const remaining = installedProviders.filter((p) => p.value !== providerToDelete.value);
    setInstalledProviders(remaining);

    if (provider?.value === providerToDelete.value) {
      setProvider(remaining.length > 0 ? remaining[0] : null);
    }

    ToastAndroid.show(`Removed ${providerToDelete.displayTitle || providerToDelete.name}`, ToastAndroid.SHORT);
    setProviderToDelete(null);
  };

  return (
    <View style={styles.container}>
      {/* Top Header */}
      <View style={styles.headerRow}>
        <View style={styles.headerTitles}>
          <Text style={styles.headerTitle}>Select Provider Source</Text>
          <Text style={styles.headerSubtitle}>
            Choose which provider supplies the catalog and stream links on your Home Screen
          </Text>
        </View>

        {onNavigateAddons && (
          <TVFocusablePressable
            scaleFocused={1.05}
            focusedBorderColor="#FFFFFF"
            borderRadius={12}
            onPress={onNavigateAddons}
            style={[styles.addonsButton, { backgroundColor: primaryColor }]}
          >
            {() => (
              <View style={styles.btnInner}>
                <MaterialCommunityIcons name="puzzle-outline" size={20} color="#FFFFFF" />
                <Text style={styles.addonsButtonText}>Add / Manage Addons</Text>
              </View>
            )}
          </TVFocusablePressable>
        )}
      </View>

      {/* Grid of Installed Providers */}
      {installedProviders.length === 0 ? (
        <View style={styles.emptyState}>
          <MaterialCommunityIcons name="cloud-search-outline" size={64} color="#6B7280" />
          <Text style={styles.emptyTitle}>No Cloud Providers Installed</Text>
          <Text style={styles.emptyDescription}>
            You haven't installed any provider extensions yet. Go to the Addons tab to add a source repository.
          </Text>
          {onNavigateAddons && (
            <TVFocusablePressable
              hasTVPreferredFocus={true}
              scaleFocused={1.06}
              focusedBorderColor="#8A5CF6"
              borderRadius={12}
              onPress={onNavigateAddons}
              style={[styles.emptyActionBtn, { backgroundColor: primaryColor }]}
            >
              {() => (
                <View style={styles.btnInner}>
                  <MaterialCommunityIcons name="download" size={20} color="#FFFFFF" />
                  <Text style={styles.emptyActionBtnText}>Install Providers Now</Text>
                </View>
              )}
            </TVFocusablePressable>
          )}
        </View>
      ) : (
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.scrollGrid}
        >
          {installedProviders.map((item, index) => {
            const isSelected = provider?.value === item.value;

            return (
              <TVFocusablePressable
                key={`${item.value}-${index}`}
                hasTVPreferredFocus={isSelected || index === 0}
                scaleFocused={1.03}
                focusedBorderColor={primaryColor}
                borderRadius={16}
                onPress={() => handleSelectProvider(item)}
                style={[
                  styles.card,
                  isSelected && {
                    backgroundColor: 'rgba(138, 92, 246, 0.14)',
                    borderColor: primaryColor,
                  },
                ]}
              >
                {() => (
                  <View style={styles.cardInner}>
                    <View style={styles.cardHeader}>
                      <View style={[styles.avatar, isSelected && { backgroundColor: primaryColor }]}>
                        <MaterialCommunityIcons
                          name="server-network"
                          size={24}
                          color={isSelected ? '#FFFFFF' : '#9CA3AF'}
                        />
                      </View>

                      <View style={styles.headerBadges}>
                        {isSelected && (
                          <View style={[styles.activeTag, { backgroundColor: primaryColor }]}>
                            <MaterialCommunityIcons name="check" size={12} color="#FFFFFF" />
                            <Text style={styles.activeTagText}>Active</Text>
                          </View>
                        )}

                        <TVFocusablePressable
                          scaleFocused={1.1}
                          focusedBorderColor="#EF4444"
                          borderRadius={8}
                          onPress={() => setProviderToDelete(item)}
                          style={styles.deleteIconBtn}
                        >
                          {({ focused: deleteFocused }) => (
                            <MaterialCommunityIcons
                              name="trash-can-outline"
                              size={18}
                              color={deleteFocused ? '#EF4444' : '#6B7280'}
                            />
                          )}
                        </TVFocusablePressable>
                      </View>
                    </View>

                    <View style={styles.cardBody}>
                      <Text numberOfLines={1} style={styles.providerName}>
                        {item.displayTitle || item.name}
                      </Text>
                      <Text numberOfLines={1} style={styles.providerMeta}>
                        v{item.version || '1.0.0'} • {item.type || 'global'}
                      </Text>
                    </View>

                    <View style={styles.cardFooter}>
                      <Text style={[styles.footerText, isSelected && { color: primaryColor, fontWeight: '700' }]}>
                        {isSelected ? 'Loaded on Home Screen' : 'Press OK to Switch'}
                      </Text>
                    </View>
                  </View>
                )}
              </TVFocusablePressable>
            );
          })}
        </ScrollView>
      )}

      {/* Delete Confirmation Modal */}
      <Modal
        visible={Boolean(providerToDelete)}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setProviderToDelete(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <MaterialCommunityIcons name="alert-circle-outline" size={40} color="#EF4444" />
            <Text style={styles.modalTitle}>Remove Provider</Text>
            <Text style={styles.modalText}>
              Are you sure you want to remove {providerToDelete?.displayTitle || providerToDelete?.name}?
            </Text>

            <View style={styles.modalActions}>
              <TVFocusablePressable
                hasTVPreferredFocus={true}
                scaleFocused={1.05}
                focusedBorderColor="#8A5CF6"
                borderRadius={10}
                onPress={() => setProviderToDelete(null)}
                style={styles.cancelBtn}
              >
                {() => <Text style={styles.cancelBtnText}>Cancel</Text>}
              </TVFocusablePressable>

              <TVFocusablePressable
                scaleFocused={1.05}
                focusedBorderColor="#FFFFFF"
                borderRadius={10}
                onPress={handleConfirmDelete}
                style={styles.deleteBtn}
              >
                {() => <Text style={styles.deleteBtnText}>Uninstall</Text>}
              </TVFocusablePressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0E',
    paddingLeft: 88, // Inset past the collapsed navigation rail
    paddingRight: 48,
    paddingTop: 32,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 24,
  },
  headerTitles: {
    flex: 1,
    marginRight: 16,
  },
  headerTitle: {
    color: '#FFFFFF',
    fontSize: 26,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  headerSubtitle: {
    color: '#9CA3AF',
    fontSize: 14,
    marginTop: 4,
  },
  addonsButton: {
    paddingVertical: 12,
    paddingHorizontal: 18,
  },
  addonsButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  btnInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  scrollGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 18,
    paddingBottom: 40,
  },
  card: {
    width: 255,
    height: 165,
    backgroundColor: '#16161E',
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    padding: 16,
  },
  cardInner: {
    flex: 1,
    justifyContent: 'space-between',
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerBadges: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  activeTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
  },
  activeTagText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
  },
  deleteIconBtn: {
    padding: 6,
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
  },
  cardBody: {
    marginVertical: 4,
  },
  providerName: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  providerMeta: {
    color: '#9CA3AF',
    fontSize: 12,
    marginTop: 2,
  },
  cardFooter: {
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.06)',
    paddingTop: 8,
  },
  footerText: {
    color: '#6B7280',
    fontSize: 12,
    fontWeight: '500',
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingBottom: 80,
  },
  emptyTitle: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '700',
    marginTop: 16,
  },
  emptyDescription: {
    color: '#9CA3AF',
    fontSize: 14,
    textAlign: 'center',
    maxWidth: 480,
    marginTop: 8,
    lineHeight: 22,
    marginBottom: 24,
  },
  emptyActionBtn: {
    paddingVertical: 14,
    paddingHorizontal: 24,
  },
  emptyActionBtnText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.85)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalBox: {
    width: 440,
    backgroundColor: '#16161E',
    borderRadius: 18,
    padding: 24,
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  modalTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
    marginTop: 12,
  },
  modalText: {
    color: '#9CA3AF',
    fontSize: 14,
    textAlign: 'center',
    marginTop: 8,
    marginBottom: 24,
    lineHeight: 20,
  },
  modalActions: {
    flexDirection: 'row',
    gap: 12,
    width: '100%',
    justifyContent: 'center',
  },
  cancelBtn: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    paddingVertical: 10,
    paddingHorizontal: 20,
  },
  cancelBtnText: {
    color: '#D1D5DB',
    fontSize: 14,
    fontWeight: '600',
  },
  deleteBtn: {
    backgroundColor: '#EF4444',
    paddingVertical: 10,
    paddingHorizontal: 20,
  },
  deleteBtnText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
});
