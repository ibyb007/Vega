import React from 'react';
import {Modal, StyleSheet, Text, View} from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import {BlurView} from 'expo-blur';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import {TVFocusablePressable} from './TVFocusablePressable';
import useUpdatePanelStore from '../../lib/zustand/updatePanelStore';

/**
 * "Update available" pop-up, in the app's liquid-glass look: a translucent
 * panel with a diagonal sheen, bright top edge and hairline rim. The release
 * text sits on its own small blurred, darkened plate so it stays readable over
 * whatever is behind the panel. Only that one small plate is blurred (a live
 * blur over the whole screen is too heavy for TV SoCs); the dark tint under it
 * keeps the text readable even where the blur isn't supported.
 */

// Notes are markdown; the panel shows a short plain-text version (no D-pad
// scrolling needed). Full notes stay on the release page.
const toPlainNotes = (notes?: string): string => {
  if (!notes) return '';
  return notes
    .replace(/\r/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/(\*\*|__|`)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

const GlassButton = ({
  label,
  icon,
  primary,
  preferred,
  onPress,
}: {
  label: string;
  icon: string;
  primary?: boolean;
  preferred?: boolean;
  onPress: () => void;
}) => (
  <TVFocusablePressable
    hasTVPreferredFocus={preferred}
    scaleFocused={1.05}
    focusedBorderColor="#FFFFFF"
    borderRadius={14}
    onPress={onPress}
    style={[styles.btn, primary && styles.btnPrimary]}>
    {({focused}) => (
      <View style={styles.btnInner}>
        <LinearGradient
          pointerEvents="none"
          colors={
            primary
              ? focused
                ? ['rgba(255,255,255,0.42)', 'rgba(167,139,250,0.34)', 'rgba(255,255,255,0.22)']
                : ['rgba(255,255,255,0.28)', 'rgba(138,92,246,0.28)', 'rgba(255,255,255,0.10)']
              : focused
              ? ['rgba(255,255,255,0.34)', 'rgba(255,255,255,0.12)', 'rgba(255,255,255,0.20)']
              : ['rgba(255,255,255,0.18)', 'rgba(255,255,255,0.04)', 'rgba(255,255,255,0.08)']
          }
          start={{x: 0, y: 0}}
          end={{x: 1, y: 1}}
          style={StyleSheet.absoluteFill}
        />
        <View pointerEvents="none" style={styles.topEdge} />
        <MaterialCommunityIcons name={icon as any} size={20} color="#FFFFFF" />
        <Text style={styles.btnText}>{label}</Text>
      </View>
    )}
  </TVFocusablePressable>
);

const UpdateGlassPanel = () => {
  const panel = useUpdatePanelStore(s => s.panel);
  const dismiss = useUpdatePanelStore(s => s.dismiss);

  if (!panel) return null;
  const notes = toPlainNotes(panel.notes);

  return (
    <Modal transparent animationType="fade" visible onRequestClose={dismiss}>
      <View style={styles.scrim}>
        <View style={styles.glass}>
          <LinearGradient
            pointerEvents="none"
            colors={['rgba(255,255,255,0.26)', 'rgba(138,92,246,0.14)', 'rgba(255,255,255,0.08)']}
            start={{x: 0, y: 0}}
            end={{x: 1, y: 1}}
            style={StyleSheet.absoluteFill}
          />
          <View pointerEvents="none" style={styles.topEdge} />
          <View pointerEvents="none" style={styles.rim} />

          <View style={styles.header}>
            <View style={styles.iconBubble}>
              <MaterialCommunityIcons name="cloud-download-outline" size={28} color="#FFFFFF" />
            </View>
            <View style={styles.headerText}>
              <Text style={styles.title}>Update available</Text>
              <View style={styles.versionRow}>
                <Text style={styles.versionOld}>{panel.installedVersion}</Text>
                <MaterialCommunityIcons name="arrow-right" size={16} color="#C4B5FD" />
                <Text style={styles.versionNew}>{panel.newVersion}</Text>
                {panel.prerelease ? (
                  <View style={styles.tag}>
                    <Text style={styles.tagText}>CANARY</Text>
                  </View>
                ) : null}
              </View>
            </View>
          </View>

          {/* Text plate: small blur + dark tint behind the words. */}
          <View style={styles.plate}>
            <BlurView
              intensity={28}
              tint="dark"
              // Real blur on Android (otherwise only the tint is drawn).
              experimentalBlurMethod="dimezisBlurView"
              style={StyleSheet.absoluteFill}
            />
            <View pointerEvents="none" style={styles.plateTint} />
            <Text style={styles.plateLead}>
              Vega TV {panel.newVersion} is ready to install.
            </Text>
            {notes ? (
              <Text numberOfLines={9} style={styles.plateNotes}>
                {notes}
              </Text>
            ) : null}
          </View>

          <View style={styles.actions}>
            <GlassButton label="Later" icon="clock-outline" onPress={dismiss} />
            <GlassButton
              label="Update now"
              icon="download"
              primary
              preferred
              onPress={() => {
                dismiss();
                panel.onUpdate();
              }}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(5, 5, 10, 0.62)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  glass: {
    width: 640,
    maxWidth: '88%',
    borderRadius: 26,
    overflow: 'hidden',
    padding: 28,
    backgroundColor: 'rgba(24, 20, 40, 0.55)',
  },
  topEdge: {
    position: 'absolute',
    top: 0,
    left: 18,
    right: 18,
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.65)',
  },
  rim: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 26,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.28)',
  },
  header: {flexDirection: 'row', alignItems: 'center', marginBottom: 18},
  iconBubble: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(138, 92, 246, 0.45)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.35)',
    marginRight: 16,
  },
  headerText: {flex: 1},
  title: {color: '#FFFFFF', fontSize: 26, fontWeight: '800'},
  versionRow: {flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4},
  versionOld: {color: '#D1D5DB', fontSize: 15, fontWeight: '600'},
  versionNew: {color: '#FFFFFF', fontSize: 15, fontWeight: '800'},
  tag: {
    backgroundColor: 'rgba(250, 204, 21, 0.25)',
    borderColor: 'rgba(250, 204, 21, 0.6)',
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 1,
    marginLeft: 4,
  },
  tagText: {color: '#FDE68A', fontSize: 11, fontWeight: '800', letterSpacing: 0.6},
  plate: {
    borderRadius: 16,
    overflow: 'hidden',
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  plateTint: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(8, 8, 16, 0.55)',
  },
  plateLead: {color: '#FFFFFF', fontSize: 17, fontWeight: '700'},
  plateNotes: {
    color: '#E5E7EB',
    fontSize: 14,
    lineHeight: 20,
    marginTop: 8,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 14,
    marginTop: 22,
  },
  btn: {overflow: 'hidden', minWidth: 140},
  btnPrimary: {minWidth: 170},
  btnInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 22,
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.28)',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  btnText: {color: '#FFFFFF', fontSize: 16, fontWeight: '800'},
});

export default UpdateGlassPanel;
