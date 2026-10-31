import React, { useState, useEffect, useCallback, useMemo, useRef, memo } from 'react';
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
  findNodeHandle,
  LayoutChangeEvent,
} from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { TVFocusablePressable } from '../../components/tv/TVFocusablePressable';
import { registerRailLeftEdge } from '../../lib/tv/registerRailLeftEdge';
import { useTVEntryFocus } from '../../lib/tv/useTVEntryFocus';
import useContentStore from '../../lib/zustand/contentStore';
import useThemeStore from '../../lib/zustand/themeStore';
import {
  extensionStorage,
  ProviderExtension,
  ProviderSource,
} from '../../lib/storage/extensionStorage';
import { extensionManager } from '../../lib/services/ExtensionManager';
import { createProviderSource } from '../../lib/utils/helpers';

// True when `latest` is a higher dotted version than `current` ("1.20" > "1.9").
const isNewerVersion = (current?: string, latest?: string): boolean => {
  if (!latest) return false;
  if (!current) return true;
  const c = current.split('.').map((n) => parseInt(n, 10) || 0);
  const l = latest.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(c.length, l.length); i++) {
    const a = c[i] || 0;
    const b = l[i] || 0;
    if (b > a) return true;
    if (b < a) return false;
  }
  return false;
};

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
            Enter URL of your hosted provider source or GitHub author:
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

interface ProviderRowItemProps {
  item: ProviderExtension;
  isInstalled: boolean;
  isInstalling: boolean;
  onToggleInstall: (item: ProviderExtension) => void;
  itemKey: string;
  hasPreferredFocus: boolean;
  onItemFocus: (key: string) => void;
  registerItemRef: (key: string, node: View | null) => void;
  onRowLayout: (key: string, y: number, height: number) => void;
  // Native handles of the buttons above/below, passed as real props so they
  // survive re-renders (setNativeProps values can be dropped on the next commit).
  nextUp?: number;
  nextDown?: number;
}

