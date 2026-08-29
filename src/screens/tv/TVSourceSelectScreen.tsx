import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Modal,
  TextInput,
  ActivityIndicator,
} from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { TVFocusablePressable } from '../../components/tv/TVFocusablePressable';
import useContentStore from '../../lib/zustand/contentStore';
import { Provider } from '../../lib/providers/types';
import { updateProvidersService } from '../../lib/services/UpdateProviders';

interface TVSourceSelectScreenProps {
  onSelectSource?: (provider: Provider) => void;
  onNavigateHome?: () => void;
}

export const TVSourceSelectScreen: React.FC<TVSourceSelectScreenProps> = ({
  onSelectSource,
  onNavigateHome,
}) => {
  const provider = useContentStore((state) => state.provider);
  const setProvider = useContentStore((state) => state.setProvider);
  const installedProviders = useContentStore((state) => state.installedProviders);

  const [isModalVisible, setIsModalVisible] = useState(false);
  const [sourceInput, setSourceInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const handleSelectProvider = (item: Provider) => {
    setProvider(item);
    if (onSelectSource) {
      onSelectSource(item);
    }
    if (onNavigateHome) {
      onNavigateHome();
    }
  };

  const handleInstallSource = async () => {
    const trimmed = sourceInput.trim();
    if (!trimmed) return;

    setIsLoading(true);
    setStatusMessage(null);
    try {
      await updateProvidersService.addProviderByUrl(trimmed);
      setStatusMessage('Provider installed successfully!');
      setSourceInput('');
      setTimeout(() => {
        setIsModalVisible(false);
        setStatusMessage(null);
      }, 1000);
    } catch (err: any) {
      setStatusMessage(err?.message || 'Failed to install provider');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      {/* Top Header & Actions */}
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.headerTitle}>Media Sources & Repositories</Text>
          <Text style={styles.headerSubtitle}>
            Select a provider to load its catalog onto the Home Screen
          </Text>
        </View>

        <TVFocusablePressable
          hasTVPreferredFocus={installedProviders.length === 0}
          scaleFocused={1.05}
          focusedBorderColor="#8A5CF6"
          borderRadius={12}
          onPress={() => setIsModalVisible(true)}
          style={styles.addButton}
        >
          {({ focused }) => (
            <View style={styles.btnInner}>
              <MaterialCommunityIcons
                name="plus-circle-outline"
                size={22}
                color={focused ? '#FFFFFF' : '#DDD6FE'}
              />
              <Text style={styles.addBtnText}>Add Source URL</Text>
            </View>
          )}
        </TVFocusablePressable>
      </View>

      {/* Grid of Installed Providers */}
      {installedProviders.length === 0 ? (
        <View style={styles.emptyContainer}>
          <MaterialCommunityIcons
            name="cloud-download-outline"
            size={72}
            color="#4B5563"
          />
          <Text style={styles.emptyText}>No Cloud Providers Installed</Text>
          <Text style={styles.emptySubtext}>
            Click "Add Source URL" above to install an extension repository.
          </Text>
        </View>
      ) : (
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.gridContainer}
        >
          {installedProviders.map((item, index) => {
            const isSelected = provider?.value === item.value;
            return (
              <TVFocusablePressable
                key={`${item.value}-${index}`}
                hasTVPreferredFocus={index === 0}
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
                    <View style={styles.cardHeader}>
                      <View
                        style={[
                          styles.iconBadge,
                          isSelected && styles.iconBadgeSelected,
                        ]}
                      >
                        <MaterialCommunityIcons
                          name="server-network"
                          size={28}
                          color={isSelected || focused ? '#8A5CF6' : '#9CA3AF'}
                        />
                      </View>
                      {isSelected && (
                        <View style={styles.activePill}>
                          <MaterialCommunityIcons
                            name="check-circle"
                            size={14}
                            color="#FFFFFF"
                          />
                          <Text style={styles.activePillText}>Active</Text>
                        </View>
                      )}
                    </View>

                    <View style={styles.cardBody}>
                      <Text numberOfLines={1} style={styles.providerName}>
                        {item.displayTitle || item.name}
                      </Text>
                      <Text numberOfLines={1} style={styles.providerVersion}>
                        v{item.version || '1.0.0'} • {item.type || 'Cloud'}
                      </Text>
                    </View>

                    <Text style={styles.cardActionText}>
                      {isSelected ? 'Currently Selected' : 'Press OK to Select'}
                    </Text>
                  </View>
                )}
              </TVFocusablePressable>
            );
          })}
        </ScrollView>
      )}

      {/* TV-Optimized Centered Add Source Modal */}
      <Modal
        visible={isModalVisible}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setIsModalVisible(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <MaterialCommunityIcons
                name="cloud-plus"
                size={28}
                color="#8A5CF6"
              />
              <Text style={styles.modalTitle}>Add Provider Source</Text>
            </View>

            <Text style={styles.modalInstruction}>
              Enter repository URL or raw provider manifest link:
            </Text>

            <TextInput
              value={sourceInput}
              onChangeText={setSourceInput}
              placeholder="https://example.com/manifest.json"
              placeholderTextColor="#6B7280"
              style={styles.modalInput}
              autoCapitalize="none"
              autoCorrect={false}
            />

            {statusMessage && (
              <Text
                style={[
                  styles.statusText,
                  statusMessage.includes('success')
                    ? styles.statusSuccess
                    : styles.statusError,
                ]}
              >
                {statusMessage}
              </Text>
            )}

            <View style={styles.modalButtonRow}>
              <TVFocusablePressable
                hasTVPreferredFocus={true}
                scaleFocused={1.05}
                focusedBorderColor="#FFFFFF"
                borderRadius={10}
                onPress={handleInstallSource}
                style={styles.confirmButton}
              >
                {({ focused }) => (
                  <View style={styles.btnInner}>
                    {isLoading ? (
                      <ActivityIndicator size="small" color="#FFFFFF" />
                    ) : (
                      <>
                        <MaterialCommunityIcons
                          name="download"
                          size={20}
                          color="#FFFFFF"
                        />
                        <Text style={styles.confirmBtnText}>Install Source</Text>
                      </>
                    )}
                  </View>
                )}
              </TVFocusablePressable>

              <TVFocusablePressable
                scaleFocused={1.05}
                focusedBorderColor="#8A5CF6"
                borderRadius={10}
                onPress={() => {
                  setIsModalVisible(false);
                  setStatusMessage(null);
                }}
                style={styles.cancelButton}
              >
                {({ focused }) => (
                  <View style={styles.btnInner}>
                    <Text style={styles.cancelBtnText}>Cancel</Text>
                  </View>
                )}
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
    paddingLeft: 96,
    paddingRight: 48,
    paddingTop: 40,
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
    letterSpacing: 0.5,
  },
  headerSubtitle: {
    color: '#9CA3AF',
    fontSize: 14,
    marginTop: 4,
  },
  addButton: {
    backgroundColor: '#8A5CF6',
    paddingVertical: 12,
    paddingHorizontal: 20,
  },
  btnInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  addBtnText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  gridContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 20,
    paddingBottom: 40,
  },
  providerCard: {
    width: 250,
    height: 150,
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
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  iconBadge: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  iconBadgeSelected: {
    backgroundColor: 'rgba(138, 92, 246, 0.15)',
  },
  activePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#8A5CF6',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
  },
  activePillText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
  },
  cardBody: {
    marginVertical: 4,
  },
  providerName: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  providerVersion: {
    color: '#9CA3AF',
    fontSize: 12,
    marginTop: 2,
  },
  cardActionText: {
    color: '#6B7280',
    fontSize: 12,
    fontWeight: '500',
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
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.85)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalCard: {
    width: 540,
    backgroundColor: '#16161E',
    borderRadius: 20,
    padding: 32,
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 12,
  },
  modalTitle: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '800',
  },
  modalInstruction: {
    color: '#9CA3AF',
    fontSize: 14,
    marginBottom: 16,
  },
  modalInput: {
    backgroundColor: '#0A0A0E',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.15)',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    color: '#FFFFFF',
    fontSize: 15,
    marginBottom: 16,
  },
  statusText: {
    fontSize: 13,
    marginBottom: 14,
    textAlign: 'center',
  },
  statusSuccess: {
    color: '#10B981',
  },
  statusError: {
    color: '#EF4444',
  },
  modalButtonRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
    marginTop: 8,
  },
  confirmButton: {
    backgroundColor: '#8A5CF6',
    paddingVertical: 12,
    paddingHorizontal: 20,
  },
  confirmBtnText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  cancelButton: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    paddingVertical: 12,
    paddingHorizontal: 20,
  },
  cancelBtnText: {
    color: '#D1D5DB',
    fontSize: 14,
    fontWeight: '600',
  },
});
