import {NativeModules, Platform, ToastAndroid} from 'react-native';
import {settingsStorage} from '../storage';

const {ByeDpiModule, WarpModule} = NativeModules;

export const DEFAULT_BYEDPI_ARGS = '--split 1 --disorder 1 --auto=torst';

export interface ByeDpiPreset {
  id: string;
  name: string;
  args: string;
  description: string;
}

export const BYEDPI_PRESETS: ByeDpiPreset[] = [
  {
    id: 'split_disorder',
    name: 'Split & Disorder',
    args: '--split 1 --disorder 1 --auto=torst',
    description: 'Recommended for all networks and CDNs',
  },
  {
    id: 'disorder',
    name: 'Disorder only',
    args: '--disorder 1 --auto=torst',
    description: 'Reorders first byte to bypass SNI inspect',
  },
  {
    id: 'split',
    name: 'Split only',
    args: '--split 1',
    description: 'Splits TLS handshake into 2 segments',
  },
  {
    id: 'fake_oob',
    name: 'Fake packet (OOB)',
    args: '-s 1 -q 1 -Y',
    description: 'Aggressive bypass for strict firewalls',
  },
];

export interface ByeDpiStatus {
  running: boolean;
  port?: number;
}

export const isByeDpiSupported = (): boolean => {
  return Platform.OS === 'android' && Boolean(ByeDpiModule);
};

export const startByeDpi = async (
  customArgs?: string,
): Promise<ByeDpiStatus> => {
  if (!isByeDpiSupported()) {
    return {running: false};
  }
  const args = customArgs !== undefined ? customArgs : settingsStorage.getByeDpiCmdArgs();
  return await ByeDpiModule.startByeDpi(args || DEFAULT_BYEDPI_ARGS);
};

export const stopByeDpi = async (): Promise<ByeDpiStatus> => {
  if (!isByeDpiSupported()) {
    return {running: false};
  }
  return await ByeDpiModule.stopByeDpi();
};

export const getByeDpiStatus = async (): Promise<ByeDpiStatus> => {
  if (!isByeDpiSupported()) {
    return {running: false};
  }
  return await ByeDpiModule.getStatus();
};

export const toggleByeDpi = async (
  enabled: boolean,
  customArgs?: string,
): Promise<ByeDpiStatus> => {
  settingsStorage.setByeDpiEnabled(enabled);
  if (enabled) {
    // Mutually exclusive with WARP -- both tunnel all app traffic through a
    // local proxy, so only one can usefully be active at a time.
    settingsStorage.setWarpEnabled(false);
    if (WarpModule) {
      WarpModule.stopWarp().catch(() => {});
    }
    return await startByeDpi(customArgs);
  } else {
    return await stopByeDpi();
  }
};

// Called once on app start so a previously-enabled ByeDPI comes back up
// automatically (mirrors syncDohSettings/syncWarpSettings).
export const syncByeDpiSettings = async (): Promise<void> => {
  if (!isByeDpiSupported()) {
    return;
  }
  const enabled = settingsStorage.isByeDpiEnabled();
  // WARP and ByeDPI are mutually exclusive. ByeDPI defaults to on, so a user
  // who enabled WARP must not also get ByeDPI started at launch.
  if (enabled && settingsStorage.isWarpEnabled()) {
    await stopByeDpi();
    return;
  }
  if (enabled) {
    try {
      await startByeDpi();
    } catch (e) {
      console.warn('[ByeDPI] Startup initialization warning:', e);
      ToastAndroid.show('Failed to start ByeDPI.', ToastAndroid.SHORT);
    }
  } else {
    await stopByeDpi();
  }
};
