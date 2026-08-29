import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Modal,
  TextInput,
  ActivityIndicator,
  ToastAndroid,
} from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { TVFocusablePressable } from '../../components/tv/TVFocusablePressable';
import useContentStore from '../../lib/zustand/contentStore';
import useThemeStore from '../../lib/zustand/themeStore';
import { extensionStorage } from '../../lib/storage';
import { updateProvidersService } from '../../lib/services/UpdateProviders';
import { Provider } from '../../lib/providers/types';

interface AvailableProviderItem {
  name: string;
  displayTitle?: string;
  version: string;
  type?: string;
  author?: string;
  value: string;
  icon?: string;
}

export default function Extensions({ navigation }: any) {
  const primaryColor = useThemeStore((state) => state.primaryColor);
  const installedProviders = useContentStore((state) => state.installedProviders);
  const setInstalledProviders = useContentStore((state) => state.setInstalledProviders);
  const setProvider = useContentStore((state) => state.setProvider);
  const activeProvider = useContentStore((state) => state.provider);

  const [availableProviders, setAvailableProviders] = useState<AvailableProviderItem[]>([]);
  const [sourcesList, setSourcesList] = useState<string[]>([]);
  const [activeSource, setActiveSource] = useState<string>('');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [installingMap, setInstallingMap] = useState<Record<string, boolean>>({});

  // Add Source Modal State
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [newSourceInput, setNewSourceInput] = useState('');
  const [isAddingSource, setIsAddingSource] = useState(false);

  // Load existing repository sources
  const loadSourcesAndProviders = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const savedSources: string[] = extensionStorage.getArray('providerSources') || [];
      setSourcesList(savedSources);

      const currentSrc = savedSources[0] || '';
      setActiveSource(currentSrc);

      if (currentSrc) {
        await fetchRepositoryProviders(currentSrc);
      }
    } catch (e) {
      console.warn('[Extensions] Load error:', e);
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  const fetchRepositoryProviders = async (sourceUrl: string) => {
    try {
      const providers = await updateProvidersService.fetchAvailableProviders(sourceUrl);
      setAvailableProviders(providers || []);
    } catch (e) {
      console.warn('[Extensions] Fetch repo providers failed:', e);
      setAvailableProviders([]);
    }
  };

  useEffect(() => {
    loadSourcesAndProviders();
  }, [loadSourcesAndProviders]);

  const handleAddSource = async () => {
    const trimmed = newSourceInput.trim();
    if (!trimmed) return;

    setIsAddingSource(true);
    try {
      let finalUrl = trimmed;
      if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
        // Handle GitHub author shortcut like vega-org
        finalUrl = `https://raw.githubusercontent.com/${trimmed}/vega-providers/main/manifest.json`;
      }

      const updatedSources = Array.from(new Set([...sourcesList, finalUrl]));
      extensionStorage.setArray('providerSources', updatedSources);
      setSourcesList(updatedSources);
      setActiveSource(finalUrl);

      await fetchRepositoryProviders(finalUrl);
      ToastAndroid.show('Source added successfully', ToastAndroid.SHORT);
      setNewSourceInput('');
      setIsModalVisible(false);
    } catch (err: any) {
      ToastAndroid.show(err?.message || 'Failed to fetch source', ToastAndroid.LONG);
    } finally {
      setIsAddingSource(false);
    }
  };

  const handleToggleInstall = async (item: AvailableProviderItem) => {
    const isInstalled = installedProviders.some((p) => p.value === item.value);
    setInstallingMap((prev) => ({ ...prev, [item.value]: true }));

    try {
      if (isInstalled) {
        // Uninstall provider
        const nextList = installedProviders.filter((p) => p.value !== item.value);
        setInstalledProviders(nextList);
        if (activeProvider?.value === item.value) {
          setProvider(nextList[0] || null);
        }
        ToastAndroid.show(`Uninstalled ${item.displayTitle || item.name}`, ToastAndroid.SHORT);
      } else {
        // Install provider
        const fullProvider = await updateProvidersService.installProvider(activeSource, item.value);
        const nextList = [...installedProviders.filter((p) => p.value !== item.value), fullProvider];
        setInstalledProviders(nextList);
        if (!activeProvider) {
          setProvider(fullProvider);
        }
        ToastAndroid.show(`Installed ${item.displayTitle || item.name}`, ToastAndroid.SHORT);
      }
    } catch (e: any) {
      ToastAndroid.show(e?.message || 'Operation failed', ToastAndroid.LONG);
    } finally {
      setInstallingMap((prev) => ({ ...prev, [item.value]: false }));
    }
  };

  return (
    <View style={styles.container}>
      {/* Top Header */}
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.screenTitle}>Providers & Addons</Text>
          <Text style={styles.screenSubtitle}>
            Install, update and manage scraper extension repositories
          </Text>
        </View>

        <View style={styles.headerActions}>
          <TVFocusablePressable
            scaleFocused={1.05}
            focusedBorderColor="#8A5CF6"
            borderRadius={10}
            onPress={() => loadSourcesAndProviders()}
            style={styles.iconBtn}
          >
            {({ focused }) => (
              <MaterialCommunityIcons
                name="refresh"
                size={22}
                color={focused ? '#FFFFFF' : '#9CA3AF'}
              />
            )}
          </TVFocusablePressable>

          <TVFocusablePressable
            hasTVPreferredFocus={availableProviders.length === 0}
            scaleFocused={1.05}
            focusedBorderColor="#8A5CF6"
            borderRadius={12}
            onPress={() => setIsModalVisible(true)}
            style={[styles.addSourceBtn, { backgroundColor: primaryColor || '#8A5CF6' }]}
          >
            {({ focused }) => (
              <View style={styles.btnContent}>
                <MaterialCommunityIcons name="plus" size={20} color="#FFFFFF" />
                <Text style={styles.addSourceBtnText}>Add Source</Text>
              </View>
            )}
          </TVFocusablePressable>
        </View>
      </View>

      {/* Active Source Bar */}
      {activeSource ? (
        <View style={styles.sourceBar}>
          <Text style={styles.sourceBarLabel}>Active Source:</Text>
          <Text numberOfLines={1} style={styles.sourceBarUrl}>
            {activeSource}
          </Text>
        </View>
      ) : null}

      {/* Available Providers List */}
      {isRefreshing ? (
        <View style={styles.centerContainer}>
          <ActivityIndicator size="large" color={primaryColor || '#8A5CF6'} />
          <Text style={styles.loadingText}>Fetching available providers...</Text>
        </View>
      ) : availableProviders.length === 0 ? (
        <View style={styles.centerContainer}>
          <MaterialCommunityIcons name="package-variant" size={72} color="#4B5563" />
          <Text style={styles.emptyTitle}>No providers available</Text>
          <Text style={styles.emptySubtitle}>
            Add or refresh a repository source to check for installable cloud providers.
          </Text>
        </View>
      ) : (
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.listContainer}
        >
          {availableProviders.map((item, index) => {
            const isInstalled = installedProviders.some((p) => p.value === item.value);
            const isInstalling = installingMap[item.value];

            return (
              <View key={`${item.value}-${index}`} style={styles.providerRow}>
                <View style={styles.providerLeft}>
                  <View style={styles.providerIconWrapper}>
                    <MaterialCommunityIcons name="cloud-outline" size={28} color="#8A5CF6" />
                  </View>
                  <View style={styles.providerInfo}>
                    <View style={styles.titleLine}>
                      <Text style={styles.providerName}>{item.displayTitle || item.name}</Text>
                      <Text style={styles.versionBadge}>v{item.version}</Text>
                    </View>
                    <Text style={styles.providerMeta}>
                      {item.type || 'Global'} • {item.author || 'Community'}
                    </Text>
                  </View>
                </View>

                <TVFocusablePressable
                  scaleFocused={1.05}
                  focusedBorderColor="#FFFFFF"
                  borderRadius={10}
                  onPress={() => handleToggleInstall(item)}
                  style={[
                    styles.actionBtn,
                    isInstalled ? styles.uninstallBtn : styles.installBtn,
                  ]}
                >
                  {({ focused }) => (
                    <View style={styles.btnContent}>
                      {isInstalling ? (
                        <ActivityIndicator size="small" color="#FFFFFF" />
                      ) : (
                        <>
                          <MaterialCommunityIcons
                            name={isInstalled ? 'trash-can-outline' : 'download'}
                            size={18}
                            color="#FFFFFF"
                          />
                          <Text style={styles.actionBtnText}>
                            {isInstalled ? 'Uninstall' : 'Install'}
                          </Text>
                        </>
                      )}
                    </View>
                  )}
                </TVFocusablePressable>
              </View>
            );
          })}
        </ScrollView>
      )}

      {/* Centered Add Source Modal */}
      <Modal
        visible={isModalVisible}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setIsModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Add Source</Text>
            </View>

            <Text style={styles.modalDesc}>
              Enter URL of your hosted provider source or GitHub author (e.g.{' '}
              <Text style={styles.highlightText}>vega-org</Text>):
            </Text>

            <TextInput
              value={newSourceInput}
              onChangeText={setNewSourceInput}
              placeholder="GitHub author or source URL"
              placeholderTextColor="#6B7280"
              style={styles.textInput}
              autoCapitalize="none"
              autoCorrect={false}
            />

            <View style={styles.modalActions}>
              <TVFocusablePressable
                scaleFocused={1.05}
                focusedBorderColor="#8A5CF6"
                borderRadius={10}
                onPress={() => {
                  setNewSourceInput('');
                  setIsModalVisible(false);
                }}
                style={styles.cancelBtn}
              >
                {({ focused }) => <Text style={styles.cancelBtnText}>Cancel</Text>}
              </TVFocusablePressable>

              <TVFocusablePressable
                hasTVPreferredFocus={true}
                scaleFocused={1.05}
                focusedBorderColor="#FFFFFF"
                borderRadius={10}
                onPress={handleAddSource}
                style={[styles.confirmBtn, { backgroundColor: primaryColor || '#8A5CF6' }]}
              >
                {({ focused }) => (
                  <View style={styles.btnContent}>
                    {isAddingSource ? (
                      <ActivityIndicator size="small" color="#FFFFFF" />
                    ) : (
                      <Text style={styles.confirmBtnText}>Confirm</Text>
                    )}
                  </View>
                )}
              </TVFocusablePressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

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
    marginBottom: 20,
  },
  screenTitle: {
    color: '#FFFFFF',
    fontSize: 26,
    fontWeight: '800',
  },
  screenSubtitle: {
    color: '#9CA3AF',
    fontSize: 14,
    marginTop: 4,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  iconBtn: {
    backgroundColor: '#16161E',
    padding: 12,
  },
  addSourceBtn: {
    paddingVertical: 12,
    paddingHorizontal: 18,
  },
  addSourceBtnText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  btnContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  sourceBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#16161E',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    marginBottom: 20,
    gap: 10,
  },
  sourceBarLabel: {
    color: '#8A5CF6',
    fontSize: 13,
    fontWeight: '700',
  },
  sourceBarUrl: {
    color: '#D1D5DB',
    fontSize: 13,
    flex: 1,
  },
  listContainer: {
    paddingBottom: 40,
    gap: 12,
  },
  providerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#16161E',
    borderRadius: 14,
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.06)',
  },
  providerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  providerIconWrapper: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(138, 92, 246, 0.12)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  providerInfo: {
    gap: 2,
  },
  titleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  providerName: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '700',
  },
  versionBadge: {
    color: '#9CA3AF',
    fontSize: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  providerMeta: {
    color: '#6B7280',
    fontSize: 13,
  },
  actionBtn: {
    paddingVertical: 10,
    paddingHorizontal: 18,
  },
  installBtn: {
    backgroundColor: '#8A5CF6',
  },
  uninstallBtn: {
    backgroundColor: 'rgba(239, 68, 68, 0.25)',
  },
  actionBtnText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingBottom: 60,
  },
  loadingText: {
    color: '#9CA3AF',
    fontSize: 15,
    marginTop: 16,
  },
  emptyTitle: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '700',
    marginTop: 16,
  },
  emptySubtitle: {
    color: '#9CA3AF',
    fontSize: 14,
    marginTop: 6,
    textAlign: 'center',
    maxWidth: 480,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.85)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalBox: {
    width: 520,
    backgroundColor: '#16161E',
    borderRadius: 20,
    padding: 28,
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  modalHeader: {
    marginBottom: 12,
  },
  modalTitle: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '800',
  },
  modalDesc: {
    color: '#9CA3AF',
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 16,
  },
  highlightText: {
    color: '#8A5CF6',
    fontWeight: '700',
  },
  textInput: {
    backgroundColor: '#0A0A0E',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.15)',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    color: '#FFFFFF',
    fontSize: 15,
    marginBottom: 20,
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
  },
  confirmBtn: {
    paddingVertical: 10,
    paddingHorizontal: 20,
  },
  confirmBtnText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
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
});
