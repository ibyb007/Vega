import Constants from 'expo-constants';
import * as Application from 'expo-application';
import { create } from 'zustand';
import { UPDATE_REPO } from '../constants';
import { settingsStorage } from '../storage';
import { AppUpdate } from '../native/AppUpdate';

export type UpdateChannel = 'stable' | 'canary';

export interface ReleaseInfo {
  tag: string;
  name: string;
  version: string;
  // 0 for a stable release, N for canary "version (N)".
  canaryNumber: number;
  // What to show people: "5.2.0" or "5.2.0 (1)".
  displayVersion: string;
  prerelease: boolean;
  notes: string;
  apkUrl: string;
  apkName: string;
  apkSize: number;
}

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'uptodate'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error';

interface UpdateState {
  status: UpdateStatus;
  release: ReleaseInfo | null;
  progress: number; // 0..1 while downloading
  received: number; // bytes so far
  total: number; // bytes expected (0 until known)
  speedBps: number; // smoothed bytes per second
  apkPath: string | null;
  error: string | null;
  lastChecked: number | null;
  set: (partial: Partial<UpdateState>) => void;
}

export const useUpdateStore = create<UpdateState>((set) => ({
  status: 'idle',
  release: null,
  progress: 0,
  received: 0,
  total: 0,
  speedBps: 0,
  apkPath: null,
  error: null,
  lastChecked: null,
  set: (partial) => set(partial),
}));

const patch = (partial: Partial<UpdateState>) => useUpdateStore.getState().set(partial);

// ---- installed build --------------------------------------------------------

export const getInstalledVersionName = (): string =>
  Application.nativeApplicationVersion || Constants.expoConfig?.version || '0.0.0';