// Memoized item row preventing unnecessary re-renders of 50+ items during scroll/state changes
const ProviderRowItem = memo(({
  item,
  isInstalled,
  isInstalling,
  onToggleInstall,
  itemKey,
  hasPreferredFocus,
  onItemFocus,
  registerItemRef,
  onRowLayout,
  nextUp,
  nextDown,
}: ProviderRowItemProps) => {
  // `hasTVPreferredFocus` makes the native view call requestFocus() every time
  // the prop is applied as `true`. If it were allowed to flip false -> true on a
  // later re-render, the request would land a moment later -- after a held
  // Down key has already moved focus on -- and pull focus back to this row.
  // So it is read once, when the row mounts (a remount re-reads it).
  const preferFocusOnMount = useRef(hasPreferredFocus).current;

  // Stable per-row callbacks, so a re-render of this row doesn't detach and
  // re-attach the ref (which re-registered every row with the nav rail).
  const handleRef = useCallback(
    (el: View | null) => {
      registerItemRef(itemKey, el);
      // This button is the only focusable element in the row -- there's
      // nothing else to its left -- so Left from it should always reach
      // the Addons rail button, for every row, not just the first.
      if (el) registerRailLeftEdge('addons', el);
    },
    [itemKey, registerItemRef],
  );
  const handleFocus = useCallback(() => onItemFocus(itemKey), [itemKey, onItemFocus]);
  const handlePress = useCallback(() => onToggleInstall(item), [item, onToggleInstall]);
  const handleLayout = useCallback(
    (e: LayoutChangeEvent) => onRowLayout(itemKey, e.nativeEvent.layout.y, e.nativeEvent.layout.height),
    [itemKey, onRowLayout],
  );

  return (
    <View style={styles.providerRow} onLayout={handleLayout}>
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
        ref={handleRef}
        hasTVPreferredFocus={preferFocusOnMount}
        onFocus={handleFocus}
        {...(nextUp != null ? { nextFocusUp: nextUp } : {})}
        {...(nextDown != null ? { nextFocusDown: nextDown } : {})}
        scaleFocused={1.04}
        focusedBorderColor="#FFFFFF"
        borderRadius={10}
        onPress={handlePress}
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
});

interface ExtensionsScreenProps {
  navigation?: any;
  route?: any;
  onRegisterBackHandler?: (handler: (() => boolean) | null) => void;
  onRegisterEntryHandleGetter?: (getter: (() => number | null) | null) => void;
  onRegisterReturnFocusTrigger?: (trigger: (() => void) | null) => void;
  resetFocusOnMount?: boolean;
}

// Module-level so it survives this screen unmounting when the user leaves
// the Addons tab and comes back -- same pattern as TVHomeScreen's
// `lastFocusedKey`.
let lastFocusedAddonsKey: string | null = null;

// Where the focused row is kept inside the list viewport while moving through
// it (0 = top edge, 1 = bottom edge).
const FOCUS_ANCHOR = 0.4;

export default function Extensions({
  navigation,
  onRegisterBackHandler,
  onRegisterEntryHandleGetter,
  onRegisterReturnFocusTrigger,
  resetFocusOnMount,
}: ExtensionsScreenProps) {
  const { setItemRef, keyFor, shouldPreferFocus } = useTVEntryFocus(
    () => lastFocusedAddonsKey,
    onRegisterEntryHandleGetter,
    onRegisterReturnFocusTrigger,
    resetFocusOnMount,
    () => {
      lastFocusedAddonsKey = null;
    }
  );
  const primaryColor = useThemeStore((state) => state.primaryColor) || '#8A5CF6';
  const installedProviders = useContentStore((state) => state.installedProviders);
  const setInstalledProviders = useContentStore((state) => state.setInstalledProviders);
  const setProvider = useContentStore((state) => state.setProvider);
  const setSecondaryProvider = useContentStore((state) => state.setSecondaryProvider);
  const activeProvider = useContentStore((state) => state.provider);

  const [availableProviders, setAvailableProviders] = useState<ProviderExtension[]>([]);
  const [activeSource, setActiveSource] = useState<ProviderSource | undefined>();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshStatus, setRefreshStatus] = useState('Loading repository manifest...');
  const [installingMap, setInstallingMap] = useState<Record<string, boolean>>({});
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [isAddingSource, setIsAddingSource] = useState(false);
  const refreshBtnRef = useRef<View | null>(null);
  const addSourceBtnRef = useRef<View | null>(null);
  const [refreshBtnHandle, setRefreshBtnHandle] = useState<number | null>(null);

  // Hardware Back: only handle this screen's own back-stack (the add-source
  // modal). If it's not open, report "not handled" so App.tsx moves focus to
  // the Addons button on the rail.
  useEffect(() => {
    const handleBack = () => {
      if (isModalVisible) {
        setIsModalVisible(false);
        return true;
      }
      return false;
    };

    onRegisterBackHandler?.(handleBack);
    return () => onRegisterBackHandler?.(null);
  }, [isModalVisible, onRegisterBackHandler]);

  // Resolve the Refresh button's native handle once, so Add Source's
  // nextFocusLeft can target it directly (Add Source -> Refresh -> rail),
  // instead of both buttons jumping straight past each other to the rail.
  useEffect(() => {
    const handle = refreshBtnRef.current ? findNodeHandle(refreshBtnRef.current) : null;
    setRefreshBtnHandle(handle);
  }, []);

  const syncInstalledProviders = useCallback(() => {
    setInstalledProviders(extensionStorage.getInstalledProviders());
  }, [setInstalledProviders]);

  // Installs the newer manifest version over every installed addon that has
  // one. Returns how many were updated.
  const updateOutdatedProviders = useCallback(
    async (manifestProviders: ProviderExtension[], source?: ProviderSource) => {
      const installed = extensionStorage.getInstalledProviders();
      const outdated: ProviderExtension[] = [];
      for (const inst of installed) {
        const latest = manifestProviders.find(
          (p) =>
            p.value === inst.value &&
            (!p.source?.author || !inst.source?.author || p.source.author === inst.source.author),
        );
        if (latest && isNewerVersion(inst.version, latest.version)) {
          outdated.push(latest);
        }
      }
      if (outdated.length === 0) return 0;

      let updated = 0;
      for (const latest of outdated) {
        setRefreshStatus(`Updating ${latest.display_name} (${updated + 1}/${outdated.length})...`);
        setInstallingMap((prev) => ({ ...prev, [latest.value]: true }));
        try {
          await extensionManager.installProvider({
            ...latest,
            source: latest.source || source!,
          });
          updated += 1;
        } catch (e) {
          console.warn(`[Extensions] Update failed for ${latest.value}:`, e);
        } finally {
          setInstallingMap((prev) => ({ ...prev, [latest.value]: false }));
        }
      }

      // Push the new versions into the store (the Sources page reads from
      // it), including the active/secondary selections, which hold their
      // own copy of the provider record.
      const refreshed = extensionStorage.getInstalledProviders();
      setInstalledProviders(refreshed);
      const { provider: active, secondaryProvider: secondary } = useContentStore.getState();
      const freshActive = refreshed.find((p) => p.value === active?.value);
      if (freshActive && freshActive.version !== active?.version) setProvider(freshActive);
      const freshSecondary = refreshed.find((p) => p.value === secondary?.value);
      if (freshSecondary && freshSecondary.version !== secondary?.version) {
        setSecondaryProvider(freshSecondary);
      }
      return updated;
    },
    [setInstalledProviders, setProvider, setSecondaryProvider],
  );

  const loadManifest = useCallback(
    async (source?: ProviderSource, force = false, updateInstalled = false) => {
      if (!source) {
        setAvailableProviders([]);
        return;
      }
      setRefreshStatus('Loading repository manifest...');
      setIsRefreshing(true);
      try {
        const providers = await extensionManager.fetchManifest(source, force);
        setAvailableProviders(providers);

        if (updateInstalled) {
          const updated = await updateOutdatedProviders(providers, source);
          ToastAndroid.show(
            updated > 0
              ? `Updated ${updated} addon${updated === 1 ? '' : 's'}`
              : 'All addons are up to date',
            ToastAndroid.SHORT,
          );
        }
      } catch (e: any) {
        console.warn('[Extensions] Manifest load error:', e);
        ToastAndroid.show(e?.message || 'Failed to load provider source', ToastAndroid.LONG);
        setAvailableProviders([]);
      } finally {
        setIsRefreshing(false);
      }
    },
    [updateOutdatedProviders],
  );

  useEffect(() => {
    const source = extensionStorage.getProviderSource();
    setActiveSource(source);
    if (source) {
      loadManifest(source);
    }
    syncInstalledProviders();
  }, [loadManifest, syncInstalledProviders]);

  const handleAddSource = async (rawInput: string) => {
    const trimmed = rawInput.trim();
    if (!trimmed) return;

    setIsAddingSource(true);
    try {
      const parsedSource = createProviderSource(trimmed);
      const providers = await extensionManager.fetchManifest(parsedSource, true);
      // Providers the manifest marks `"disabled": true` are not listed, so
      // they must not count towards "this source has something to offer".
      const usableProviders = (providers || []).filter((p) => !p.disabled);
      if (usableProviders.length === 0) {
        throw new Error('No valid providers found at this source');
      }

      extensionStorage.addProviderSources(parsedSource.author, parsedSource.url);
      extensionStorage.setDefaultProviderSource(parsedSource.author);

      setActiveSource(parsedSource);
      setAvailableProviders(providers);

      ToastAndroid.show(`Found ${usableProviders.length} available providers!`, ToastAndroid.SHORT);
      setIsModalVisible(false);
    } catch (err: any) {
      ToastAndroid.show(err?.message || 'Failed to add source', ToastAndroid.LONG);
    } finally {
      setIsAddingSource(false);
    }
  };

  const handleToggleInstall = useCallback(async (item: ProviderExtension) => {
    const isInstalled = useContentStore.getState().installedProviders.some((p) => p.value === item.value);
    setInstallingMap((prev) => ({ ...prev, [item.value]: true }));

    try {
      if (isInstalled) {
        extensionManager.uninstallProvider(item.value, item.source?.author);
        syncInstalledProviders();

        const currentActive = useContentStore.getState().provider;
        if (currentActive?.value === item.value) {
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
        await extensionManager.installProvider({ ...item, source: item.source || activeSource! });
        syncInstalledProviders();

        const currentActive = useContentStore.getState().provider;
        if (!currentActive?.value) {
          setProvider(item);
        }

        ToastAndroid.show(`Installed ${item.display_name}!`, ToastAndroid.SHORT);
      }
    } catch (e: any) {
      ToastAndroid.show(e?.message || 'Operation failed', ToastAndroid.LONG);
    } finally {
      setInstallingMap((prev) => ({ ...prev, [item.value]: false }));
    }
  }, [activeSource, setProvider, syncInstalledProviders]);

  // Fast O(1) set lookup rather than repeated O(N) array scans over 50+ items
  const installedSet = useMemo(
    () => new Set(installedProviders.map((p) => p.value)),
    [installedProviders],
  );

  // A source's manifest can mark a provider `"disabled": true` (broken,
  // retired, not ready) -- those are not offered in the addons list. One
  // exception: a disabled provider that is *already installed* stays
  // listed, otherwise it would be stranded on the device with no way to
  // uninstall it from here.
  const visibleProviders = useMemo(
    () => availableProviders.filter((p) => !p.disabled || installedSet.has(p.value)),
    [availableProviders, installedSet],
  );

  // ---- list focus + scrolling ---------------------------------------------
  const scrollRef = useRef<ScrollView | null>(null);
  const rowNodesRef = useRef<Record<string, any>>({});
  const rowLayoutsRef = useRef<Record<string, { y: number; h: number }>>({});
  const viewportHeightRef = useRef(0);
  const contentHeightRef = useRef(0);
  const orderedKeysRef = useRef<string[]>([]);
  orderedKeysRef.current = visibleProviders.map((p) => `provider-${p.value}`);
  const pendingScrollKeyRef = useRef<string | null>(null);

  // Same one-shot rule as the rows (see ProviderRowItem), for the two header
  // buttons: the value is decided when the element mounts and then kept. Keyed
  // by the React key, which `keyFor` changes whenever the element must remount
  // to reclaim focus, so a forced refocus still re-reads it.
  const preferredOnMountRef = useRef<Record<string, boolean>>({});
  const preferFocusOnMount = (key: string, defaultValue: boolean) => {
    const reactKey = keyFor(key);
    const memo = preferredOnMountRef.current;
    if (!(reactKey in memo)) memo[reactKey] = shouldPreferFocus(key, defaultValue);
    return memo[reactKey];
  };

  // Up/Down between rows is wired explicitly both via synchronous native
  // `setNativeProps` AND via React state props so Android's geometric focus
  // search can never race the ScrollView during a held Down key and jump back
  // to the header Refresh button.
  const [focusLinks, setFocusLinks] = useState<Record<string, { up?: number; down?: number }>>({});
  const [firstRowHandle, setFirstRowHandle] = useState<number | null>(null);

  const wireNativeFocusLinks = useCallback(() => {
    const keys = orderedKeysRef.current;
    if (keys.length === 0) return;

    const rHandle = refreshBtnRef.current ? findNodeHandle(refreshBtnRef.current) : refreshBtnHandle;
    const handles = keys.map((k) => {
      const node = rowNodesRef.current[k];
      return node ? findNodeHandle(node) : null;
    });

    const next: Record<string, { up?: number; down?: number }> = {};
    keys.forEach((k, i) => {
      const node = rowNodesRef.current[k];
      const self = handles[i];
      if (self == null) return;
      const below = i < keys.length - 1 ? handles[i + 1] : self; // last row: Down is locked to self
      const above = i > 0 ? handles[i - 1] : rHandle; // first row: Up -> Refresh
      next[k] = {
        down: below ?? undefined,
        up: above ?? undefined,
      };
      // Apply directly to the native view immediately so held-key repeats
      // never hit a frame before React state commits.
      if (node) {
        const nativePayload: Record<string, number> = {};
        if (below != null) nativePayload.nextFocusDown = below;
        if (above != null) nativePayload.nextFocusUp = above;
        (node as any).setNativeProps?.(nativePayload);
      }
    });

    const firstHandle = handles[0] ?? null;
    if (firstHandle != null) {
      (refreshBtnRef.current as any)?.setNativeProps?.({ nextFocusDown: firstHandle });
      (addSourceBtnRef.current as any)?.setNativeProps?.({ nextFocusDown: firstHandle });
    }

    setFocusLinks((prev) => {
      const pk = Object.keys(prev);
      const nk = Object.keys(next);
      if (
        pk.length === nk.length &&
        nk.every((k) => prev[k]?.up === next[k].up && prev[k]?.down === next[k].down)
      ) {
        return prev;
      }
      return next;
    });
    setFirstRowHandle((prev) => (prev === firstHandle ? prev : firstHandle));
  }, [refreshBtnHandle]);

  const registerRow = useCallback(
    (key: string, node: View | null) => {
      setItemRef(key, node);
      if (node) {
        rowNodesRef.current[key] = node;
        // If all visible rows have mounted, wire native focus links immediately
        const keys = orderedKeysRef.current;
        if (keys.length > 0 && keys.every((k) => Boolean(rowNodesRef.current[k]))) {
          wireNativeFocusLinks();
        }
      } else {
        delete rowNodesRef.current[key];
      }
    },
    [setItemRef, wireNativeFocusLinks],
  );

  useEffect(() => {
    if (isRefreshing) return;
    wireNativeFocusLinks();
    const timer = setTimeout(wireNativeFocusLinks, 40);
    return () => clearTimeout(timer);
  }, [visibleProviders, isRefreshing, refreshBtnHandle, wireNativeFocusLinks]);

  // The list is scrolled only from here. Android's own scrolling is switched
  // off on the ScrollView (see its props below): its arrow-key handling and its
  // scroll-to-focused-child both fight a held key, and when the focused row
  // ends up off-screen the ScrollView takes focus itself, after which the next
  // key press lands somewhere unrelated (the header buttons, in this screen).
  //
  // The scroll is instant, never animated: an animated scroll still running
  // when the next key repeat arrives gets overridden by it, which reads as
  // stutter. One instant step per row, with the focused row held at the same
  // spot on screen, looks like the list gliding under a fixed cursor.
  const scrollToRow = useCallback((key: string): boolean => {
    const layout = rowLayoutsRef.current[key];
    const viewportH = viewportHeightRef.current;
    const contentH = contentHeightRef.current;
    if (!layout || !viewportH || !contentH) return false;
    const maxY = Math.max(0, contentH - viewportH);
    const target = Math.min(
      maxY,
      Math.max(0, layout.y + layout.h / 2 - viewportH * FOCUS_ANCHOR),
    );
    scrollRef.current?.scrollTo({ y: target, animated: false });
    return true;
  }, []);

  // A row can take focus (restored position, first mount) before its layout has
  // been reported; scroll to it as soon as the numbers are there.
  const flushPendingScroll = useCallback(() => {
    const key = pendingScrollKeyRef.current;
    if (key && scrollToRow(key)) pendingScrollKeyRef.current = null;
  }, [scrollToRow]);

  const handleRowLayout = useCallback(
    (key: string, y: number, height: number) => {
      rowLayoutsRef.current[key] = { y, h: height };
      if (pendingScrollKeyRef.current === key) flushPendingScroll();
    },
    [flushPendingScroll],
  );

  const handleRowFocus = useCallback(
    (key: string) => {
      lastFocusedAddonsKey = key;
      pendingScrollKeyRef.current = scrollToRow(key) ? null : key;
      // Re-assert native directional links on the focused node so a held Down
      // key always has a valid native target ID even if the row just re-rendered.
      const idx = orderedKeysRef.current.indexOf(key);
      if (idx !== -1) {
        const node = rowNodesRef.current[key];
        const belowKey =
          idx < orderedKeysRef.current.length - 1 ? orderedKeysRef.current[idx + 1] : key;
        const aboveKey = idx > 0 ? orderedKeysRef.current[idx - 1] : null;
        const belowNode = rowNodesRef.current[belowKey];
        const aboveNode = aboveKey ? rowNodesRef.current[aboveKey] : refreshBtnRef.current;
        const belowHandle = belowNode ? findNodeHandle(belowNode) : null;
        const aboveHandle = aboveNode ? findNodeHandle(aboveNode) : null;
        if (node) {
          const payload: Record<string, number> = {};
          if (belowHandle != null) payload.nextFocusDown = belowHandle;
          if (aboveHandle != null) payload.nextFocusUp = aboveHandle;
          (node as any).setNativeProps?.(payload);
        }
      }
    },
    [scrollToRow],
  );

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
            key={keyFor('refresh-btn')}
            ref={(el) => {
              refreshBtnRef.current = el;
              setItemRef('refresh-btn', el);
              if (el) {
                registerRailLeftEdge('addons', el);
                // Topmost control on the screen: nothing is above it, but
                // the full-height rail made Android's geometric search jump
                // there on Up. Self-pointing nextFocusUp makes Up a no-op.
                const selfHandle = findNodeHandle(el);
                if (selfHandle != null) {
                  setRefreshBtnHandle((prev) => (prev === selfHandle ? prev : selfHandle));
                  (el as any).setNativeProps?.({ nextFocusUp: selfHandle });
                }
              }
            }}
            {...(firstRowHandle != null ? { nextFocusDown: firstRowHandle } : {})}
            hasTVPreferredFocus={preferFocusOnMount('refresh-btn', false)}
            onFocus={() => (lastFocusedAddonsKey = 'refresh-btn')}
            scaleFocused={1.05}
            focusedBorderColor="#8A5CF6"
            borderRadius={10}
            onPress={() => loadManifest(activeSource, true, true)}
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
            key={keyFor('add-source-btn')}
            ref={(el) => {
              addSourceBtnRef.current = el;
              setItemRef('add-source-btn', el);
              if (el) {
                const selfHandle = findNodeHandle(el);
                if (selfHandle != null) {
                  (el as any).setNativeProps?.({ nextFocusUp: selfHandle });
                }
              }
            }}
            hasTVPreferredFocus={preferFocusOnMount('add-source-btn', visibleProviders.length === 0)}
            onFocus={() => (lastFocusedAddonsKey = 'add-source-btn')}
            scaleFocused={1.05}
            focusedBorderColor="#8A5CF6"
            borderRadius={12}
            {...(refreshBtnHandle ? { nextFocusLeft: refreshBtnHandle } : {})}
            {...(firstRowHandle != null ? { nextFocusDown: firstRowHandle } : {})}
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
          <Text style={styles.loadingText}>{refreshStatus}</Text>
        </View>
      ) : visibleProviders.length === 0 ? (
        <View style={styles.centerContainer}>
          <MaterialCommunityIcons name="package-variant" size={72} color="#4B5563" />
          <Text style={styles.emptyTitle}>No providers available</Text>
          <Text style={styles.emptySubtitle}>
            Click "Add Source" and enter <Text style={styles.highlightText}>url</Text> to load extensions.
          </Text>
        </View>
      ) : (
        <ScrollView
          ref={scrollRef}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.listContainer}
          // Off-screen rows must stay attached so focus can reach them.
          removeClippedSubviews={false}
          overScrollMode="never"
          // Up/Down are handled by the explicit row-to-row focus links and the
          // scrolling by `scrollToRow`; keep Android's ScrollView out of both.
          // (scrollEnabled=false also makes the ScrollView itself unfocusable,
          // so it can never grab focus from a row. Programmatic scrollTo still
          // works.)
          scrollEnabled={false}
          scrollsChildToFocus={false}
          onLayout={(e) => {
            viewportHeightRef.current = e.nativeEvent.layout.height;
            flushPendingScroll();
          }}
          onContentSizeChange={(_w, h) => {
            contentHeightRef.current = h;
            flushPendingScroll();
            wireNativeFocusLinks();
          }}
        >
          {visibleProviders.map((item) => {
            const rowKey = `provider-${item.value}`;
            return (
              <ProviderRowItem
                key={keyFor(rowKey)}
                itemKey={rowKey}
                item={item}
                isInstalled={installedSet.has(item.value)}
                isInstalling={Boolean(installingMap[item.value])}
                onToggleInstall={handleToggleInstall}
                hasPreferredFocus={shouldPreferFocus(rowKey, false)}
                onItemFocus={handleRowFocus}
                registerItemRef={registerRow}
                onRowLayout={handleRowLayout}
                nextUp={focusLinks[rowKey]?.up}
                nextDown={focusLinks[rowKey]?.down}
              />
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
    // Trimmed from 96 -- see TVDiscoverScreen.tsx's CONTAINER_PADDING_LEFT
    // comment for why.
    paddingLeft: 20,
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
    borderRadius: 10,
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
  // Fixed width so Install and Uninstall rows share the same left/right
  // edges -- no horizontal shift (or focus-geometry change) between them.
  actionBtn: {
    width: 136,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
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
