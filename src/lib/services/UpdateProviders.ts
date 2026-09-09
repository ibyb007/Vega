import { extensionStorage, ProviderExtension } from '../storage/extensionStorage';
import { extensionManager } from './ExtensionManager';
import { settingsStorage } from '../storage';
import useContentStore from '../zustand/contentStore';

export interface UpdateInfo {
  provider: ProviderExtension;
  hasUpdate: boolean;
  latestVersion?: string;
}

class UpdateProvidersService {
  private intervalId: NodeJS.Timeout | null = null;

  async checkForUpdatesManual(force = false): Promise<UpdateInfo[]> {
    const source = extensionStorage.getProviderSource();
    if (!source) {
      return [];
    }

    try {
      const availableProviders = await extensionManager.fetchManifest(source, force);
      const installedProviders = extensionStorage.getInstalledProviders() || [];

      const updates: UpdateInfo[] = [];

      for (const installed of installedProviders) {
        const available = availableProviders.find(
          p => p.value === installed.value && p.source?.author === installed.source?.author
        );

        if (available && this.isNewerVersion(installed.version, available.version)) {
          updates.push({
            provider: available,
            hasUpdate: true,
            latestVersion: available.version,
          });
        }
      }

      return updates;
    } catch (error) {
      console.warn('[UpdateProviders] Check failed:', error);
      return [];
    }
  }

  async updateProvider(provider: ProviderExtension): Promise<boolean> {
    try {
      await extensionManager.installProvider(provider);
      return true;
    } catch (error) {
      console.error('[UpdateProviders] Failed to update provider:', error);
      return false;
    }
  }

  startAutomaticUpdateCheck() {
    if (this.intervalId) return;

    // Check on startup
    this.checkForUpdatesManual(false).catch(() => {});

    // Periodic check every 6 hours
    this.intervalId = setInterval(() => {
      this.checkForUpdatesManual(true).catch(() => {});
    }, 6 * 60 * 60 * 1000);
  }

  stopAutomaticUpdateCheck() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private isNewerVersion(current?: string, latest?: string): boolean {
    if (!latest) return false;
    if (!current) return true;

    const currentParts = current.split('.').map(Number);
    const latestParts = latest.split('.').map(Number);

    for (let i = 0; i < Math.max(currentParts.length, latestParts.length); i++) {
      const c = currentParts[i] || 0;
      const l = latestParts[i] || 0;
      if (l > c) return true;
      if (l < c) return false;
    }

    return false;
  }
}

export const updateProvidersService = new UpdateProvidersService();
