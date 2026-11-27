import React, {useEffect, useRef} from 'react';
import {Animated, Easing, Modal, StyleSheet, Text, View} from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import {BlurView} from 'expo-blur';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import {TVFocusablePressable} from './TVFocusablePressable';
import useUpdatePanelStore from '../../lib/zustand/updatePanelStore';
import {
  cancelUpdateDownload,
  installDownloadedUpdate,
  useUpdateStore,
} from '../../lib/services/AppUpdater';

/**
 * "Update available" pop-up. Glass styled after tvBuddy's floating-navbar
 * playlist menu: a dark panel at ~30% opacity over a strong blur, large
 * rounded corners, a thin light rim, and soft rounded pill rows/buttons.
 *
 * Like Nuvio TV's update banner, the panel itself is the progress bar: while
 * the APK downloads, an accent fill sweeps across the whole glass from left
 * to right and the status line reads "Downloading 42%" with size, speed and
 * time left. The same panel then turns into "Download complete" / "Install",
 * or an error with Retry.
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

// Glass look (tvBuddy playlist menu): panel fill opacity and blur strength.
const GLASS_FILL_OPACITY = 0.6;
const GLASS_BLUR = 70;
const ACCENT = '138,92,246';

const formatBytes = (n: number): string => {
  if (!Number.isFinite(n) || n <= 0) return '0 MB';
  const mb = n / (1024 * 1024);
  return mb >= 100 ? `${mb.toFixed(0)} MB` : `${mb.toFixed(1)} MB`;
};

const formatEta = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const s = Math.ceil(seconds);
  if (s < 60) return `${s}s left`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s left`;
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
    borderRadius={20}
    onPress={onPress}
    style={[styles.btn, primary && styles.btnPrimary]}>
    {({focused}) => (
      <View
        style={[
          styles.btnInner,
          primary && styles.btnInnerPrimary,
          focused && (primary ? styles.btnInnerPrimaryFocused : styles.btnInnerFocused),
        ]}>
        <MaterialCommunityIcons name={icon as any} size={20} color="#FFFFFF" />
        <Text style={styles.btnText}>{label}</Text>
      </View>
    )}
  </TVFocusablePressable>
);

const UpdateGlassPanel = () => {
  const panel = useUpdatePanelStore(s => s.panel);
  const dismiss = useUpdatePanelStore(s => s.dismiss);
  const status = useUpdateStore(s => s.status);
  const progress = useUpdateStore(s => s.progress);
  const received = useUpdateStore(s => s.received);
  const total = useUpdateStore(s => s.total);
  const speedBps = useUpdateStore(s => s.speedBps);
  const error = useUpdateStore(s => s.error);

  const downloading = status === 'downloading';
  const ready = status === 'ready';
  const failed = status === 'error';

  // Fill width follows progress smoothly between the native 250 ms ticks.
  const fill = useRef(new Animated.Value(0)).current;
  const target = ready ? 1 : downloading ? progress : 0;
  useEffect(() => {
    Animated.timing(fill, {
      toValue: target,
      duration: target === 0 ? 0 : 300,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false,
    }).start();
  }, [fill, target]);

  if (!panel) return null;
  const notes = toPlainNotes(panel.notes);
  const pct = Math.round(Math.min(1, Math.max(0, progress)) * 100);

  let statusLine = `Vega TV ${panel.newVersion} is ready to install.`;
  let detailLine = '';
  if (downloading) {
    statusLine = total > 0 && received > 0 ? `Downloading ${pct}%` : 'Preparing download…';
    if (total > 0 && received > 0) {
      const eta = speedBps > 0 ? formatEta((total - received) / speedBps) : '';
      detailLine = [
        `${formatBytes(received)} / ${formatBytes(total)}`,
        speedBps > 0 ? `${formatBytes(speedBps)}/s` : '',
        eta,
      ]
        .filter(Boolean)
        .join('  ·  ');
    }
  } else if (ready) {
    statusLine = 'Download complete';
    detailLine = error || 'Tap Install to finish updating.';
  } else if (failed) {
    statusLine = 'Update failed';
    detailLine = error || 'Something went wrong.';
  } else if (panel && total > 0) {
    detailLine = formatBytes(total);
  }

  const fillWidth = fill.interpolate({
    inputRange: [0, 1],
    outputRange: ['0%', '100%'],
  });

  return (
    <Modal
      transparent
      animationType="fade"
      visible
      onRequestClose={() => {
        if (downloading) cancelUpdateDownload();
        else dismiss();
      }}>
      <View style={styles.scrim}>
        <View style={styles.glass}>
          {/* Strong blur under a dark ~30% fill (see styles.glass / tint). */}
          <BlurView
            intensity={GLASS_BLUR}
            tint="dark"
            experimentalBlurMethod="dimezisBlurView"
            style={StyleSheet.absoluteFill}
          />
          <View pointerEvents="none" style={styles.tint} />
          <LinearGradient
            pointerEvents="none"
            colors={['rgba(255,255,255,0.10)', 'rgba(255,255,255,0.02)', 'rgba(255,255,255,0.05)']}
            start={{x: 0, y: 0}}
            end={{x: 1, y: 1}}
            style={StyleSheet.absoluteFill}
          />

          {/* Download progress: the glass fills left to right. */}
          <Animated.View pointerEvents="none" style={[styles.fillClip, {width: fillWidth}]}>
            <LinearGradient
              colors={[`rgba(${ACCENT},0.42)`, 'rgba(167,139,250,0.30)']}
              start={{x: 0, y: 0}}
              end={{x: 1, y: 0}}
              style={StyleSheet.absoluteFill}
            />
            <View style={styles.fillEdge} />
          </Animated.View>

          <View pointerEvents="none" style={styles.topEdge} />
          <View pointerEvents="none" style={styles.rim} />

          <View style={styles.header}>
            <View style={styles.iconBubble}>
              <MaterialCommunityIcons
                name={
                  failed
                    ? 'alert-circle-outline'
                    : ready
                    ? 'check-circle-outline'
                    : 'cloud-download-outline'
                }
                size={28}
                color="#FFFFFF"
              />
            </View>
            <View style={styles.headerText}>
              <Text style={styles.title}>
                {downloading ? 'Updating Vega TV' : ready ? 'Ready to install' : 'Update available'}
              </Text>
              <View style={styles.versionRow}>
                <Text style={styles.versionOld}>{panel.installedVersion}</Text>
                <MaterialCommunityIcons name="arrow-right" size={16} color="#E5E7EB" />
                <Text style={styles.versionNew}>{panel.newVersion}</Text>
                {panel.prerelease ? (
                  <View style={styles.tag}>
                    <Text style={styles.tagText}>CANARY</Text>
                  </View>
                ) : null}
              </View>
            </View>
          </View>

          <View pointerEvents="none" style={styles.divider} />

          <View style={styles.statusBlock}>
            <Text style={styles.statusLine}>{statusLine}</Text>
            {detailLine ? (
              <Text style={[styles.detailLine, failed && styles.detailError]}>{detailLine}</Text>
            ) : null}
          </View>

          {notes && !downloading ? (
            <View style={styles.notes}>
              <Text numberOfLines={8} style={styles.notesText}>
                {notes}
              </Text>
            </View>
          ) : null}

          <View style={styles.actions}>
            {downloading ? (
              <GlassButton
                label="Cancel"
                icon="close"
                preferred
                onPress={cancelUpdateDownload}
              />
            ) : ready ? (
              <>
                <GlassButton label="Close" icon="close" onPress={dismiss} />
                <GlassButton
                  label="Install"
                  icon="package-variant-closed"
                  primary
                  preferred
                  onPress={() => {
                    installDownloadedUpdate();
                  }}
                />
              </>
            ) : failed ? (
              <>
                <GlassButton label="Close" icon="close" onPress={dismiss} />
                <GlassButton
                  label="Retry"
                  icon="refresh"
                  primary
                  preferred
                  onPress={panel.onUpdate}
                />
              </>
            ) : (
              <>
                <GlassButton label="Later" icon="clock-outline" onPress={dismiss} />
                <GlassButton
                  label="Update now"
                  icon="download"
                  primary
                  preferred
                  onPress={panel.onUpdate}
                />
              </>
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.28)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  glass: {
    width: 640,
    maxWidth: '88%',
    borderRadius: 28,
    overflow: 'hidden',
    padding: 28,
    backgroundColor: `rgba(18, 22, 34, ${GLASS_FILL_OPACITY})`,
  },
  tint: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: `rgba(18, 22, 34, ${GLASS_FILL_OPACITY})`,
  },
  divider: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.22)',
    marginBottom: 14,
  },
  fillClip: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    overflow: 'hidden',
  },
  fillEdge: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 0,
    width: 2,
    backgroundColor: 'rgba(255,255,255,0.55)',
  },
  topEdge: {
    position: 'absolute',
    top: 0,
    left: 18,
    right: 18,
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.30)',
  },
  rim: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 28,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.34)',
  },
  header: {flexDirection: 'row', alignItems: 'center', marginBottom: 18},
  iconBubble: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.14)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.32)',
    marginRight: 16,
  },
  headerText: {flex: 1},
  title: {
    color: '#FFFFFF',
    fontSize: 26,
    fontWeight: '800',
    textShadowColor: 'rgba(0,0,0,0.35)',
    textShadowRadius: 6,
  },
  versionRow: {flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4},
  versionOld: {color: '#E5E7EB', fontSize: 15, fontWeight: '600'},
  versionNew: {color: '#FFFFFF', fontSize: 15, fontWeight: '800'},
  tag: {
    backgroundColor: 'rgba(250, 204, 21, 0.22)',
    borderColor: 'rgba(250, 204, 21, 0.55)',
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 1,
    marginLeft: 4,
  },
  tagText: {color: '#FDE68A', fontSize: 11, fontWeight: '800', letterSpacing: 0.6},
  statusBlock: {marginBottom: 4},
  statusLine: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
    textShadowColor: 'rgba(0,0,0,0.35)',
    textShadowRadius: 6,
  },
  detailLine: {color: '#E5E7EB', fontSize: 14, marginTop: 4},
  detailError: {color: '#FCA5A5'},
  notes: {
    marginTop: 12,
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  notesText: {
    color: '#F3F4F6',
    fontSize: 14,
    lineHeight: 20,
    textShadowColor: 'rgba(0,0,0,0.3)',
    textShadowRadius: 4,
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
    paddingVertical: 13,
    paddingHorizontal: 24,
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  btnInnerFocused: {backgroundColor: 'rgba(255,255,255,0.24)'},
  btnInnerPrimary: {
    backgroundColor: `rgba(${ACCENT},0.30)`,
  },
  btnInnerPrimaryFocused: {backgroundColor: `rgba(${ACCENT},0.55)`},
  btnText: {color: '#FFFFFF', fontSize: 16, fontWeight: '800'},
});

export default UpdateGlassPanel;
