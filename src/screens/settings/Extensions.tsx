import React, { useState, useEffect, useCallback, memo } from 'react';
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
import axios from 'axios';
import { TVFocusablePressable } from '../../components/tv/TVFocusablePressable';
import useContentStore from '../../lib/zustand/contentStore';
import useThemeStore from '../../lib/zustand/themeStore';
import { extensionStorage } from '../../lib/storage';
import { Provider } from '../../lib/providers/types';

interface RepoProviderManifest {
  name?: string;
  displayTitle?: string;
  title?: string;
  version: string;
  type?: string;
  author?: string;
  value: string;
  icon?: string;
  url?: string;
  [key: string]: any;
}

// Sub-component for input to prevent focus loss while typing on TV keyboards
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

  const [availableProviders, setAvailableProviders] = useState<RepoProviderManifest[]>([]);
  const [sourcesList, setSourcesList] = useState<string[]>([]);
  const [activeSource, setActiveSource] = useState<string>('');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [installingMap, setInstallingMap] = useState<Record<string, boolean>>({});
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [isAddingSource, setIsAddingSource] = useState(false);

  const getSavedSources = (): string[] => {
    try {
      const raw = extensionStorage.getString('providerSources');
      if (!raw) return [];
      return JSON.parse(raw);
    } catch {
      return [];
    }
  };

  const saveSources = (sources: string[]) => {
    try {
      extensionStorage.set('providerSources', JSON.stringify(sources));
    } catch (e) {
      console.warn('[Storage] Error:', e);
    }
  };

  const fetchManifest = async (url: string): Promise<RepoProviderManifest[]> => {
    const res = await axios.get(url, {
      timeout: 10000,
      headers: { 'Cache-Control': 'no-cache' },
    });
    const data = res.data;
    let list: RepoProviderManifest[] = [];
    if (Array.isArray(data)) list = data;
    else if (data?.providers && Array.isArray(data.providers)) list = data.providers;
    else if (data?.extensions && Array.isArray(data.extensions)) list = data.extensions;

    // Sanitize titles and versions to prevent undefined localeCompare crashes
    return list.map((item) => ({
      ...item,
      displayTitle: item.displayTitle || item.title || item.name || item.value || 'Provider',
      name: item.name || item.displayTitle || item.title || item.value || 'Provider',
      version: item.version || '1.0.0',
    }));
  };

  const loadSources = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const saved = getSavedSources();
      setSourcesList(saved);
      if (saved.length > 0) {
        const src = saved[0];
        setActiveSource(src);
        const provs = await fetchManifest(src);
        setAvailableProviders(provs);
      }
    } catch (e) {
      console.warn('[Extensions] Load error:', e);
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadSources();
  }, [loadSources]);

  const handleAddSource = async (rawInput: string) => {
    const trimmed = rawInput.trim();
    if (!trimmed) return;

    setIsAddingSource(true);
    try {
      let finalUrl = trimmed;
      if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
        finalUrl = `https://raw.githubusercontent.com/${trimmed}/vega-providers/main/manifest.json`;
      }

      const provs = await fetchManifest(finalUrl);
      if (!provs || provs.length === 0) {
        throw new Error('No valid providers found at this URL');
      }

      const updated = Array.from(new Set([...getSavedSources(), finalUrl]));
      saveSources(updated);
      setSourcesList(updated);
      setActiveSource(finalUrl);
      setAvailableProviders(provs);

      ToastAndroid.show(`Found ${provs.length} available providers!`, ToastAndroid.SHORT);
      setIsModalVisible(false);
    } catch (err: any) {
      ToastAndroid.show(err?.message || 'Failed to add source', ToastAndroid.LONG);
    } finally {
      setIsAddingSource(false);
    }
  };

  const handleToggleInstall = async (item: RepoProviderManifest) => {
    const isInstalled = installedProviders.some((p) => p.value === item.value);
    setInstallingMap((prev) => ({ ...prev, [item.value]: true }));

    try {
      if (isInstalled) {
        const nextList = installedProviders.filter((p) => p.value !== item.value);
        setInstalledProviders(nextList);
        if (activeProvider?.value === item.value) {
          setProvider(nextList.length > 0 ? nextList[0] : null);
        }
        ToastAndroid.show(`Uninstalled ${item.displayTitle}`, ToastAndroid.SHORT);
      } else {
        // Construct full remote raw script URL
        let scriptUrl = item.url;
        if (!scriptUrl && activeSource) {
          const basePath = activeSource.substring(0, activeSource.lastIndexOf('/'));
          scriptUrl = `${basePath}/${item.value}.js`;
        }

        let code = '';
        if (scriptUrl) {
          try {
            const codeRes = await axios.get(scriptUrl, { timeout: 10000 });
            code = typeof codeRes.data === 'string' ? codeRes.data : JSON.stringify(codeRes.data);
          } catch (err) {
            console.warn(`[Install] Could not pre-fetch script for ${item.value}`);
          }
        }

        const newProvider: Provider = {
          name: item.name || item.value,
          displayTitle: item.displayTitle || item.name || item.value,
          value: item.value,
          version: item.version,
          type: (item.type as any) || 'cloud',
          icon: item.icon,
          code: code,
          sourceUrl: scriptUrl || activeSource,
        };

        const nextList = [...installedProviders.filter((p) => p.value !== item.value), newProvider];
        setInstalledProviders(nextList);

        // Auto-select provider on first install
        if (!activeProvider) {
          setProvider(newProvider);
        }

        ToastAndroid.show(`Installed ${newProvider.displayTitle}!`, ToastAndroid.SHORT);
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
            Install and manage scraper extension repositories
          </Text>
        </View>

        <View style={styles.headerActions}>
          <TVFocusablePressable
            scaleFocused={1.05}
            focusedBorderColor="#8A5CF6"
            borderRadius={10}
            onPress={() => loadSources()}
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
            {activeSource}
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
            Click "Add Source" above and type <Text style={styles.highlightText}>vega-org</Text> to load available scrapers.
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
                    <MaterialCommunityIcons name="cloud-outline" size={28} color="#8A5CF6" />
                  </View>
                  <View style={styles.providerInfo}>
                    <View style={styles.titleLine}>
                      <Text style={styles.providerName}>{item.displayTitle}</Text>
                      <Text style={styles.versionBadge}>v{item.version}</Text>
                    </View>
                    <Text style={styles.providerMeta}>
                      {item.type || 'Global'} • {item.author || 'Vega-Org'}
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
