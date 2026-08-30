import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, Switch } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { TVFocusablePressable } from '../../components/tv/TVFocusablePressable';
import { settingsStorage } from '../../lib/storage';
import { syncDohSettings } from '../../lib/services/dohService';

export const TVSettingsScreen: React.FC = () => {
  const [dohEnabled, setDohEnabled] = useState(true);

  useEffect(() => {
    const isDoH = settingsStorage?.isDoHActive ? settingsStorage.isDoHActive() : true;
    setDohEnabled(isDoH);
  }, []);

  const toggleDoH = async () => {
    const nextState = !dohEnabled;
    setDohEnabled(nextState);
    if (settingsStorage?.setDoHActive) {
      settingsStorage.setDoHActive(nextState);
    }
    await syncDohSettings().catch((e) => console.warn('[DoH] Sync error:', e));
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.header}>Settings</Text>

      {/* Network & DoH Section */}
      <Text style={styles.sectionHeader}>Network & DNS</Text>
      <TVFocusablePressable
        scaleFocused={1.02}
        focusedBorderColor="#8A5CF6"
        borderRadius={10}
        onPress={toggleDoH}
        style={styles.settingCard}
      >
        {({ focused }) => (
          <View style={styles.cardRow}>
            <View style={styles.iconContainer}>
              <MaterialCommunityIcons name="shield-lock-outline" size={26} color="#8A5CF6" />
            </View>
            <View style={styles.textContainer}>
              <Text style={styles.settingTitle}>Cloudflare 1.1.1.1 DNS-over-HTTPS</Text>
              <Text style={styles.settingSubtitle}>
                Bypass ISP streaming throttling & unblock media provider domains
              </Text>
            </View>
            <Switch
              value={dohEnabled}
              onValueChange={toggleDoH}
              thumbColor={dohEnabled ? '#8A5CF6' : '#9CA3AF'}
              trackColor={{ false: '#374151', true: '#4C1D95' }}
            />
          </View>
        )}
      </TVFocusablePressable>

      {/* Playback Configuration */}
      <Text style={styles.sectionHeader}>Player & Decoders</Text>
      <TVFocusablePressable
        scaleFocused={1.02}
        focusedBorderColor="#8A5CF6"
        borderRadius={10}
        onPress={() => {}}
        style={styles.settingCard}
      >
        {({ focused }) => (
          <View style={styles.cardRow}>
            <View style={styles.iconContainer}>
              <MaterialCommunityIcons name="play-circle-outline" size={26} color="#8A5CF6" />
            </View>
            <View style={styles.textContainer}>
              <Text style={styles.settingTitle}>External Player Intent</Text>
              <Text style={styles.settingSubtitle}>
                Toggle direct stream pass-through to VLC or Just Player
              </Text>
            </View>
            <Text style={styles.statusText}>Built-in ExoPlayer</Text>
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
    paddingLeft: 32,
    paddingRight: 48,
    paddingTop: 36,
    paddingBottom: 48,
  },
  header: {
    color: '#FFFFFF',
    fontSize: 28,
    fontWeight: '800',
    marginBottom: 24,
  },
  sectionHeader: {
    color: '#9CA3AF',
    fontSize: 14,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: 18,
    marginBottom: 12,
  },
  settingCard: {
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    padding: 16,
    marginBottom: 12,
  },
  cardRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  iconContainer: {
    marginRight: 16,
  },
  textContainer: {
    flex: 1,
  },
  settingTitle: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  settingSubtitle: {
    color: '#9CA3AF',
    fontSize: 13,
  },
  statusText: {
    color: '#8A5CF6',
    fontWeight: '600',
    fontSize: 14,
  },
});
