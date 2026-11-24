import React from 'react';
import { Modal, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { TVFocusablePressable } from './TVFocusablePressable';

export interface StreamPickerOption {
  name: string;
  // Multi-line release description (file name, codec, source, audio...).
  detail?: string;
  // e.g. "8.58 GB".
  size?: string;
}

interface Props {
  visible: boolean;
  options: StreamPickerOption[];
  onSelect: (index: number) => void;
  onCancel: () => void;
}

/**
 * Server / quality list for a Stremio addon episode. Same look as the
 * "Select Season / Quality" menu of the details screen, plus the release
 * lines and file size of every stream.
 */
export const TVStreamPickerModal = ({ visible, options, onSelect, onCancel }: Props) => {
  const { width, height } = useWindowDimensions();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.overlay}>
        <View style={[styles.box, { maxWidth: Math.min(width * 0.7, 900), maxHeight: height * 0.85 }]}>
          <View style={styles.header}>
            <MaterialCommunityIcons name="playlist-play" size={22} color="#A78BFA" />
            <View style={styles.headerText}>
              <Text style={styles.title}>Select Server / Quality</Text>
              <Text style={styles.subtitle}>{options.length} streams • choose one to play</Text>
            </View>
          </View>
          <View style={styles.divider} />
          <ScrollView style={styles.list} showsVerticalScrollIndicator={false}>
            {options.map((opt, i) => (
              <TVFocusablePressable
                key={`stream-opt-${i}`}
                hasTVPreferredFocus={i === 0}
                scaleFocused={1.02}
                focusedBorderColor="#8A5CF6"
                borderRadius={10}
                onPress={() => onSelect(i)}
                style={styles.option}
              >
                {() => (
                  <View style={styles.optionInner}>
                    <View style={styles.optionTextWrap}>
                      <Text style={styles.optionName}>{opt.name}</Text>
                      {opt.detail ? (
                        <Text numberOfLines={7} style={styles.optionDetail}>
                          {opt.detail}
                        </Text>
                      ) : null}
                    </View>
                    {opt.size ? (
                      <View style={styles.sizeBadge}>
                        <Text style={styles.sizeBadgeText}>{opt.size}</Text>
                      </View>
                    ) : null}
                  </View>
                )}
              </TVFocusablePressable>
            ))}
          </ScrollView>
          <TVFocusablePressable
            scaleFocused={1.05}
            focusedBorderColor="#FFFFFF"
            borderRadius={8}
            onPress={onCancel}
            style={styles.cancelBtn}
          >
            {() => <Text style={styles.cancelText}>Cancel</Text>}
          </TVFocusablePressable>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  box: {
    minWidth: 380,
    backgroundColor: 'rgba(19, 19, 26, 0.7)',
    borderRadius: 18,
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 14,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.16)',
    elevation: 12,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 },
  headerText: { flexShrink: 1 },
  title: { color: '#FFFFFF', fontSize: 20, fontWeight: '700' },
  subtitle: { color: '#9CA3AF', fontSize: 13, marginTop: 2 },
  divider: { height: 1, backgroundColor: 'rgba(255, 255, 255, 0.12)', marginBottom: 12 },
  list: { flexGrow: 0 },
  option: {
    backgroundColor: 'rgba(255, 255, 255, 0.07)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.06)',
    paddingVertical: 13,
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  optionInner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  optionTextWrap: { flexShrink: 1 },
  optionName: { color: '#E5E7EB', fontSize: 15, lineHeight: 21, fontWeight: '600' },
  optionDetail: { color: '#9CA3AF', fontSize: 12, lineHeight: 17, marginTop: 4 },
  sizeBadge: {
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  sizeBadgeText: { color: '#D1D5DB', fontSize: 11, fontWeight: '700' },
  cancelBtn: {
    alignSelf: 'flex-end',
    marginTop: 8,
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  cancelText: { color: '#E5E7EB', fontSize: 14, fontWeight: '600' },
});
