import React, { useState, useEffect, useRef } from 'react';
import {
  DevSettings,
  View,
  Text,
  StyleSheet,
  ScrollView,
  Switch,
  ToastAndroid,
  Modal,
  TextInput,
  ActivityIndicator,
} from 'react-native';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { TVFocusablePressable } from '../../components/tv/TVFocusablePressable';
import { registerRailLeftEdge } from '../../lib/tv/registerRailLeftEdge';
import { useTVEntryFocus } from '../../lib/tv/useTVEntryFocus';
import { settingsStorage, clearAllMMKVStorage } from '../../lib/storage';
import { syncDohSettings, DOH_PROVIDERS } from '../../lib/services/dohService';
import {
  isWarpSupported,
  getWarpStatus,
  toggleWarp,
} from '../../lib/services/warpService';
import { clearAppCache } from '../../lib/clearAppCache';
import { showAppDialog } from '../../lib/zustand/appDialogStore';
import useThemeStore from '../../lib/zustand/themeStore';
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
    id: 'dialogue',
    title: 'Dialogue Boost (Night Mode)',
    desc: 'Heavy vocal clarity boost while dynamic peaks and low-end rumble are compressed.',
    icon: 'account-voice',
  },
];

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

  // Every row on this screen is a full-width, single-column item, so every
  // one of them sits at the screen's left edge -- unlike Home/Discover's
  // horizontal rows, there's no single "first card" here. Registering on
  // mount (rather than only on focus) is enough since this screen's rows
  // are static, not virtualized, so there's no reordering/remounting to
  // race against.
  // Combines the rail's Left-edge registration with this hook's per-item
  // ref bookkeeping, so every row on this screen can also serve as the
  // rail's Right-key/re-select return-focus target.
  const registerItem = (key: string) => (el: View | null) => {
    setItemRef(key, el);
    if (el) registerRailLeftEdge('settings', el);
  };

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
      setWarpEnabled(settingsStorage?.isWarpEnabled ? settingsStorage.isWarpEnabled() : false);
    } catch (e) {
      console.warn('[TVSettingsScreen] Init error:', e);
    }

    getWarpStatus()
      .then((res) => {
        if (res.running && res.port) setWarpPort(res.port);
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

  const toggleWarpMode = async () => {
    if (isWarpBusy) return;
    const nextState = !warpEnabled;
    setIsWarpBusy(true);
    setWarpEnabled(nextState);

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

  const tmdbStatusLine = savedTmdbKey
    ? `Custom key active (ending ${savedTmdbKey.slice(-4)})`
    : hasBundledTmdbKey
    ? 'Using the built-in key'
    : 'No key configured -- some metadata and skip-intro lookups are limited';

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      <Text style={styles.header}>Settings</Text>

      {/* Audio Enhancement & Preamp Section */}
      <Text style={styles.sectionHeader}>Audio Preamp & Speech Clarity</Text>
      {AUDIO_PROFILES.map((p, index) => {
        const isSelected = audioBoostProfile === p.id;
        const rowKey = `audio-${p.id}`;
        return (
          <TVFocusablePressable
            key={keyFor(rowKey)}
            ref={registerItem(rowKey)}
            // Wired the same way Discover's grid picks a default landing
            // spot (`shouldPreferFocus(gridKey, index === 0)`): every row
            // on this screen was passing a hardcoded `false` default, so
            // on a fresh mount (nothing in `lastFocusedSettingsKey` yet)
            // *no* row ever claimed preferred focus and Android had
            // nothing to land on when the rail switched to Settings. The
            // very first row -- this screen's natural top-left entry
            // point -- now defaults to focused the same way page 1 of
            // every other tab does.
            hasTVPreferredFocus={shouldPreferFocus(rowKey, index === 0)}
            onFocus={() => (lastFocusedSettingsKey = rowKey)}
            scaleFocused={1.02}
            focusedBorderColor={primaryColor}
            borderRadius={10}
            onPress={() => handleSelectAudioProfile(p.id)}
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
          </TVFocusablePressable>
        );
      })}

      {/* Network & DoH Section */}
      <Text style={styles.sectionHeader}>Network & DNS over HTTPS (DoH)</Text>
      
      <TVFocusablePressable
        key={keyFor('doh-toggle')}
        ref={registerItem('doh-toggle')}
        hasTVPreferredFocus={shouldPreferFocus('doh-toggle', false)}
        onFocus={() => (lastFocusedSettingsKey = 'doh-toggle')}
        scaleFocused={1.02}
        focusedBorderColor={primaryColor}
        borderRadius={12}
        onPress={toggleDoH}
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
      </TVFocusablePressable>

      {dohEnabled && (
        <View style={styles.subGroup}>
          <Text style={styles.subGroupTitle}>Select DoH Resolver</Text>
          {DOH_OPTIONS.map((item) => {
            const isSelected = activeDohProvider === item.id;
            const rowKey = `doh-provider-${item.id}`;
            return (
              <TVFocusablePressable
                key={keyFor(rowKey)}
                ref={registerItem(rowKey)}
                hasTVPreferredFocus={shouldPreferFocus(rowKey, false)}
                onFocus={() => (lastFocusedSettingsKey = rowKey)}
                scaleFocused={1.02}
                focusedBorderColor={primaryColor}
                borderRadius={10}
                onPress={() => handleSelectDohProvider(item.id)}
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
              </TVFocusablePressable>
            );
          })}
        </View>
      )}

      <TVFocusablePressable
        key={keyFor('warp-toggle')}
        ref={registerItem('warp-toggle')}
        hasTVPreferredFocus={shouldPreferFocus('warp-toggle', false)}
        onFocus={() => (lastFocusedSettingsKey = 'warp-toggle')}
        scaleFocused={1.02}
        focusedBorderColor={primaryColor}
        borderRadius={12}
        onPress={toggleWarpMode}
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
      </TVFocusablePressable>

      {/* Video Player Selection Section */}
      <Text style={styles.sectionHeader}>Default Video Player</Text>
      {[
        { id: 'exo', title: 'Inbuilt ExoPlayer', subtitle: 'Native Android TV player with frame-rate matching' },
        { id: 'vlc', title: 'VLC Player', subtitle: 'Launch external VLC Android app via Intent' },
        { id: 'system', title: 'System Chooser / Just Player', subtitle: 'Prompt Android app picker on playback' },
      ].map((p) => {
        const isSelected = selectedPlayer === p.id;
        const rowKey = `player-${p.id}`;
        return (
          <TVFocusablePressable
            key={keyFor(rowKey)}
            ref={registerItem(rowKey)}
            hasTVPreferredFocus={shouldPreferFocus(rowKey, false)}
            onFocus={() => (lastFocusedSettingsKey = rowKey)}
            scaleFocused={1.02}
            focusedBorderColor={primaryColor}
            borderRadius={10}
            onPress={() => handleSelectPlayer(p.id as any)}
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
          </TVFocusablePressable>
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
          {['360p', '480p', '720p'].map((quality, qIndex) => {
            const selected = excludedQualities.includes(quality);
            const rowKey = `quality-${quality}`;
            return (
              <TVFocusablePressable
                key={keyFor(rowKey)}
                ref={(el) => {
                  setItemRef(rowKey, el);
                  if (qIndex === 0 && el) registerRailLeftEdge('settings', el);
                }}
                hasTVPreferredFocus={shouldPreferFocus(rowKey, false)}
                onFocus={() => (lastFocusedSettingsKey = rowKey)}
                scaleFocused={1.05}
                focusedBorderColor={primaryColor}
                borderRadius={16}
                onPress={() => toggleExcludedQuality(quality)}
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
              </TVFocusablePressable>
            );
          })}
        </View>
      </View>

      {/* Metadata (TMDB) Section */}
      <Text style={styles.sectionHeader}>Metadata (TMDB)</Text>
      <TVFocusablePressable
        key={keyFor('tmdb-key')}
        ref={registerItem('tmdb-key')}
        hasTVPreferredFocus={shouldPreferFocus('tmdb-key', false)}
        onFocus={() => (lastFocusedSettingsKey = 'tmdb-key')}
        scaleFocused={1.02}
        focusedBorderColor={primaryColor}
        borderRadius={12}
        onPress={openTmdbModal}
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
      </TVFocusablePressable>

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

      <TVFocusablePressable
        key={keyFor('clear-cache')}
        ref={registerItem('clear-cache')}
        hasTVPreferredFocus={shouldPreferFocus('clear-cache', false)}
        onFocus={() => (lastFocusedSettingsKey = 'clear-cache')}
        scaleFocused={1.02}
        focusedBorderColor={primaryColor}
        borderRadius={12}
        onPress={handleClearCache}
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
      </TVFocusablePressable>

      <TVFocusablePressable
        key={keyFor('erase-data')}
        ref={registerItem('erase-data')}
        hasTVPreferredFocus={shouldPreferFocus('erase-data', false)}
        onFocus={() => (lastFocusedSettingsKey = 'erase-data')}
        scaleFocused={1.02}
        focusedBorderColor="#EF4444"
        borderRadius={12}
        onPress={confirmEraseAllLocalData}
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
      </TVFocusablePressable>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0E',
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
