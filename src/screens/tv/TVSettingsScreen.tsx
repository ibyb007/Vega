import React, { useState, useEffect, useRef, useCallback, useMemo, useSyncExternalStore } from 'react';
import {
  DevSettings,
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  DeviceEventEmitter,
  Switch,
  ToastAndroid,
  Modal,
  TextInput,
  ActivityIndicator,
  findNodeHandle,
} from 'react-native';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { TVFocusablePressable } from '../../components/tv/TVFocusablePressable';
import { registerRailLeftEdge } from '../../lib/tv/registerRailLeftEdge';
import { NavRail } from '../../lib/native/NavRail';
import { useTVEntryFocus } from '../../lib/tv/useTVEntryFocus';
import { settingsStorage, clearAllMMKVStorage } from '../../lib/storage';
import { syncDohSettings, DOH_PROVIDERS } from '../../lib/services/dohService';
import {
  isWarpSupported,
  getWarpStatus,
  toggleWarp,
} from '../../lib/services/warpService';
import {
  BYEDPI_PRESETS,
  DEFAULT_BYEDPI_ARGS,
  getByeDpiStatus,
  startByeDpi,
  stopByeDpi,
  toggleByeDpi,
} from '../../lib/services/byeDpiService';
import { clearAppCache } from '../../lib/clearAppCache';
import { showAppDialog } from '../../lib/zustand/appDialogStore';
import useThemeStore from '../../lib/zustand/themeStore';
import useAppDialogStore from '../../lib/zustand/appDialogStore';
import useSettingsStore, { AudioBoostProfile } from '../../lib/zustand/settingsStore';

const DOH_OPTIONS = [
  { id: 'cloudflare', name: 'Cloudflare (1.1.1.1)', desc: 'Fastest global resolution & bypass ISP throttling' },
  { id: 'google', name: 'Google (8.8.8.8)', desc: 'High reliability alternative' },
  { id: 'adguard', name: 'AdGuard DNS', desc: 'Blocks ads and malicious tracker domains' },
];

const AUDIO_PROFILES: { id: AudioBoostProfile; title: string; desc: string; icon: keyof typeof MaterialCommunityIcons.glyphMap }[] = [
  {
    id: 'off',
    title: 'Standard (Off)',
    desc: 'Default audio pass-through without digital preamp boost.',
    icon: 'volume-medium',
  },
  {
    id: 'rich',
    title: 'Rich & Immersive (VLC Preamp Boost)',
    desc: 'Huge volume gain across dialogue, score, ambient noise, and explosive peaks.',
    icon: 'surround-sound',
  },
  {
    id: 'cinematic',
    title: 'Cinematic Sound',
    desc: 'Everything in Rich & Immersive, even louder, plus extra lift for quiet low-level sounds like wind, whispers, distant chatter and ambient effects.',
    icon: 'movie-open',
  },
  {
    id: 'dialogue',
    title: 'Dialogue Boost (Night Mode)',
    desc: 'Heavy vocal clarity boost while dynamic peaks and low-end rumble are compressed.',
    icon: 'account-voice',
  },
];

const PLAYER_OPTIONS: { id: 'exo' | 'vlc' | 'system'; title: string; subtitle: string }[] = [
  { id: 'exo', title: 'Inbuilt ExoPlayer', subtitle: 'Native Android TV player with frame-rate matching' },
  { id: 'vlc', title: 'VLC Player', subtitle: 'Launch external VLC Android app via Intent' },
  { id: 'system', title: 'System Chooser / Just Player', subtitle: 'Prompt Android app picker on playback' },
];

const QUALITY_OPTIONS = ['360p', '480p', '720p'];

const KEYCODE_DPAD_UP = 19;
const KEYCODE_DPAD_DOWN = 20;
const KEYCODE_DPAD_LEFT = 21;
const KEYCODE_DPAD_RIGHT = 22;

// The whole screen is ONE native focus target (see TVSettingsScreen). This is
// its key in useTVEntryFocus, i.e. what the rail's Right key returns to.
const SETTINGS_HOST_KEY = 'list';

// Where the cursor row is held inside the viewport while moving (0 = top edge,
// 1 = bottom edge) -- the page glides under it. Same value Extensions uses.
const FOCUS_ANCHOR = 0.4;

// Tiny external store for "which row has the cursor, and does the screen hold
// native focus". Rows subscribe individually, so a cursor move re-renders only
// the row it left and the row it landed on -- not the whole (large) screen.
interface CursorStore {
  readonly key: string | null;
  readonly focused: boolean;
  setKey(key: string): void;
  setFocused(focused: boolean): void;
  isSelected(key: string): boolean;
  subscribe(listener: () => void): () => void;
}

const createCursorStore = (initialKey: string | null): CursorStore => {
  let key = initialKey;
  let focused = false;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());
  return {
    get key() {
      return key;
    },
    get focused() {
      return focused;
    },
    setKey(next) {
      if (next === key) return;
      key = next;
      emit();
    },
    setFocused(next) {
      if (next === focused) return;
      focused = next;
      emit();
    },
    isSelected: (k) => focused && key === k,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

// Purely presentational: NOT focusable. Draws exactly what TVFocusablePressable
// drew when it had focus (2px frame, scale, raised z-order), driven by the
// screen's JS cursor instead of by native focus.
const CursorRow = React.memo(function CursorRowView({
  store,
  nodes,
  rowKey,
  scaleFocused = 1.02,
  focusedBorderColor = '#8A5CF6',
  borderRadius = 8,
  style,
  children,
}: {
  store: CursorStore;
  nodes: React.MutableRefObject<Record<string, View | null>>;
  rowKey: string;
  scaleFocused?: number;
  focusedBorderColor?: string;
  borderRadius?: number;
  style?: any;
  children: ((state: { focused: boolean }) => React.ReactNode) | React.ReactNode;
}) {
  const selected = useSyncExternalStore(store.subscribe, () => store.isSelected(rowKey));
  const setRef = useCallback(
    (el: View | null) => {
      if (el) nodes.current[rowKey] = el;
      else delete nodes.current[rowKey];
    },
    [nodes, rowKey],
  );
  return (
    <View
      ref={setRef}
      // Needed so measureLayout can find this view (no layout-only flattening).
      collapsable={false}
      style={[
        style,
        rowStyles.base,
        { borderRadius },
        selected && {
          borderColor: focusedBorderColor,
          transform: [{ scale: scaleFocused }],
          zIndex: 99,
        },
      ]}
    >
      {typeof children === 'function' ? children({ focused: selected }) : children}
    </View>
  );
});

const rowStyles = StyleSheet.create({
  base: {
    borderWidth: 2,
    borderColor: 'transparent',
  },
});

// TMDB "API Key (v3)" -- exactly 32 hex characters. (The long "Read Access
// Token" TMDB also issues is a different credential and isn't what the app's
// `api_key=` requests use.)
const TMDB_V3_KEY_RE = /^[a-f0-9]{32}$/i;

type TmdbKeyVerdict = 'valid' | 'invalid' | 'unreachable';

// Asks TMDB whether the key works before it's saved, so a typo (easy to make
// with a remote-control keyboard) is caught here rather than showing up later
// as silently missing metadata. Only a definite 401 counts as "invalid" --
// a timeout/offline/rate-limit answer says nothing about the key itself.
const verifyTmdbKey = async (key: string): Promise<TmdbKeyVerdict> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(
      `https://api.themoviedb.org/3/configuration?api_key=${encodeURIComponent(key)}`,
      { signal: controller.signal },
    );
    if (res.ok) return 'valid';
    if (res.status === 401) return 'invalid';
    return 'unreachable';
  } catch {
    return 'unreachable';
  } finally {
    clearTimeout(timeout);
  }
};

