import React from 'react';
import { View, Text, StyleSheet, ScrollView, ToastAndroid } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { TVFocusablePressable } from '../../components/tv/TVFocusablePressable';
import useSettingsStore from '../../lib/zustand/settingsStore';

export const TVSettingsScreen: React.FC = () => {
  const defaultPlayer = useSettingsStore((state: any) => state.defaultPlayer) || 'inbuilt';
  const setDefaultPlayer = useSettingsStore((state: any) => state.setDefaultPlayer);

  const players = [
    { id: 'inbuilt', title: 'Inbuilt ExoPlayer', desc: 'Standard Android TV video engine' },
    { id: 'vlc', title: 'VLC Player', desc: 'External app playback via Android Intent' },
    { id: 'external', title: 'Chooser / Just Player', desc: 'Prompt app picker on playback' },
  ];

  const handleSelectPlayer = (id: string) => {
    if (setDefaultPlayer) {
      setDefaultPlayer(id);
    }
    ToastAndroid.show(`Default player set to: ${id.toUpperCase()}`, ToastAndroid.SHORT);
  };

  return (
    <View style={styles.container}>
      <Text style={styles.screenTitle}>Settings</Text>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <Text style={styles.sectionHeader}>Default Video Player</Text>

        <View style={styles.optionList}>
          {players.map((item, index) => {
            const isSelected = defaultPlayer === item.id;
            return (
              <TVFocusablePressable
                key={item.id}
                hasTVPreferredFocus={index === 0}
                scaleFocused={1.03}
                focusedBorderColor="#8A5CF6"
                borderRadius={14}
                onPress={() => handleSelectPlayer(item.id)}
                style={[styles.settingRow, isSelected && styles.settingRowSelected]}
              >
                {() => (
                  <View style={styles.rowInner}>
                    <View style={styles.rowText}>
                      <Text style={styles.rowTitle}>{item.title}</Text>
                      <Text style={styles.rowDesc}>{item.desc}</Text>
                    </View>

                    <MaterialCommunityIcons
                      name={isSelected ? 'radiobox-marked' : 'radiobox-blank'}
                      size={24}
                      color={isSelected ? '#8A5CF6' : '#6B7280'}
                    />
                  </View>
                )}
              </TVFocusablePressable>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0E',
    paddingLeft: 96,
    paddingRight: 48,
    paddingTop: 36,
  },
  screenTitle: {
    color: '#FFFFFF',
    fontSize: 28,
    fontWeight: '800',
    marginBottom: 24,
  },
  content: {
    paddingBottom: 40,
    maxWidth: 700,
  },
  sectionHeader: {
    color: '#9CA3AF',
    fontSize: 14,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 12,
  },
  optionList: {
    gap: 12,
  },
  settingRow: {
    backgroundColor: '#16161E',
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.06)',
    padding: 18,
  },
  settingRowSelected: {
    borderColor: '#8A5CF6',
    backgroundColor: '#1E1B2E',
  },
  rowInner: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  rowText: {
    flex: 1,
  },
  rowTitle: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  rowDesc: {
    color: '#9CA3AF',
    fontSize: 13,
    marginTop: 2,
  },
});
