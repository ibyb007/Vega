import React, { useState, useEffect, useCallback, memo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Modal,
  TextInput,
  Image,
  ActivityIndicator,
  ToastAndroid,
} from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { TVFocusablePressable } from '../../components/tv/TVFocusablePressable';
import useContentStore from '../../lib/zustand/contentStore';
import useThemeStore from '../../lib/zustand/themeStore';
import {
  extensionStorage,
  ProviderExtension,
  ProviderSource,
} from '../../lib/storage/extensionStorage';
import { extensionManager } from '../../lib/services/ExtensionManager';
import { createProviderSource } from '../../lib/utils/helpers';

const AddSourceModal = memo(({
  visible,
  onClose,
  onConfirm,
  isLoading,
}: {
  visible: boolean;
  onClose: () => void;
  onConfirm: (url: string) => void;
  isLoading: boolean;
}) => {
  const [text, setText] = useState('');

  return (
    <Modal
      visible={visible}
      transparent={true}
      animationType="fade"
      onRequestClose={onClose}
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
            value={text}
            onChangeText={setText}
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
                setText('');
                onClose();
              }}
              style={styles.cancelBtn}
            >
              {() => <Text style={styles.cancelBtnText}>Cancel</Text>}
            </TVFocusablePressable>

            <TVFocusablePressable
              hasTVPreferredFocus={true}
              scaleFocused={1.05}
              focusedBorderColor="#FFFFFF"
              borderRadius={10}
              onPress={() => onConfirm(text)}
              style={styles.confirmBtn}
            >
              {() => (
                <View style={styles.btnContent}>
                  {isLoading ? (
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
  );
});

export default function Extensions({ navigation }: any) {
  const primaryColor = useThemeStore((state) => state.primaryColor) || '#8A5CF6';
  const installedProviders = useContentStore((state) => state.installedProviders);
  const setInstalledProviders = useContentStore((state) => state.setInstalledProviders);
  const setProvider = useContentStore((state) => state.setProvider);
  const activeProvider = useContentStore((state) => state.provider);

  const [availableProviders, setAvailableProviders] = useState<ProviderExtension[]>([]);
  const [activeSource, setActiveSource] = useState<ProviderSource | undefined>();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [installingMap, setInstallingMap] = useState<Record<string, boolean>>({});
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [isAddingSource, setIsAddingSource] = useState(false);

  // Re-reads installed providers from real persisted storage (MMKV via
  // extensionStorage) so the list is always in sync with what
  // ProviderManager can actually find, instead of drifting from an
  // in-memory-only list.
  const syncInstalledProviders = useCallback(() => {
    setInstalledProviders(extensionStorage.getInstalledProviders());
  }, [setInstalledProviders]);

  const loadManifest = useCallback(async (source?: ProviderSource, force = false) => {
    if (!source) {
      setAvailableProviders([]);
      return;
    }
    setIsRefreshing(true);
    try {
      const providers = await extensionManager.fetchManifest(source, force);
      setAvailableProviders(providers);
    } catch (e: any) {
      console.warn('[Extensions] Manifest load error:', e);
      ToastAndroid.show(e?.message || 'Failed to load provider source', ToastAndroid.LONG);
      setAvailableProviders([]);
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const source = extensionStorage.getProviderSource();
    setActiveSource(source);
    if (source) {
      loadManifest(source);
    }
    // Storage is the source of truth for installed providers on mount too,
    // in case something changed while this screen was unmounted.
    syncInstalledProviders();
  }, [loadManifest, syncInstalledProviders]);

  const handleAddSource = async (rawInput: string) => {
    const trimmed = rawInput.trim();
    if (!trimmed) return;

    setIsAddingSource(true);
    try {
      const parsedSource = createProviderSource(trimmed);
      const providers = await extensionManager.fetchManifest(parsedSource, true);
      if (!providers || providers.length === 0) {
        throw new Error('No valid providers found at this source');
      }

      extensionStorage.addProviderSources(parsedSource.author, parsedSource.url);
      extensionStorage.setDefaultProviderSource(parsedSource.author);

      setActiveSource(parsedSource);
      setAvailableProviders(providers);

      ToastAndroid.show(`Found ${providers.length} available providers!`, ToastAndroid.SHORT);
      setIsModalVisible(false);
    } catch (err: any) {
      ToastAndroid.show(err?.message || 'Failed to add source', ToastAndroid.LONG);
    } finally {
      setIsAddingSource(false);
    }
  };

  const handleToggleInstall = async (item: ProviderExtension) => {
    const isInstalled = installedProviders.some((p) => p.value === item.value);
    setInstallingMap((prev) => ({ ...prev, [item.value]: true }));

    try {
      if (isInstalled) {
        extensionManager.uninstallProvider(item.value, item.source?.author);
        syncInstalledProviders();

        if (activeProvider?.value === item.value) {
          const remaining = extensionStorage.getInstalledProviders();
          setProvider(remaining[0] ?? {
            value: '',
            display_name: '',
            type: 'global',
            installed: false,
            disabled: false,
            version: '0.0.1',
            icon: '',
            source: { author: '', url: '' },
            installedAt: 0,
            lastUpdated: 0,
          });
        }
        ToastAndroid.show(`Uninstalled ${item.display_name}`, ToastAndroid.SHORT);
      } else {
        // installProvider downloads catalog/posts/meta/stream modules from
        // `${source.url}/dist/${value}/*.js` and writes the install record
        // to extensionStorage — this is what ProviderManager reads from
        // when it later builds the home screen catalog.
        await extensionManager.installProvider({ ...item, source: item.source || activeSource! });
        syncInstalledProviders();

        if (!activeProvider?.value) {
          setProvider(item);
        }

        ToastAndroid.show(`Installed ${item.display_name}!`, ToastAndroid.SHORT);
      }
    } catch (e: any) {
      ToastAndroid.show(e?.message || 'Operation failed', ToastAndroid.LONG);
    } finally {
      setInstallingMap((prev) => ({ ...prev, [item.value]: false }));
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.screenTitle}>Providers & Addons</Text>
          <Text style={styles.screenSubtitle}>
            Install and manage streaming scraper extension repositories
          </Text>
        </View>

        <View style={styles.headerActions}>
          <TVFocusablePressable
            scaleFocused={1.05}
            focusedBorderColor="#8A5CF6"
            borderRadius={10}
            onPress={() => loadManifest(activeSource, true)}
            style={styles.iconBtn}
          >
            {() => (
              <MaterialCommunityIcons
                name="refresh"
                size={22}
                color="#FFFFFF"
              />
            )}
          </TVFocusablePressable>

          <TVFocusablePressable
            hasTVPreferredFocus={availableProviders.length === 0}
            scaleFocused={1.05}
            focusedBorderColor="#8A5CF6"
            borderRadius={12}
            onPress={() => setIsModalVisible(true)}
            style={[styles.addSourceBtn, { backgroundColor: primaryColor }]}
          >
            {() => (
              <View style={styles.btnContent}>
                <MaterialCommunityIcons name="plus" size={20} color="#FFFFFF" />
                <Text style={styles.addSourceBtnText}>Add Source</Text>
              </View>
            )}
          </TVFocusablePressable>
        </View>
      </View>

      {activeSource ? (
        <View style={styles.sourceBar}>
          <Text style={styles.sourceBarLabel}>Active Source:</Text>
          <Text numberOfLines={1} style={styles.sourceBarUrl}>
            {activeSource.author}
          </Text>
        </View>
      ) : null}

      {isRefreshing ? (
        <View style={styles.centerContainer}>
          <ActivityIndicator size="large" color={primaryColor} />
          <Text style={styles.loadingText}>Loading repository manifest...</Text>
        </View>
      ) : availableProviders.length === 0 ? (
        <View style={styles.centerContainer}>
          <MaterialCommunityIcons name="package-variant" size={72} color="#4B5563" />
          <Text style={styles.emptyTitle}>No providers available</Text>
          <Text style={styles.emptySubtitle}>
            Click "Add Source" and enter <Text style={styles.highlightText}>vega-org</Text> to load extensions.
          </Text>
        </View>
      ) : (
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.listContainer}
        >
          {availableProviders.map((item, index) => {
            const isInstalled = installedProviders.some((p) => p.value === item.value);
            const isInstalling = Boolean(installingMap[item.value]);

            return (
              <View key={`${item.value}-${index}`} style={styles.providerRow}>
                <View style={styles.providerLeft}>
                  <View style={styles.providerIconWrapper}>
                    {item.icon ? (
                      <Image source={{ uri: item.icon }} style={styles.providerLogo} resizeMode="contain" />
                    ) : (
                      <MaterialCommunityIcons name="cloud-outline" size={28} color="#8A5CF6" />
                    )}
                  </View>
                  <View style={styles.providerInfo}>
                    <View style={styles.titleLine}>
                      <Text style={styles.providerName}>{item.display_name}</Text>
                      <Text style={styles.versionBadge}>v{item.version}</Text>
                    </View>
                    <Text style={styles.providerMeta}>
                      {item.type || 'Global'} • {item.source?.author || 'Vega-Org'}
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
                  {() => (
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

      <AddSourceModal
        visible={isModalVisible}
        isLoading={isAddingSource}
        onClose={() => setIsModalVisible(false)}
        onConfirm={handleAddSource}
      />
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
    borderRadius: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  providerLogo: {
    width: 36,
    height: 36,
    borderRadius: 8,
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
    backgroundColor: '#8A5CF6',
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
