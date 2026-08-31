import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, Switch, ToastAndroid } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { TVFocusablePressable } from '../../components/tv/TVFocusablePressable';
import { settingsStorage } from '../../lib/storage';
import { syncDohSettings, DOH_PROVIDERS } from '../../lib/services/dohService';
import useThemeStore from '../../lib/zustand/themeStore';

const DOH_OPTIONS = [
  { id: 'cloudflare', name: 'Cloudflare (1.1.1.1)', desc: 'Fastest global resolution & bypass ISP throttling' },
  { id: 'google', name: 'Google (8.8.8.8)', desc: 'High reliability alternative' },
  { id: 'adguard', name: 'AdGuard DNS', desc: 'Blocks ads and malicious tracker domains' },
];

export const TVSettingsScreen: React.FC = () => {
  const primaryColor = useThemeStore((state) => state.primaryColor) || '#8A5CF6';
  const [dohEnabled, setDohEnabled] = useState(true);
  const [activeDohProvider, setActiveDohProvider] = useState('cloudflare');
  const [selectedPlayer, setSelectedPlayer] = useState<'exo' | 'vlc' | 'system'>('exo');

  useEffect(() => {
    const isDoH = settingsStorage?.isDoHActive ? settingsStorage.isDoHActive() : true;
    const provider = settingsStorage?.getDoHProvider ? settingsStorage.getDoHProvider() : 'cloudflare';
    const player = settingsStorage?.getDefaultPlayer ? settingsStorage.getDefaultPlayer() : 'exo';
    setDohEnabled(isDoH);
    setActiveDohProvider(provider);
    setSelectedPlayer(player);
  }, []);

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

  const handleSelectPlayer = (player: 'exo' | 'vlc' | 'system') => {
    setSelectedPlayer(player);
    if (settingsStorage?.setDefaultPlayer) {
      settingsStorage.setDefaultPlayer(player);
    }
    ToastAndroid.show(`Default player set to ${player.toUpperCase()}`, ToastAndroid.SHORT);
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      <Text style={styles.header}>Settings</Text>

      {/* Network & DoH Section */}
      <Text style={styles.sectionHeader}>Network & DNS over HTTPS (DoH)</Text>
      
      <TVFocusablePressable
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
            return (
              <TVFocusablePressable
                key={item.id}
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

      {/* Video Player Selection Section */}
      <Text style={styles.sectionHeader}>Default Video Player</Text>
      {[
        { id: 'exo', title: 'Inbuilt ExoPlayer', subtitle: 'Native Android TV player with frame-rate matching' },
        { id: 'vlc', title: 'VLC Player', subtitle: 'Launch external VLC Android app via Intent' },
        { id: 'system', title: 'System Chooser / Just Player', subtitle: 'Prompt Android app picker on playback' },
      ].map((p) => {
        const isSelected = selectedPlayer === p.id;
        return (
          <TVFocusablePressable
            key={p.id}
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
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0E',
  },
  content: {
    paddingLeft: 88, // Inset past the collapsed navigation rail
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
    marginTop: 18,
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
});
