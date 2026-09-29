import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  ToastAndroid,
  View,
} from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { TVFocusablePressable } from '../../../components/tv/TVFocusablePressable';
import { providerManager } from '../../../lib/services/ProviderManager';
import { providerKvStorage } from '../../../lib/storage/StorageService';
import { getScopedKvKey } from '../../../lib/sandbox/providerRpc';
import type { ProviderExtension } from '../../../lib/storage/extensionStorage';
import type { SettingsField } from '../../../lib/providers/types';

interface TVProviderSettingsModalProps {
  visible: boolean;
  provider: ProviderExtension | null;
  onClose: () => void;
  /**
   * Schema keys that must not be shown/edited here. The TV app already
   * handles these itself (e.g. Torrentio's `torrentio_skipTimings`, since
   * TheIntroDB skip-intro is always on in this app).
   */
  hiddenKeys?: string[];
}

const ACCENT = '#8A5CF6';

export const TVProviderSettingsModal: React.FC<TVProviderSettingsModalProps> = ({
  visible,
  provider,
  onClose,
  hiddenKeys,
}) => {
  const [fields, setFields] = useState<SettingsField[]>([]);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(false);

  const loadSchemaAndValues = useCallback(async () => {
    if (!provider) return;
    setLoading(true);
    try {
      const schema = (
        await providerManager.getSettingsSchema({
          providerValue: provider.value,
          sourceAuthor: provider.source?.author,
        })
      ).filter((f) => !hiddenKeys?.includes(f.key));
      setFields(schema);

      const initial: Record<string, unknown> = {};
      for (const field of schema) {
        const raw = providerKvStorage.getString(getScopedKvKey(provider.value, field.key));
        if (raw !== undefined && raw !== null) {
          try {
            initial[field.key] = JSON.parse(raw);
          } catch {
            initial[field.key] = raw;
          }
        } else if (field.defaultValue !== undefined) {
          initial[field.key] = field.defaultValue;
        }
      }
      setValues(initial);
    } catch (err) {
      console.error('Failed to load settings schema:', err);
    } finally {
      setLoading(false);
    }
  }, [provider, hiddenKeys]);

  useEffect(() => {
    if (visible && provider) {
      loadSchemaAndValues();
    } else {
      setFields([]);
      setValues({});
    }
  }, [visible, provider, loadSchemaAndValues]);

  const handleChange = (key: string, val: unknown) =>
    setValues((prev) => ({ ...prev, [key]: val }));

  const handleSave = () => {
    if (!provider) return;
    // Only touches keys that are shown here, so hidden ones (e.g. skip
    // timings) are never overwritten.
    for (const field of fields) {
      const value = values[field.key];
      const scopedKey = getScopedKvKey(provider.value, field.key);
      if (value === undefined || value === null || value === '') {
        providerKvStorage.delete(scopedKey);
      } else {
        providerKvStorage.setString(scopedKey, JSON.stringify(value));
      }
    }
    ToastAndroid.show('Settings saved', ToastAndroid.SHORT);
    onClose();
  };

  const handleReset = () => {
    if (!provider) return;
    // Deliberately not `clearProviderStorage` -- that wipes every key for
    // the provider, including hidden ones this dialog doesn't own.
    const defaults: Record<string, unknown> = {};
    for (const field of fields) {
      providerKvStorage.delete(getScopedKvKey(provider.value, field.key));
      if (field.defaultValue !== undefined) defaults[field.key] = field.defaultValue;
    }
    setValues(defaults);
    ToastAndroid.show('Reset to defaults', ToastAndroid.SHORT);
  };

  if (!visible || !provider) return null;

  const canSave = !loading && fields.length > 0;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.box}>
          <View style={styles.header}>
            <View style={styles.iconWrap}>
              {provider.icon ? (
                <Image source={{ uri: provider.icon }} style={styles.icon} resizeMode="contain" />
              ) : (
                <MaterialCommunityIcons name="cog-outline" size={24} color={ACCENT} />
              )}
            </View>
            <View>
              <Text style={styles.title}>{provider.display_name} Settings</Text>
              <Text style={styles.subtitle}>Configure provider options</Text>
            </View>
          </View>

          {loading ? (
            <View style={styles.center}>
              <ActivityIndicator size="large" color={ACCENT} />
              <Text style={styles.subtitle}>Loading settings...</Text>
            </View>
          ) : fields.length === 0 ? (
            <View style={styles.center}>
              <MaterialCommunityIcons name="tune-vertical" size={40} color="#6B7280" />
              <Text style={styles.subtitle}>No configurable settings for this provider.</Text>
            </View>
          ) : (
            <ScrollView
              style={styles.body}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.bodyContent}
            >
              {fields.map((field, fieldIndex) => {
                const current = values[field.key];
                const isFirst = fieldIndex === 0;

                if (field.type === 'toggle') {
                  const on = Boolean(current);
                  return (
                    <TVFocusablePressable
                      key={field.key}
                      hasTVPreferredFocus={isFirst}
                      scaleFocused={1.02}
                      focusedBorderColor={ACCENT}
                      borderRadius={12}
                      onPress={() => handleChange(field.key, !on)}
                      style={styles.card}
                    >
                      {() => (
                        <View style={styles.toggleRow}>
                          <View style={styles.flex}>
                            <Text style={styles.label}>{field.label}</Text>
                            {field.description ? (
                              <Text style={styles.desc}>{field.description}</Text>
                            ) : null}
                          </View>
                          <View style={[styles.pill, on && styles.pillOn]}>
                            <Text style={[styles.pillText, on && styles.pillTextOn]}>
                              {on ? 'ON' : 'OFF'}
                            </Text>
                          </View>
                        </View>
                      )}
                    </TVFocusablePressable>
                  );
                }

                if (field.type === 'select') {
                  return (
                    <View key={field.key} style={styles.card}>
                      <Text style={styles.label}>{field.label}</Text>
                      {field.description ? <Text style={styles.desc}>{field.description}</Text> : null}
                      <View style={styles.optionList}>
                        {field.options.map((opt, optIndex) => {
                          const selected = current === opt.value;
                          return (
                            <TVFocusablePressable
                              key={opt.value}
                              hasTVPreferredFocus={isFirst && optIndex === 0}
                              scaleFocused={1.02}
                              focusedBorderColor={ACCENT}
                              borderRadius={10}
                              onPress={() => handleChange(field.key, opt.value)}
                              style={[styles.option, selected && styles.optionSelected]}
                            >
                              {() => (
                                <View style={styles.optionRow}>
                                  <Text
                                    style={[styles.optionText, selected && styles.optionTextSelected]}
                                  >
                                    {opt.label}
                                  </Text>
                                  <MaterialCommunityIcons
                                    name={selected ? 'radiobox-marked' : 'radiobox-blank'}
                                    size={20}
                                    color={selected ? ACCENT : '#6B7280'}
                                  />
                                </View>
                              )}
                            </TVFocusablePressable>
                          );
                        })}
                      </View>
                    </View>
                  );
                }

                if (field.type === 'multiselect') {
                  const list: string[] = Array.isArray(current) ? (current as string[]) : [];
                  return (
                    <View key={field.key} style={styles.card}>
                      <Text style={styles.label}>{field.label}</Text>
                      {field.description ? <Text style={styles.desc}>{field.description}</Text> : null}
                      <View style={styles.optionList}>
                        {field.options.map((opt, optIndex) => {
                          const selected = list.includes(opt.value);
                          return (
                            <TVFocusablePressable
                              key={opt.value}
                              hasTVPreferredFocus={isFirst && optIndex === 0}
                              scaleFocused={1.02}
                              focusedBorderColor={ACCENT}
                              borderRadius={10}
                              onPress={() =>
                                handleChange(
                                  field.key,
                                  selected
                                    ? list.filter((v) => v !== opt.value)
                                    : [...list, opt.value],
                                )
                              }
                              style={[styles.option, selected && styles.optionSelected]}
                            >
                              {() => (
                                <View style={styles.optionRow}>
                                  <Text
                                    style={[styles.optionText, selected && styles.optionTextSelected]}
                                  >
                                    {opt.label}
                                  </Text>
                                  <MaterialCommunityIcons
                                    name={selected ? 'checkbox-marked' : 'checkbox-blank-outline'}
                                    size={20}
                                    color={selected ? ACCENT : '#6B7280'}
                                  />
                                </View>
                              )}
                            </TVFocusablePressable>
                          );
                        })}
                      </View>
                    </View>
                  );
                }

                // number + text: a focusable wrapper, since a bare TextInput
                // on TV only takes the D-pad once it's focused.
                const isNumber = field.type === 'number';
                return (
                  <View key={field.key} style={styles.card}>
                    <Text style={styles.label}>{field.label}</Text>
                    {field.description ? <Text style={styles.desc}>{field.description}</Text> : null}
                    <TextInput
                      value={
                        isNumber
                          ? current !== undefined
                            ? String(current)
                            : ''
                          : typeof current === 'string'
                          ? current
                          : ''
                      }
                      onChangeText={(text) => {
                        if (isNumber) {
                          const num = Number(text);
                          handleChange(field.key, text === '' || isNaN(num) ? undefined : num);
                        } else {
                          handleChange(field.key, text);
                        }
                      }}
                      {...({ hasTVPreferredFocus: isFirst } as any)}
                      keyboardType={isNumber ? 'numeric' : 'default'}
                      placeholder={!isNumber ? (field as any).placeholder : undefined}
                      placeholderTextColor="#6B7280"
                      autoCapitalize="none"
                      autoCorrect={false}
                      style={styles.input}
                    />
                  </View>
                );
              })}
            </ScrollView>
          )}

          <View style={styles.footer}>
            <TVFocusablePressable
              focusable={canSave}
              scaleFocused={1.05}
              focusedBorderColor="#FFFFFF"
              borderRadius={10}
              onPress={handleReset}
              style={[styles.footerBtn, styles.resetBtn, !canSave && styles.disabled]}
            >
              {() => (
                <View style={styles.btnContent}>
                  <MaterialCommunityIcons name="restore" size={18} color="#D1D5DB" />
                  <Text style={styles.cancelText}>Reset</Text>
                </View>
              )}
            </TVFocusablePressable>

            <View style={styles.flex} />

            <TVFocusablePressable
              hasTVPreferredFocus={!loading && fields.length === 0}
              scaleFocused={1.05}
              focusedBorderColor="#FFFFFF"
              borderRadius={10}
              onPress={onClose}
              style={[styles.footerBtn, styles.cancelBtn]}
            >
              {() => <Text style={styles.cancelText}>Cancel</Text>}
            </TVFocusablePressable>

            <TVFocusablePressable
              focusable={canSave}
              scaleFocused={1.05}
              focusedBorderColor="#FFFFFF"
              borderRadius={10}
              onPress={handleSave}
              style={[styles.footerBtn, styles.saveBtn, !canSave && styles.disabled]}
            >
              {() => <Text style={styles.saveText}>Save Changes</Text>}
            </TVFocusablePressable>
          </View>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.85)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  box: {
    width: 720,
    maxHeight: '90%',
    backgroundColor: '#16161E',
    borderRadius: 20,
    padding: 24,
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingBottom: 14,
    marginBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.08)',
  },
  iconWrap: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  icon: { width: 32, height: 32, borderRadius: 6 },
  title: { color: '#FFFFFF', fontSize: 20, fontWeight: '800' },
  subtitle: { color: '#9CA3AF', fontSize: 13, marginTop: 2 },
  center: { alignItems: 'center', justifyContent: 'center', paddingVertical: 40, gap: 10 },
  body: { flexGrow: 0 },
  bodyContent: { gap: 12, paddingVertical: 4, paddingHorizontal: 4 },
  card: {
    backgroundColor: '#1C1C26',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.06)',
  },
  label: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  desc: { color: '#9CA3AF', fontSize: 12, marginTop: 3, lineHeight: 17 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  flex: { flex: 1 },
  pill: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  pillOn: { backgroundColor: ACCENT },
  pillText: { color: '#9CA3AF', fontSize: 13, fontWeight: '800' },
  pillTextOn: { color: '#FFFFFF' },
  optionList: { marginTop: 10, gap: 6 },
  option: {
    backgroundColor: '#0A0A0E',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1.5,
  },
  optionSelected: { backgroundColor: '#1E1B2E', borderColor: 'rgba(138, 92, 246, 0.5)' },
  optionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  optionText: { color: '#D1D5DB', fontSize: 14, fontWeight: '500', flex: 1, paddingRight: 12 },
  optionTextSelected: { color: ACCENT, fontWeight: '700' },
  input: {
    marginTop: 10,
    backgroundColor: '#0A0A0E',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.15)',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: '#FFFFFF',
    fontSize: 15,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 14,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.08)',
  },
  footerBtn: { paddingVertical: 10, paddingHorizontal: 20 },
  btnContent: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  resetBtn: { backgroundColor: 'rgba(255, 255, 255, 0.08)' },
  cancelBtn: { backgroundColor: 'rgba(255, 255, 255, 0.08)' },
  saveBtn: { backgroundColor: ACCENT },
  disabled: { opacity: 0.4 },
  cancelText: { color: '#D1D5DB', fontSize: 14, fontWeight: '600' },
  saveText: { color: '#FFFFFF', fontSize: 14, fontWeight: '700' },
});

export default TVProviderSettingsModal;
