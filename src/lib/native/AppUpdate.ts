import { NativeModules, NativeEventEmitter, Platform } from 'react-native';

const { AppUpdateModule } = NativeModules as {
  AppUpdateModule?: {
    getSupportedAbis(): Promise<string[]>;
    canInstallPackages(): Promise<boolean>;
    openInstallPermissionSettings(): Promise<boolean>;
    downloadApk(url: string, fileName: string): Promise<string>;
    cancelDownload(): void;
    installApk(path: string): Promise<boolean>;
    addListener(eventName: string): void;
    removeListeners(count: number): void;
  };
};

const emitter = AppUpdateModule ? new NativeEventEmitter(AppUpdateModule as any) : null;

/**
 * JS face of the native updater (native-src/android/com/vega/
 * AppUpdateModule.kt): download an APK with progress, then open the system
 * installer. `available` is false when the module isn't linked.
 */
export const AppUpdate = {
  available: Platform.OS === 'android' && !!AppUpdateModule,

  getSupportedAbis: async (): Promise<string[]> => {
    try {
      return (await AppUpdateModule?.getSupportedAbis()) ?? [];
    } catch {
      return [];
    }
  },

  canInstallPackages: async (): Promise<boolean> => {
    try {
      return (await AppUpdateModule?.canInstallPackages()) ?? true;
    } catch {
      return true;
    }
  },

  openInstallPermissionSettings: async (): Promise<boolean> => {
    try {
      return (await AppUpdateModule?.openInstallPermissionSettings()) ?? false;
    } catch {
      return false;
    }
  },

  downloadApk: (url: string, fileName: string): Promise<string> => {
    if (!AppUpdateModule) return Promise.reject(new Error('Updater is not available'));
    return AppUpdateModule.downloadApk(url, fileName);
  },

  cancelDownload: () => AppUpdateModule?.cancelDownload(),

  installApk: (path: string): Promise<boolean> => {
    if (!AppUpdateModule) return Promise.reject(new Error('Updater is not available'));
    return AppUpdateModule.installApk(path);
  },

  onProgress: (cb: (received: number, total: number) => void) => {
    const sub = emitter?.addListener('VegaAppUpdateProgress', (e: { received: number; total: number }) =>
      cb(e.received, e.total),
    );
    return () => sub?.remove();
  },
};
