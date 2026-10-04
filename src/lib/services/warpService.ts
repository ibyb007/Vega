import {NativeModules, Platform, ToastAndroid} from 'react-native';
import {settingsStorage} from '../storage';

const {WarpModule, ByeDpiModule} = NativeModules;

export interface WarpStatus {
  running: boolean;
  port?: number;
}

export const isWarpSupported = (): boolean => {
  return Platform.OS === 'android' && Boolean(WarpModule);
};

export const startWarp = async (): Promise<WarpStatus> => {
  if (!isWarpSupported()) {
    return {running: false};
  }
  return await WarpModule.startWarp();
};

export const stopWarp = async (): Promise<WarpStatus> => {
  if (!isWarpSupported()) {
    return {running: false};
  }
  return await WarpModule.stopWarp();
};

export const getWarpStatus = async (): Promise<WarpStatus> => {
  if (!isWarpSupported()) {
    return {running: false};
  }
  return await WarpModule.getStatus();
};

export const toggleWarp = async (enabled: boolean): Promise<WarpStatus> => {
  settingsStorage.setWarpEnabled(enabled);
  if (enabled) {
    // Mutually exclusive with ByeDPI -- both tunnel all app traffic through
    // a local proxy, so only one can usefully be active at a time.
    settingsStorage.setByeDpiEnabled(false);
    if (ByeDpiModule) {
      ByeDpiModule.stopByeDpi().catch(() => {});
    }
    return await startWarp();
  }
  return await stopWarp();
};

// Called once on app start so a previously-enabled WARP tunnel comes back up
// automatically (mirrors syncDohSettings' role for DoH).
export const syncWarpSettings = async (): Promise<void> => {
  if (!isWarpSupported()) {
    return;
  }
  const enabled = settingsStorage.isWarpEnabled();
  if (enabled) {
    try {
      await startWarp();
    } catch (e) {
      console.warn('[WARP] Startup initialization warning:', e);
      ToastAndroid.show('Failed to start WARP.', ToastAndroid.SHORT);
    }
  } else {
    await stopWarp();
  }
};