// Canary builds are "5.2.0 (N)"; stable builds have no number.
export const getInstalledCanaryNumber = (): number => {
  const n = Number(Constants.expoConfig?.extra?.canaryNumber ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

export const formatVersion = (version: string, canaryNumber: number): string =>
  canaryNumber > 0 ? `${version} (${canaryNumber})` : version;

export const getInstalledDisplayVersion = (): string =>
  formatVersion(getInstalledVersionName(), getInstalledCanaryNumber());

export const getBuildChannel = (): UpdateChannel =>
  Constants.expoConfig?.extra?.updateChannel === 'canary' ? 'canary' : 'stable';

export const getUpdateChannel = (): UpdateChannel =>
  settingsStorage.getUpdateChannel() ?? getBuildChannel();

// ---- GitHub releases --------------------------------------------------------

// Tags are made by tv.yml: "v5.2.0" for stable, "v5.2.0-canary.1" for the
// first canary after stable 5.2.0. Builds are ordered by version, then by
// canary number (stable = 0), so 5.2.0 < 5.2.0 (1) < 5.2.0 (2) < 5.3.0.
const TAG_RE = /^v?(\d+(?:\.\d+)*)(?:-canary\.(\d+))?/;

const parseTag = (tag: string): { version: string; canaryNumber: number } | null => {
  const m = TAG_RE.exec(tag);
  if (!m) return null;
  return { version: m[1], canaryNumber: m[2] ? parseInt(m[2], 10) : 0 };
};

const compareBuilds = (
  a: { version: string; canaryNumber: number },
  b: { version: string; canaryNumber: number },
): number => {
  const pa = a.version.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.version.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return a.canaryNumber - b.canaryNumber;
};

const pickApk = (assets: any[], abis: string[]) => {
  const apks = (assets || []).filter(
    (a) => typeof a?.name === 'string' && a.name.toLowerCase().endsWith('.apk'),
  );
  for (const abi of abis) {
    const hit = apks.find((a) => a.name.includes(abi));
    if (hit) return hit;
  }
  return apks.find((a) => a.name.toLowerCase().includes('universal')) || null;
};

const fetchJson = async (url: string): Promise<any> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
};

/** Short, readable changelog lines out of a release body (max 4). */
const summariseNotes = (body: string): string => {
  const lines = (body || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^[*-]\s+/.test(l) && !l.startsWith('* **'))
    .map((l) => l.replace(/^[*-]\s+/, '').replace(/\s*\([0-9a-f]{7,}\)\s*$/, ''));
  return lines.slice(0, 4).map((l) => `• ${l}`).join('\n');
};

/**
 * Newest release on the chosen channel that is newer than the installed
 * build (by version, then canary number), or null. Stable = full releases only. Canary = the newest build of
 * any kind (a canary user also gets stable builds that are newer).
 */
export const findLatestRelease = async (channel: UpdateChannel): Promise<ReleaseInfo | null> => {
  const list = await fetchJson(
    `https://api.github.com/repos/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/releases?per_page=30`,
  );
  if (!Array.isArray(list)) throw new Error('Unexpected response from GitHub');
  const abis = await AppUpdate.getSupportedAbis();

  let best: ReleaseInfo | null = null;
  for (const r of list) {
    if (r?.draft) continue;
    if (channel === 'stable' && r?.prerelease) continue;
    const parsed = parseTag(String(r?.tag_name || ''));
    if (!parsed) continue;
    const apk = pickApk(r.assets, abis);
    if (!apk) continue;
    if (best && compareBuilds(parsed, best) <= 0) continue;
    best = {
      tag: r.tag_name,
      name: r.name || r.tag_name,
      version: parsed.version,
      canaryNumber: parsed.canaryNumber,
      displayVersion: formatVersion(parsed.version, parsed.canaryNumber),
      prerelease: !!r.prerelease,
      notes: summariseNotes(r.body || ''),
      apkUrl: apk.browser_download_url,
      apkName: apk.name,
      apkSize: apk.size || 0,
    };
  }
  const installed = { version: getInstalledVersionName(), canaryNumber: getInstalledCanaryNumber() };
  if (!best || compareBuilds(best, installed) <= 0) return null;
  return best;
};

// ---- actions ----------------------------------------------------------------

let checking = false;

/** Returns the new release (if any). Never throws. */
export const checkForUpdates = async (): Promise<ReleaseInfo | null> => {
  const { status } = useUpdateStore.getState();
  if (checking || status === 'downloading') return useUpdateStore.getState().release;
  checking = true;
  patch({ status: 'checking', error: null });
  try {
    const release = await findLatestRelease(getUpdateChannel());
    if (release) {
      patch({ status: 'available', release, lastChecked: Date.now(), progress: 0, received: 0, total: 0, speedBps: 0, apkPath: null });
    } else {
      patch({ status: 'uptodate', release: null, lastChecked: Date.now() });
    }
    return release;
  } catch (e: any) {
    patch({ status: 'error', error: e?.message || 'Could not check for updates' });
    return null;
  } finally {
    checking = false;
  }
};

export const installDownloadedUpdate = async (): Promise<void> => {
  const { apkPath } = useUpdateStore.getState();
  if (!apkPath) return;
  if (!(await AppUpdate.canInstallPackages())) {
    patch({
      error: 'Allow Vega TV to install unknown apps, then choose Install again.',
    });
    await AppUpdate.openInstallPermissionSettings();
    return;
  }
  try {
    await AppUpdate.installApk(apkPath);
  } catch (e: any) {
    patch({ status: 'error', error: e?.message || 'Could not open the installer' });
  }
};

let cancelRequested = false;

/** Stops a running download; the release stays available to retry. */
export const cancelUpdateDownload = (): void => {
  if (useUpdateStore.getState().status !== 'downloading') return;
  cancelRequested = true;
  AppUpdate.cancelDownload();
};

/** Downloads the found release (parallel connections), then opens the installer. */
export const downloadAndInstallUpdate = async (): Promise<void> => {
  const { release, status } = useUpdateStore.getState();
  if (!release || status === 'downloading') return;
  cancelRequested = false;
  patch({ status: 'downloading', progress: 0, received: 0, total: release.apkSize, speedBps: 0, error: null });
  let lastAt = Date.now();
  let lastBytes = 0;
  let speed = 0;
  const off = AppUpdate.onProgress((received, total) => {
    const size = total > 0 ? total : release.apkSize;
    const now = Date.now();
    const dt = (now - lastAt) / 1000;
    if (dt >= 0.5) {
      const inst = (received - lastBytes) / dt;
      // Exponential smoothing keeps the readout from jumping around.
      speed = speed === 0 ? inst : speed * 0.7 + inst * 0.3;
      lastAt = now;
      lastBytes = received;
    }
    patch({
      progress: size > 0 ? Math.min(1, received / size) : 0,
      received,
      total: size,
      speedBps: speed,
    });
  });
  try {
    const path = await AppUpdate.downloadApk(release.apkUrl, release.apkName);
    patch({ status: 'ready', progress: 1, speedBps: 0, apkPath: path });
    await installDownloadedUpdate();
  } catch (e: any) {
    if (cancelRequested) {
      patch({ status: 'available', progress: 0, received: 0, speedBps: 0, error: null });
    } else {
      patch({ status: 'error', speedBps: 0, error: e?.message || 'Download failed' });
    }
  } finally {
    off();
  }
};