interface TVSettingsScreenProps {
  onRegisterEntryHandleGetter?: (getter: (() => number | null) | null) => void;
  onRegisterReturnFocusTrigger?: (trigger: (() => void) | null) => void;
  resetFocusOnMount?: boolean;
}

// Module-level so it survives this screen unmounting when the user leaves
// the Settings tab and comes back -- same pattern as TVHomeScreen's
// `lastFocusedKey`.
let lastFocusedSettingsKey: string | null = null;
// Which row the cursor was on, so coming back to the tab restores it.
let lastSettingsCursorKey: string | null = null;

export const TVSettingsScreen: React.FC<TVSettingsScreenProps> = ({
  onRegisterEntryHandleGetter,
  onRegisterReturnFocusTrigger,
  resetFocusOnMount,
}) => {
  const { setItemRef, keyFor, shouldPreferFocus } = useTVEntryFocus(
    () => lastFocusedSettingsKey,
    onRegisterEntryHandleGetter,
    onRegisterReturnFocusTrigger,
    resetFocusOnMount,
    () => {
      lastFocusedSettingsKey = null;
      lastSettingsCursorKey = null;
    }
  );
  const primaryColor = useThemeStore((state) => state.primaryColor) || '#8A5CF6';
  const audioBoostProfile = useSettingsStore((state) => state.audioBoostProfile);
  const setAudioBoostProfile = useSettingsStore((state) => state.setAudioBoostProfile);

  const [dohEnabled, setDohEnabled] = useState(true);
  const [activeDohProvider, setActiveDohProvider] = useState('cloudflare');
  const [selectedPlayer, setSelectedPlayer] = useState<'exo' | 'vlc' | 'system'>('exo');
  const [excludedQualities, setExcludedQualities] = useState<string[]>([]);

  const [warpEnabled, setWarpEnabled] = useState(false);
  const [isWarpBusy, setIsWarpBusy] = useState(false);
  const [warpPort, setWarpPort] = useState<number | null>(null);
  const [isClearingCache, setIsClearingCache] = useState(false);

  const [byeDpiEnabled, setByeDpiEnabled] = useState(false);
  const [isByeDpiBusy, setIsByeDpiBusy] = useState(false);
  const [byeDpiPort, setByeDpiPort] = useState<number | null>(null);
  const [byeDpiArgs, setByeDpiArgs] = useState(DEFAULT_BYEDPI_ARGS);

  // Custom TMDB key. `savedTmdbKey` mirrors what's in storage; the rest is
  // the edit dialog's own state. A key saved here takes priority over the
  // one bundled at build time (see `getTmdbApiKey()` in useTmdbStory.ts).
  const [savedTmdbKey, setSavedTmdbKey] = useState(() => settingsStorage.getTmdbApiKey());
  const hasBundledTmdbKey = Boolean(String(Constants.expoConfig?.extra?.tmdbApiKey || '').trim());
  const [tmdbModalVisible, setTmdbModalVisible] = useState(false);
  const [tmdbKeyInput, setTmdbKeyInput] = useState('');
  const [tmdbKeyVisible, setTmdbKeyVisible] = useState(false);
  const [tmdbKeyError, setTmdbKeyError] = useState<string | null>(null);
  const [tmdbKeyChecking, setTmdbKeyChecking] = useState(false);

  useEffect(() => {
    try {
      const isDoH = settingsStorage?.isDoHActive ? settingsStorage.isDoHActive() : true;
      const provider = settingsStorage?.getDoHProvider ? settingsStorage.getDoHProvider() : 'cloudflare';
      const player = settingsStorage?.getDefaultPlayer ? settingsStorage.getDefaultPlayer() : 'exo';
      const excluded = settingsStorage?.getExcludedQualities
        ? settingsStorage.getExcludedQualities()
        : [];
      setDohEnabled(isDoH);
      setActiveDohProvider(provider);
      setSelectedPlayer(player);
      setExcludedQualities(excluded);
      const warpOn = settingsStorage?.isWarpEnabled ? settingsStorage.isWarpEnabled() : false;
      setWarpEnabled(warpOn);
      // WARP and AntiDPI are mutually exclusive; WARP wins if both flags are set.
      const byeOn = settingsStorage?.isByeDpiEnabled ? settingsStorage.isByeDpiEnabled() : true;
      setByeDpiEnabled(byeOn && !warpOn);
      const storedArgs = settingsStorage?.getByeDpiCmdArgs ? settingsStorage.getByeDpiCmdArgs() : '';
      setByeDpiArgs(storedArgs || DEFAULT_BYEDPI_ARGS);
    } catch (e) {
      console.warn('[TVSettingsScreen] Init error:', e);
    }

    getWarpStatus()
      .then((res) => {
        if (res.running && res.port) setWarpPort(res.port);
      })
      .catch(() => {});
    getByeDpiStatus()
      .then((res) => {
        if (res.running && res.port) setByeDpiPort(res.port);
      })
      .catch(() => {});
  }, []);

  const handleSelectAudioProfile = (profile: AudioBoostProfile) => {
    setAudioBoostProfile(profile);
    const label =
      profile === 'rich'
        ? 'Rich & Immersive (+12dB Boost)'
        : profile === 'dialogue'
        ? 'Dialogue Boost / Night Mode'
        : profile === 'cinematic'
        ? 'Cinematic Sound'
        : 'Standard (Off)';
    ToastAndroid.show(`Audio Profile: ${label}`, ToastAndroid.SHORT);
  };

  const toggleDoH = async () => {
    const nextState = !dohEnabled;
    setDohEnabled(nextState);
    if (settingsStorage?.setDoHActive) {
      settingsStorage.setDoHActive(nextState);
    }
    await syncDohSettings().catch((e) => console.warn('[DoH] Sync error:', e));
    ToastAndroid.show(`DNS-over-HTTPS ${nextState ? 'Enabled' : 'Disabled'}`, ToastAndroid.SHORT);
  };

  const handleSelectDohProvider = async (providerId: string) => {
    setActiveDohProvider(providerId);
    if (settingsStorage?.setDoHProvider) {
      settingsStorage.setDoHProvider(providerId);
    }
    await syncDohSettings().catch((e) => console.warn('[DoH] Sync error:', e));
    ToastAndroid.show(`DNS Provider set to ${providerId}`, ToastAndroid.SHORT);
  };

  const showByeDpiError = (e: any) => {
    ToastAndroid.show(`AntiDPI error: ${e?.message || 'Failed to start'}`, ToastAndroid.LONG);
    showAppDialog({
      title: 'AntiDPI failed to start',
      message: e?.message || 'Failed to start ByeDPI.',
      variant: 'error',
      actions: [{ label: 'OK' }],
    });
  };

  const toggleByeDpiMode = async () => {
    if (isByeDpiBusy) return;
    const nextState = !byeDpiEnabled;
    setIsByeDpiBusy(true);
    setByeDpiEnabled(nextState);
    if (nextState) {
      // Mutually exclusive with WARP (native side is stopped by toggleByeDpi).
      setWarpEnabled(false);
      setWarpPort(null);
    }
    try {
      const res = await toggleByeDpi(nextState, byeDpiArgs);
      if (nextState && res.running) {
        setByeDpiPort(res.port || null);
        ToastAndroid.show(`AntiDPI enabled (Port ${res.port})`, ToastAndroid.SHORT);
      } else if (!nextState) {
        setByeDpiPort(null);
        ToastAndroid.show('AntiDPI disabled', ToastAndroid.SHORT);
      }
    } catch (e: any) {
      setByeDpiEnabled(false);
      setByeDpiPort(null);
      settingsStorage?.setByeDpiEnabled?.(false);
      showByeDpiError(e);
    } finally {
      setIsByeDpiBusy(false);
    }
  };

  const handleSelectByeDpiPreset = async (args: string) => {
    if (isByeDpiBusy) return;
    setByeDpiArgs(args);
    settingsStorage?.setByeDpiCmdArgs?.(args);
    if (!byeDpiEnabled) return;
    setIsByeDpiBusy(true);
    try {
      await stopByeDpi();
      const res = await startByeDpi(args);
      setByeDpiPort(res.port || null);
      ToastAndroid.show('AntiDPI strategy applied', ToastAndroid.SHORT);
    } catch (e: any) {
      setByeDpiEnabled(false);
      setByeDpiPort(null);
      settingsStorage?.setByeDpiEnabled?.(false);
      showByeDpiError(e);
    } finally {
      setIsByeDpiBusy(false);
    }
  };

  const toggleWarpMode = async () => {
    if (isWarpBusy) return;
    const nextState = !warpEnabled;
    setIsWarpBusy(true);
    setWarpEnabled(nextState);
    if (nextState) {
      // Mutually exclusive with AntiDPI (native side is stopped by toggleWarp).
      setByeDpiEnabled(false);
      setByeDpiPort(null);
    }

    try {
      if (nextState) {
        ToastAndroid.show('Connecting to Cloudflare WARP...', ToastAndroid.SHORT);
      }
      const res = await toggleWarp(nextState);
      if (nextState && res.running) {
        setWarpPort(res.port || null);
        ToastAndroid.show(`WARP connected (Port ${res.port})`, ToastAndroid.SHORT);
      } else if (!nextState) {
        setWarpPort(null);
        ToastAndroid.show('WARP disconnected', ToastAndroid.SHORT);
      }
    } catch (e: any) {
      setWarpEnabled(false);
      setWarpPort(null);
      settingsStorage?.setWarpEnabled?.(false);
      ToastAndroid.show(`WARP error: ${e?.message || 'Failed to connect'}`, ToastAndroid.LONG);
      showAppDialog({
        title: 'WARP failed to start',
        message: e?.message || 'Failed to connect to Cloudflare WARP.',
        variant: 'error',
        actions: [{ label: 'OK' }],
      });
    } finally {
      setIsWarpBusy(false);
    }
  };

  const handleClearCache = async () => {
    if (isClearingCache) return;
    setIsClearingCache(true);
    try {
      await clearAppCache();
      ToastAndroid.show('App cache cleared', ToastAndroid.SHORT);
    } catch (e) {
      console.warn('[TVSettingsScreen] Clear cache error:', e);
      ToastAndroid.show('Failed to clear cache', ToastAndroid.SHORT);
    } finally {
      setIsClearingCache(false);
    }
  };

  const eraseAllLocalData = async () => {
    clearAllMMKVStorage();
    if (Updates.isEnabled) {
      await Updates.reloadAsync();
      return;
    }
    DevSettings.reload('All MMKV storage erased');
  };

  const confirmEraseAllLocalData = () => {
    showAppDialog({
      title: 'Erase all local data?',
      message:
        'This permanently erases every Vega MMKV store, including settings, installed provider data, Watchlist, Continue watching, download records, and cached state. This cannot be undone. Downloaded media files on disk are not deleted.',
      variant: 'error',
      actions: [
        { label: 'Cancel' },
        {
          label: 'Erase everything',
          variant: 'destructive',
          onPress: eraseAllLocalData,
        },
      ],
    });
  };

  const handleSelectPlayer = (player: 'exo' | 'vlc' | 'system') => {
    setSelectedPlayer(player);
    if (settingsStorage?.setDefaultPlayer) {
      settingsStorage.setDefaultPlayer(player);
    }
    ToastAndroid.show(`Default player set to ${player.toUpperCase()}`, ToastAndroid.SHORT);
  };

  const toggleExcludedQuality = (quality: string) => {
    const next = excludedQualities.includes(quality)
      ? excludedQualities.filter((q) => q !== quality)
      : [...excludedQualities, quality];
    setExcludedQualities(next);
    if (settingsStorage?.setExcludedQualities) {
      settingsStorage.setExcludedQualities(next);
    }
    ToastAndroid.show(
      `${quality} ${next.includes(quality) ? 'excluded' : 'included'}`,
      ToastAndroid.SHORT,
    );
  };

  const openTmdbModal = () => {
    setTmdbKeyInput(savedTmdbKey);
    setTmdbKeyVisible(false);
    setTmdbKeyError(null);
    setTmdbModalVisible(true);
  };

  const closeTmdbModal = () => {
    if (tmdbKeyChecking) return;
    setTmdbModalVisible(false);
    setTmdbKeyError(null);
  };

  const clearTmdbKey = () => {
    settingsStorage.setTmdbApiKey('');
    setSavedTmdbKey('');
    setTmdbKeyInput('');
    setTmdbModalVisible(false);
    ToastAndroid.show(
      hasBundledTmdbKey ? 'Custom TMDB key removed -- using built-in key' : 'Custom TMDB key removed',
      ToastAndroid.SHORT,
    );
  };

  const saveTmdbKey = async () => {
    if (tmdbKeyChecking) return;
    const candidate = tmdbKeyInput.trim();

    if (!candidate) {
      // Saving an empty box is the same as clearing.
      if (savedTmdbKey) clearTmdbKey();
      else closeTmdbModal();
      return;
    }
    if (candidate === savedTmdbKey) {
      closeTmdbModal();
      return;
    }
    if (!TMDB_V3_KEY_RE.test(candidate)) {
      setTmdbKeyError(
        'That doesn\'t look like a TMDB API Key (v3): it is 32 letters/digits. Use the "API Key", not the "Read Access Token".',
      );
      return;
    }

    setTmdbKeyError(null);
    setTmdbKeyChecking(true);
    const verdict = await verifyTmdbKey(candidate);
    setTmdbKeyChecking(false);

    if (verdict === 'invalid') {
      setTmdbKeyError('TMDB rejected this key. Check it for typos and try again.');
      return;
    }

    settingsStorage.setTmdbApiKey(candidate);
    setSavedTmdbKey(candidate);
    setTmdbModalVisible(false);
    ToastAndroid.show(
      verdict === 'valid'
        ? 'Custom TMDB key saved'
        : 'Custom TMDB key saved (couldn\'t verify it -- no connection?)',
      ToastAndroid.LONG,
    );
  };

  // ---- ONE focus target, cursor kept in JS ----------------------------------
  // Native focus used to travel row to row. Under a held Down key that kept
  // ending with focus thrown out to the side rail (or looping back up the
  // list), because Android's focus search ran against rows mid-scroll. So the
  // rows are no longer focusable at all: the whole screen is a single focus
  // target (the host Pressable below), Up/Down/Left/Right move a cursor in JS
  // from the raw key stream, and the cursor row is drawn as focused. Android's
  // focus search has nothing to do inside the page, so there is nothing to
  // misfire. Same approach as Extensions and the details episode list.
  const cursor = useMemo(
    () => createCursorStore(lastSettingsCursorKey ?? `audio-${AUDIO_PROFILES[0].id}`),
    [],
  );
  const rowNodesRef = useRef<Record<string, View | null>>({});
  const scrollRef = useRef<ScrollView | null>(null);
  const contentRef = useRef<View | null>(null);
  const viewportHeightRef = useRef(0);
  const hostFocusedRef = useRef(false);
  const [hostHandle, setHostHandle] = useState<number | null>(null);

  const tmdbModalVisibleRef = useRef(false);
  tmdbModalVisibleRef.current = tmdbModalVisible;

  // Cursor stops, as lines: Up/Down move between lines, Left/Right between the
  // stops of one line (only the quality chips share a line). Rebuilt every
  // render because sub-groups appear/disappear with their toggles.
  const lines: string[][] = [
    ...AUDIO_PROFILES.map((p) => [`audio-${p.id}`]),
    ['doh-toggle'],
    ...(dohEnabled ? DOH_OPTIONS.map((o) => [`doh-provider-${o.id}`]) : []),
    ['warp-toggle'],
    ['byedpi-toggle'],
    ...(byeDpiEnabled ? BYEDPI_PRESETS.map((pr) => [`byedpi-preset-${pr.id}`]) : []),
    ...PLAYER_OPTIONS.map((p) => [`player-${p.id}`]),
    QUALITY_OPTIONS.map((q) => `quality-${q}`),
    ['tmdb-key'],
    ['clear-cache'],
    ['erase-data'],
  ];
  const linesRef = useRef(lines);
  linesRef.current = lines;

  // What OK does on each stop. Rebuilt every render so it always sees the
  // latest state; read through a ref by the host's onPress.
  const actionsRef = useRef<Record<string, () => void>>({});
  const actions: Record<string, () => void> = {
    'doh-toggle': toggleDoH,
    'warp-toggle': toggleWarpMode,
    'byedpi-toggle': toggleByeDpiMode,
    'tmdb-key': openTmdbModal,
    'clear-cache': handleClearCache,
    'erase-data': confirmEraseAllLocalData,
  };
  AUDIO_PROFILES.forEach((p) => {
    actions[`audio-${p.id}`] = () => handleSelectAudioProfile(p.id);
  });
  DOH_OPTIONS.forEach((o) => {
    actions[`doh-provider-${o.id}`] = () => handleSelectDohProvider(o.id);
  });
  BYEDPI_PRESETS.forEach((pr) => {
    actions[`byedpi-preset-${pr.id}`] = () => handleSelectByeDpiPreset(pr.args);
  });
  PLAYER_OPTIONS.forEach((p) => {
    actions[`player-${p.id}`] = () => handleSelectPlayer(p.id);
  });
  QUALITY_OPTIONS.forEach((q) => {
    actions[`quality-${q}`] = () => toggleExcludedQuality(q);
  });
  actionsRef.current = actions;

  // Keep the cursor on a stop that exists (e.g. a sub-group collapsed).
  const firstKey = lines[0][0];
  useEffect(() => {
    const flat = linesRef.current.flat();
    if (!cursor.key || !flat.includes(cursor.key)) {
      cursor.setKey(firstKey);
      lastSettingsCursorKey = firstKey;
    }
  }, [cursor, firstKey, dohEnabled, byeDpiEnabled]);

  // Scrolling is instant and done only from here (the ScrollView below has
  // Android's own scrolling switched off). Holds the cursor row at a fixed
  // spot so the page glides under it.
  const scrollToKey = useCallback((key: string) => {
    const node = rowNodesRef.current[key];
    const content = contentRef.current;
    const scroller = scrollRef.current;
    const viewportH = viewportHeightRef.current;
    if (!node || !content || !scroller || !viewportH) return;
    node.measureLayout(
      content as any,
      (_x, y, _w, h) => {
        // ScrollView clamps to its own range, so no max is needed here.
        scroller.scrollTo({ y: Math.max(0, y + h / 2 - viewportH * FOCUS_ANCHOR), animated: false });
      },
      () => {},
    );
  }, []);

  const moveCursor = useCallback(
    (dRow: number, dCol: number) => {
      const all = linesRef.current;
      const current = cursor.key ?? all[0][0];
      let lineIdx = Math.max(0, all.findIndex((l) => l.includes(current)));
      let colIdx = Math.max(0, all[lineIdx].indexOf(current));
      if (dCol !== 0) {
        const nextCol = colIdx + dCol;
        if (nextCol < 0) {
          // Left of the leftmost stop: hand focus to this tab's rail button.
          NavRail.focusRoute('settings');
          return;
        }
        if (nextCol >= all[lineIdx].length) return;
        colIdx = nextCol;
      } else {
        const nextLine = lineIdx + dRow;
        if (nextLine < 0 || nextLine >= all.length) return;
        lineIdx = nextLine;
        colIdx = Math.min(colIdx, all[lineIdx].length - 1);
      }
      const nextKey = all[lineIdx][colIdx];
      if (nextKey === current) return;
      lastSettingsCursorKey = nextKey;
      cursor.setKey(nextKey);
      scrollToKey(nextKey);
    },
    [cursor, scrollToKey],
  );

  // Arrow keys while the page has focus. Listens to the raw key stream (every
  // repeat of a held key arrives), on its own subscription so it never
  // replaces another screen's key listener.
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('onKeyDown', (e: { keyCode?: number }) => {
      if (!hostFocusedRef.current || tmdbModalVisibleRef.current) return;
      if (useAppDialogStore.getState().dialog) return;
      switch (e?.keyCode) {
        case KEYCODE_DPAD_DOWN:
          moveCursor(1, 0);
          break;
        case KEYCODE_DPAD_UP:
          moveCursor(-1, 0);
          break;
        case KEYCODE_DPAD_LEFT:
          moveCursor(0, -1);
          break;
        case KEYCODE_DPAD_RIGHT:
          moveCursor(0, 1);
          break;
      }
    });
    return () => sub.remove();
  }, [moveCursor]);

  const handleHostFocus = useCallback(() => {
    lastFocusedSettingsKey = SETTINGS_HOST_KEY;
    hostFocusedRef.current = true;
    cursor.setFocused(true);
    if (cursor.key) scrollToKey(cursor.key);
  }, [cursor, scrollToKey]);

  const handleHostBlur = useCallback(() => {
    hostFocusedRef.current = false;
    cursor.setFocused(false);
  }, [cursor]);

  // OK acts on the cursor row.
  const handleHostPress = useCallback(() => {
    const key = cursor.key;
    if (key) actionsRef.current[key]?.();
  }, [cursor]);

  const hostRef = useCallback(
    (el: View | null) => {
      setItemRef(SETTINGS_HOST_KEY, el);
      if (el) {
        // Left from the page goes to the Settings rail button (and the rail's
        // Right/return lands back here).
        registerRailLeftEdge('settings', el);
        const handle = findNodeHandle(el);
        if (handle != null) {
          // Every direction points back at the host itself, so native focus
          // search can never carry focus out of the page (to the rail, or
          // anywhere else) -- the cursor does all the moving. Set right away
          // as well as through props below, so a key pressed before the
          // re-render still finds them.
          (el as any).setNativeProps?.({
            nextFocusUp: handle,
            nextFocusDown: handle,
            nextFocusLeft: handle,
            nextFocusRight: handle,
          });
          setHostHandle((prev) => (prev === handle ? prev : handle));
        }
      } else {
        hostFocusedRef.current = false;
        cursor.setFocused(false);
      }
    },
    [setItemRef, cursor],
  );

  // Same one-shot rule for `hasTVPreferredFocus` as elsewhere: decided when
  // the host mounts, never flipped later (a late false -> true re-applies a
  // requestFocus() that lands after the user has already moved on). The rail's
  // Right/return remounts the host (via keyFor) to get a real focus() call.
  const preferredOnMountRef = useRef<Record<string, boolean>>({});
  const hostReactKey = keyFor(SETTINGS_HOST_KEY);
  if (!(hostReactKey in preferredOnMountRef.current)) {
    preferredOnMountRef.current[hostReactKey] = shouldPreferFocus(SETTINGS_HOST_KEY, true);
  }

  const tmdbStatusLine = savedTmdbKey
    ? `Custom key active (ending ${savedTmdbKey.slice(-4)})`
    : hasBundledTmdbKey
    ? 'Using the built-in key'
    : 'No key configured -- some metadata and skip-intro lookups are limited';

  return (
    <Pressable
      key={hostReactKey}
      ref={hostRef}
      focusable
      hasTVPreferredFocus={preferredOnMountRef.current[hostReactKey]}
      onFocus={handleHostFocus}
      onBlur={handleHostBlur}
      onPress={handleHostPress}
      {...(hostHandle != null
        ? ({
            nextFocusUp: hostHandle,
            nextFocusDown: hostHandle,
            nextFocusLeft: hostHandle,
            nextFocusRight: hostHandle,
          } as any)
        : {})}
      style={styles.container}
    >
    <ScrollView
      ref={scrollRef}
      style={styles.scroller}
      showsVerticalScrollIndicator={false}
      removeClippedSubviews={false}
      overScrollMode="never"
      // Scrolling is driven only by `scrollToKey`; keep Android's own
      // ScrollView scrolling out of it. (scrollEnabled=false also makes the
      // ScrollView itself unfocusable. Programmatic scrollTo still works.)
      scrollEnabled={false}
      scrollsChildToFocus={false}
      onLayout={(e) => {
        const first = viewportHeightRef.current === 0;
        viewportHeightRef.current = e.nativeEvent.layout.height;
        // Restored cursor (coming back to the tab): bring it into place.
        if (first && cursor.key) scrollToKey(cursor.key);
      }}
    >
      <View ref={contentRef} collapsable={false} style={styles.content}>
      <Text style={styles.header}>Settings</Text>

      {/* Audio Enhancement & Preamp Section */}
      <Text style={styles.sectionHeader}>Audio Preamp & Speech Clarity</Text>
      {AUDIO_PROFILES.map((p) => {
        const isSelected = audioBoostProfile === p.id;
        const rowKey = `audio-${p.id}`;
        return (
          <CursorRow
            key={rowKey}
            store={cursor}
            nodes={rowNodesRef}
            rowKey={rowKey}
            scaleFocused={1.02}
            focusedBorderColor={primaryColor}
            borderRadius={10}
            style={[
              styles.optionCard,
              isSelected && { borderColor: primaryColor, backgroundColor: 'rgba(138, 92, 246, 0.12)' },
            ]}
          >
            {() => (
              <View style={styles.optionRow}>
                <View style={styles.iconContainerSmall}>
                  <MaterialCommunityIcons
                    name={p.icon}
                    size={22}
                    color={isSelected ? primaryColor : '#9CA3AF'}
                  />
                </View>
                <View style={styles.optionTextContainer}>
                  <Text style={[styles.optionTitle, isSelected && { color: primaryColor, fontWeight: '700' }]}>
                    {p.title}
                  </Text>
                  <Text style={styles.optionDesc}>{p.desc}</Text>
                </View>
                <View style={[styles.radioCircle, isSelected && { borderColor: primaryColor }]}>
                  {isSelected && <View style={[styles.radioDot, { backgroundColor: primaryColor }]} />}
                </View>
              </View>
            )}
          </CursorRow>
        );
      })}

      {/* Network & DoH Section */}
      <Text style={styles.sectionHeader}>Network & DNS over HTTPS (DoH)</Text>
      
      <CursorRow
        key="doh-toggle"
        store={cursor}
        nodes={rowNodesRef}
        rowKey="doh-toggle"
        scaleFocused={1.02}
        focusedBorderColor={primaryColor}
        borderRadius={12}
        style={styles.settingCard}
      >
        {({ focused }) => (
          <View style={styles.cardRow}>
            <View style={[styles.iconContainer, { backgroundColor: dohEnabled ? primaryColor : '#252530' }]}>
              <MaterialCommunityIcons name="shield-lock" size={24} color="#FFFFFF" />
            </View>
            <View style={styles.textContainer}>
              <Text style={styles.settingTitle}>Enable DNS over HTTPS (DoH)</Text>
              <Text style={styles.settingSubtitle}>
                Bypasses ISP stream throttling, DNS hijacking, and unblocks provider media domains
              </Text>
            </View>
            <Switch
              value={dohEnabled}
              onValueChange={toggleDoH}
              thumbColor={dohEnabled ? primaryColor : '#9CA3AF'}
              trackColor={{ false: '#374151', true: 'rgba(138, 92, 246, 0.4)' }}
            />
          </View>
        )}
      </CursorRow>

      {dohEnabled && (
        <View style={styles.subGroup}>
          <Text style={styles.subGroupTitle}>Select DoH Resolver</Text>
          {DOH_OPTIONS.map((item) => {
            const isSelected = activeDohProvider === item.id;
            const rowKey = `doh-provider-${item.id}`;
            return (
              <CursorRow
                key={rowKey}
                store={cursor}
                nodes={rowNodesRef}
                rowKey={rowKey}
                scaleFocused={1.02}
                focusedBorderColor={primaryColor}
                borderRadius={10}
                style={[
                  styles.optionCard,
                  isSelected && { borderColor: primaryColor, backgroundColor: 'rgba(138, 92, 246, 0.12)' },
                ]}
              >
                {() => (
                  <View style={styles.optionRow}>
                    <View style={styles.optionTextContainer}>
                      <Text style={[styles.optionTitle, isSelected && { color: primaryColor, fontWeight: '700' }]}>
                        {item.name}
                      </Text>
                      <Text style={styles.optionDesc}>{item.desc}</Text>
                    </View>
                    <View style={[styles.radioCircle, isSelected && { borderColor: primaryColor }]}>
                      {isSelected && <View style={[styles.radioDot, { backgroundColor: primaryColor }]} />}
                    </View>
                  </View>
                )}
              </CursorRow>
            );
          })}
        </View>
      )}

      <CursorRow
        key="warp-toggle"
        store={cursor}
        nodes={rowNodesRef}
        rowKey="warp-toggle"
        scaleFocused={1.02}
        focusedBorderColor={primaryColor}
        borderRadius={12}
        style={[styles.settingCard, { marginTop: 12 }]}
      >
        {() => (
          <View style={styles.cardRow}>
            <View style={[styles.iconContainer, { backgroundColor: warpEnabled ? primaryColor : '#252530' }]}>
              <MaterialCommunityIcons name="cloud-outline" size={24} color="#FFFFFF" />
            </View>
            <View style={styles.textContainer}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Text style={styles.settingTitle}>WARP Mode</Text>
                {warpEnabled && warpPort ? (
                  <View
                    style={{
                      marginLeft: 8,
                      paddingHorizontal: 6,
                      paddingVertical: 2,
                      borderRadius: 4,
                      backgroundColor: 'rgba(138, 92, 246, 0.25)',
                    }}
                  >
                    <Text style={{ color: primaryColor, fontSize: 10, fontWeight: '700' }}>
                      Active :{warpPort}
                    </Text>
                  </View>
                ) : null}
              </View>
              <Text style={styles.settingSubtitle}>
                Tunnels all app traffic, including video playback, through Cloudflare WARP -- helps
                when your ISP throttles specific streaming hosts
              </Text>
            </View>
            {isWarpBusy ? (
              <ActivityIndicator size="small" color={primaryColor} />
            ) : (
              <Switch
                value={warpEnabled}
                onValueChange={toggleWarpMode}
                disabled={isWarpBusy}
                thumbColor={warpEnabled ? primaryColor : '#9CA3AF'}
                trackColor={{ false: '#374151', true: 'rgba(138, 92, 246, 0.4)' }}
              />
            )}
          </View>
        )}
      </CursorRow>

      <CursorRow
        key="byedpi-toggle"
        store={cursor}
        nodes={rowNodesRef}
        rowKey="byedpi-toggle"
        scaleFocused={1.02}
        focusedBorderColor={primaryColor}
        borderRadius={12}
        style={[styles.settingCard, { marginTop: 12 }]}
      >
        {() => (
          <View style={styles.cardRow}>
            <View style={[styles.iconContainer, { backgroundColor: byeDpiEnabled ? primaryColor : '#252530' }]}>
              <MaterialCommunityIcons name="shield-half-full" size={24} color="#FFFFFF" />
            </View>
            <View style={styles.textContainer}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Text style={styles.settingTitle}>AntiDPI Mode</Text>
                {byeDpiEnabled && byeDpiPort ? (
                  <View
                    style={{
                      marginLeft: 8,
                      paddingHorizontal: 6,
                      paddingVertical: 2,
                      borderRadius: 4,
                      backgroundColor: 'rgba(138, 92, 246, 0.25)',
                    }}
                  >
                    <Text style={{ color: primaryColor, fontSize: 10, fontWeight: '700' }}>
                      Active :{byeDpiPort}
                    </Text>
                  </View>
                ) : null}
              </View>
              <Text style={styles.settingSubtitle}>
                Splits and reorders TLS packets on-device so your ISP's deep packet inspection can't
                single out blocked hosts. No server in the middle, so speed is unaffected. Turning
                this on turns WARP off.
              </Text>
            </View>
            {isByeDpiBusy ? (
              <ActivityIndicator size="small" color={primaryColor} />
            ) : (
              <Switch
                value={byeDpiEnabled}
                onValueChange={toggleByeDpiMode}
                disabled={isByeDpiBusy}
                thumbColor={byeDpiEnabled ? primaryColor : '#9CA3AF'}
                trackColor={{ false: '#374151', true: 'rgba(138, 92, 246, 0.4)' }}
              />
            )}
          </View>
        )}
      </CursorRow>

      {byeDpiEnabled && (
        <View style={styles.subGroup}>
          <Text style={styles.subGroupTitle}>AntiDPI Strategy</Text>
          {BYEDPI_PRESETS.map((preset) => {
            const isSelected = byeDpiArgs.trim() === preset.args;
            const rowKey = `byedpi-preset-${preset.id}`;
            return (
              <CursorRow
                key={rowKey}
                store={cursor}
                nodes={rowNodesRef}
                rowKey={rowKey}
                scaleFocused={1.02}
                focusedBorderColor={primaryColor}
                borderRadius={10}
                style={[
                  styles.optionCard,
                  isSelected && { borderColor: primaryColor, backgroundColor: 'rgba(138, 92, 246, 0.12)' },
                ]}
              >
                {() => (
                  <View style={styles.optionRow}>
                    <View style={styles.optionTextContainer}>
                      <Text style={[styles.optionTitle, isSelected && { color: primaryColor, fontWeight: '700' }]}>
                        {preset.name}
                      </Text>
                      <Text style={styles.optionDesc}>{preset.description}</Text>
                    </View>
                    <View style={[styles.radioCircle, isSelected && { borderColor: primaryColor }]}>
                      {isSelected && <View style={[styles.radioDot, { backgroundColor: primaryColor }]} />}
                    </View>
                  </View>
                )}
              </CursorRow>
            );
          })}
        </View>
      )}

      {/* Video Player Selection Section */}
      <Text style={styles.sectionHeader}>Default Video Player</Text>
      {PLAYER_OPTIONS.map((p) => {
        const isSelected = selectedPlayer === p.id;
        const rowKey = `player-${p.id}`;
        return (
          <CursorRow
            key={rowKey}
            store={cursor}
            nodes={rowNodesRef}
            rowKey={rowKey}
            scaleFocused={1.02}
            focusedBorderColor={primaryColor}
            borderRadius={10}
            style={[
              styles.optionCard,
              isSelected && { borderColor: primaryColor, backgroundColor: 'rgba(138, 92, 246, 0.12)' },
            ]}
          >
            {() => (
              <View style={styles.optionRow}>
                <View style={styles.optionTextContainer}>
                  <Text style={[styles.optionTitle, isSelected && { color: primaryColor, fontWeight: '700' }]}>
                    {p.title}
                  </Text>
                  <Text style={styles.optionDesc}>{p.subtitle}</Text>
                </View>
                <View style={[styles.radioCircle, isSelected && { borderColor: primaryColor }]}>
                  {isSelected && <View style={[styles.radioDot, { backgroundColor: primaryColor }]} />}
                </View>
              </View>
            )}
          </CursorRow>
        );
      })}

      {/* Quality Section */}
      <Text style={styles.sectionHeader}>Quality</Text>
      <View style={styles.settingCard}>
        <Text style={styles.settingTitle}>Excluded Qualities</Text>
        <Text style={styles.settingSubtitle}>
          Hide lower resolutions from stream results
        </Text>
        <View style={styles.chipRow}>
          {QUALITY_OPTIONS.map((quality) => {
            const selected = excludedQualities.includes(quality);
            const rowKey = `quality-${quality}`;
            return (
              <CursorRow
                key={rowKey}
                store={cursor}
                nodes={rowNodesRef}
                rowKey={rowKey}
                scaleFocused={1.05}
                focusedBorderColor={primaryColor}
                borderRadius={16}
                style={[
                  styles.qualityChip,
                  selected && {
                    borderColor: primaryColor,
                    backgroundColor: 'rgba(138, 92, 246, 0.18)',
                  },
                ]}
              >
                {() => (
                  <Text
                    style={[
                      styles.qualityChipText,
                      selected && { color: primaryColor, fontWeight: '700' },
                    ]}
                  >
                    {quality}
                  </Text>
                )}
              </CursorRow>
            );
          })}
        </View>
      </View>

      {/* Metadata (TMDB) Section */}
      <Text style={styles.sectionHeader}>Metadata (TMDB)</Text>
      <CursorRow
        key="tmdb-key"
        store={cursor}
        nodes={rowNodesRef}
        rowKey="tmdb-key"
        scaleFocused={1.02}
        focusedBorderColor={primaryColor}
        borderRadius={12}
        style={styles.settingCard}
      >
        {() => (
          <View style={styles.cardRow}>
            <View
              style={[
                styles.iconContainer,
                { backgroundColor: savedTmdbKey ? primaryColor : '#252530' },
              ]}
            >
              <MaterialCommunityIcons name="key-variant" size={24} color="#FFFFFF" />
            </View>
            <View style={styles.textContainer}>
              <Text style={styles.settingTitle}>Custom TMDB API key</Text>
              <Text style={styles.settingSubtitle}>
                Used for titles, artwork and skip-intro matching. Overrides the built-in key.
              </Text>
              <Text style={[styles.settingSubtitle, { color: savedTmdbKey ? primaryColor : '#9CA3AF', marginTop: 4 }]}>
                {tmdbStatusLine}
              </Text>
            </View>
            <MaterialCommunityIcons name="pencil-outline" size={22} color="#9CA3AF" />
          </View>
        )}
      </CursorRow>

      <Modal
        visible={tmdbModalVisible}
        transparent
        animationType="fade"
        onRequestClose={closeTmdbModal}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>Custom TMDB API key</Text>
            <Text style={styles.modalSubtitle}>
              Paste or type your TMDB "API Key (v3)" from themoviedb.org/settings/api. Tip: the
              Google TV / Android TV phone app gives you a phone keyboard for typing it.
            </Text>

            <View style={styles.keyInputRow}>
              <TextInput
                value={tmdbKeyInput}
                onChangeText={(text) => {
                  setTmdbKeyInput(text);
                  if (tmdbKeyError) setTmdbKeyError(null);
                }}
                placeholder="32-character API key"
                placeholderTextColor="#6B7280"
                autoCapitalize="none"
                autoCorrect={false}
                importantForAutofill="no"
                secureTextEntry={!tmdbKeyVisible}
                editable={!tmdbKeyChecking}
                returnKeyType="done"
                onSubmitEditing={saveTmdbKey}
                style={styles.keyInput}
              />
              <TVFocusablePressable
                scaleFocused={1.06}
                focusedBorderColor="#FFFFFF"
                borderRadius={8}
                onPress={() => setTmdbKeyVisible((v) => !v)}
                style={styles.keyEyeBtn}
              >
                {() => (
                  <MaterialCommunityIcons
                    name={tmdbKeyVisible ? 'eye-off-outline' : 'eye-outline'}
                    size={20}
                    color="#FFFFFF"
                  />
                )}
              </TVFocusablePressable>
            </View>
            {tmdbKeyError && <Text style={styles.keyErrorText}>{tmdbKeyError}</Text>}

            <View style={styles.modalActions}>
              {savedTmdbKey ? (
                <TVFocusablePressable
                  scaleFocused={1.04}
                  focusedBorderColor="#EF4444"
                  borderRadius={8}
                  onPress={clearTmdbKey}
                  style={styles.cancelBtn}
                >
                  {() => <Text style={[styles.cancelBtnText, { color: '#F87171' }]}>Remove key</Text>}
                </TVFocusablePressable>
              ) : null}
              <TVFocusablePressable
                scaleFocused={1.04}
                focusedBorderColor="#8A5CF6"
                borderRadius={8}
                onPress={closeTmdbModal}
                style={styles.cancelBtn}
              >
                {() => <Text style={styles.cancelBtnText}>Cancel</Text>}
              </TVFocusablePressable>
              <TVFocusablePressable
                scaleFocused={1.04}
                focusedBorderColor="#FFFFFF"
                borderRadius={8}
                onPress={saveTmdbKey}
                style={styles.confirmBtn}
              >
                {() =>
                  tmdbKeyChecking ? (
                    <ActivityIndicator size="small" color="#FFFFFF" />
                  ) : (
                    <Text style={styles.confirmBtnText}>Save</Text>
                  )
                }
              </TVFocusablePressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Data Management Section */}
      <Text style={styles.sectionHeader}>Data Management</Text>

      <CursorRow
        key="clear-cache"
        store={cursor}
        nodes={rowNodesRef}
        rowKey="clear-cache"
        scaleFocused={1.02}
        focusedBorderColor={primaryColor}
        borderRadius={12}
        style={styles.settingCard}
      >
        {() => (
          <View style={styles.cardRow}>
            <View style={[styles.iconContainer, { backgroundColor: '#252530' }]}>
              <MaterialCommunityIcons name="broom" size={24} color="#FFFFFF" />
            </View>
            <View style={styles.textContainer}>
              <Text style={styles.settingTitle}>Clear Cache</Text>
              <Text style={styles.settingSubtitle}>
                Frees up space by removing temporary and cached files. Active downloads and buffered
                playback segments are kept.
              </Text>
            </View>
            {isClearingCache ? (
              <ActivityIndicator size="small" color={primaryColor} />
            ) : (
              <MaterialCommunityIcons name="chevron-right" size={22} color="#9CA3AF" />
            )}
          </View>
        )}
      </CursorRow>

      <CursorRow
        key="erase-data"
        store={cursor}
        nodes={rowNodesRef}
        rowKey="erase-data"
        scaleFocused={1.02}
        focusedBorderColor="#EF4444"
        borderRadius={12}
        style={[styles.settingCard, { marginTop: 12 }]}
      >
        {() => (
          <View style={styles.cardRow}>
            <View style={[styles.iconContainer, { backgroundColor: 'rgba(239, 68, 68, 0.15)' }]}>
              <MaterialCommunityIcons name="delete-forever-outline" size={24} color="#F87171" />
            </View>
            <View style={styles.textContainer}>
              <Text style={[styles.settingTitle, { color: '#F87171' }]}>Erase All Local Data</Text>
              <Text style={styles.settingSubtitle}>
                Wipes settings, watchlist, providers, downloads records and every other saved app
                store. This cannot be undone.
              </Text>
            </View>
            <MaterialCommunityIcons name="chevron-right" size={22} color="#F87171" />
          </View>
        )}
      </CursorRow>
      </View>
    </ScrollView>
    </Pressable>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0E',
  },
  scroller: {
    flex: 1,
  },
  content: {
    // Trimmed from 88 -- see TVDiscoverScreen.tsx's CONTAINER_PADDING_LEFT
    // comment for why.
    paddingLeft: 20,
    paddingRight: 48,
    paddingTop: 32,
    paddingBottom: 60,
  },
  header: {
    color: '#FFFFFF',
    fontSize: 28,
    fontWeight: '800',
    marginBottom: 20,
    letterSpacing: 0.3,
  },
  sectionHeader: {
    color: '#9CA3AF',
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: 20,
    marginBottom: 12,
  },
  settingCard: {
    backgroundColor: '#16161E',
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    padding: 16,
    marginBottom: 12,
  },
  cardRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  iconContainer: {
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 16,
  },
  iconContainerSmall: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 14,
  },
  textContainer: {
    flex: 1,
    marginRight: 16,
  },
  settingTitle: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 3,
  },
  settingSubtitle: {
    color: '#9CA3AF',
    fontSize: 13,
    lineHeight: 18,
  },
  subGroup: {
    marginLeft: 16,
    marginBottom: 16,
    gap: 8,
  },
  subGroupTitle: {
    color: '#6B7280',
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  optionCard: {
    backgroundColor: '#16161E',
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    padding: 14,
    marginBottom: 8,
  },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  optionTextContainer: {
    flex: 1,
    marginRight: 16,
  },
  optionTitle: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 2,
  },
  optionDesc: {
    color: '#9CA3AF',
    fontSize: 12,
  },
  radioCircle: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: '#4B5563',
    justifyContent: 'center',
    alignItems: 'center',
  },
  radioDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 12,
  },
  qualityChip: {
    backgroundColor: '#1C1C24',
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 16,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  qualityChipText: {
    color: '#E5E7EB',
    fontSize: 14,
    fontWeight: '600',
  },
  // ---- TMDB key dialog (mirrors the Discover screen's catalog dialogs) ----
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.85)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalBox: {
    width: 560,
    backgroundColor: '#16161E',
    borderRadius: 16,
    padding: 24,
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  modalTitle: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '800',
    marginBottom: 6,
  },
  modalSubtitle: {
    color: '#9CA3AF',
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 16,
  },
  keyInputRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 8,
  },
  keyInput: {
    flex: 1,
    backgroundColor: '#0A0A0E',
    color: '#FFFFFF',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 8,
    fontSize: 14,
  },
  keyEyeBtn: {
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    paddingHorizontal: 14,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 8,
  },
  keyErrorText: {
    color: '#EF4444',
    fontSize: 12,
    lineHeight: 17,
    marginBottom: 8,
  },
  modalActions: {
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'flex-end',
    width: '100%',
    marginTop: 14,
  },
  cancelBtn: {
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    paddingVertical: 8,
    paddingHorizontal: 18,
    borderRadius: 8,
  },
  cancelBtnText: {
    color: '#D1D5DB',
    fontSize: 13,
    fontWeight: '600',
  },
  confirmBtn: {
    backgroundColor: '#8A5CF6',
    minWidth: 72,
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 18,
    borderRadius: 8,
  },
  confirmBtnText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
});
