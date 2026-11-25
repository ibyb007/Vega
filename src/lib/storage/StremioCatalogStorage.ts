import {mainStorage} from './StorageService';

// Kept here (not imported from services/nuvioCatalog) so storage stays a leaf
// module; nuvioCatalog.ts re-uses the same URL.
export const NUVIO_CATALOG_MANIFEST_URL =
  'https://catalog.nuvio.tv/%7B%22language%22%3A%22en-GB%22%2C%22region%22%3A%22IN%22%7D/manifest.json';
export const CINEMETA_MANIFEST_URL = 'https://v3-cinemeta.strem.io/manifest.json';

/**
 * Storage keys for Stremio catalog manifests (used by the TV Discover tab).
 */
export enum StremioCatalogKeys {
  MANIFESTS = 'stremioCatalogManifests',
  HIDDEN_CATALOGS = 'stremioHiddenCatalogs',
  // One-time migration marker: Nuvio added, Cinemeta switched off by default.
  DEFAULTS_V2 = 'stremioCatalogDefaultsV2',
}

export interface StremioManifestEntry {
  url: string;
  name: string;
  addedAt: number;
  // Catalog sources can be switched off without removing them. Missing = on.
  enabled?: boolean;
}

export interface HiddenCatalogEntry {
  key: string; // `${manifestUrl}::${type}::${id}` -- see catalogKey() in TVDiscoverScreen
  name: string;
  manifestName: string;
}

// Nuvio is on out of the box; Cinemeta is listed but off (turn it on from the
// Catalogs dialog in Discover).
const DEFAULT_MANIFESTS: StremioManifestEntry[] = [
  {
    url: NUVIO_CATALOG_MANIFEST_URL,
    name: 'Nuvio',
    addedAt: 0,
    enabled: true,
  },
  {
    url: CINEMETA_MANIFEST_URL,
    name: 'Cinemeta',
    addedAt: 0,
    enabled: false,
  },
];

/**
 * Stremio catalog manifest storage manager. Mirrors the shape of
 * `ProvidersStorage` -- a small typed wrapper around MMKV.
 */
export class StremioCatalogStorage {
  /**
   * Get the list of manifests the user has added, seeding with Cinemeta
   * on first run so the Discover tab isn't empty out of the box.
   */
  getManifests(): StremioManifestEntry[] {
    const saved = mainStorage.getObject<StremioManifestEntry[]>(
      StremioCatalogKeys.MANIFESTS,
    );
    if (!saved || saved.length === 0) {
      this.setManifests(DEFAULT_MANIFESTS);
      mainStorage.setBool(StremioCatalogKeys.DEFAULTS_V2, true);
      return DEFAULT_MANIFESTS;
    }
    return this.migrateDefaults(saved);
  }

  /**
   * Existing installs only have Cinemeta (on). Once: add Nuvio (on) at the
   * front and switch Cinemeta off. Anything the user added is left alone, and
   * after this the toggles are entirely theirs.
   */
  private migrateDefaults(saved: StremioManifestEntry[]): StremioManifestEntry[] {
    if (mainStorage.getBool(StremioCatalogKeys.DEFAULTS_V2)) return saved;
    let next = saved.map(m =>
      m.url === CINEMETA_MANIFEST_URL ? {...m, enabled: false} : m,
    );
    if (!next.some(m => m.url === NUVIO_CATALOG_MANIFEST_URL)) {
      next = [DEFAULT_MANIFESTS[0], ...next];
    }
    this.setManifests(next);
    mainStorage.setBool(StremioCatalogKeys.DEFAULTS_V2, true);
    return next;
  }

  /** Manifests whose catalogs should appear in Discover. */
  getEnabledManifests(): StremioManifestEntry[] {
    return this.getManifests().filter(m => m.enabled !== false);
  }

  setManifestEnabled(url: string, enabled: boolean): StremioManifestEntry[] {
    const next = this.getManifests().map(m =>
      m.url === url ? {...m, enabled} : m,
    );
    this.setManifests(next);
    return next;
  }

  setManifests(manifests: StremioManifestEntry[]): void {
    mainStorage.setObject(StremioCatalogKeys.MANIFESTS, manifests);
  }

  /**
   * Adds a manifest URL if it isn't already present. Returns the updated
   * list. Throws if the URL is already added.
   */
  addManifest(url: string, name: string): StremioManifestEntry[] {
    const trimmed = url.trim();
    const current = this.getManifests();
    if (current.some((m) => m.url === trimmed)) {
      throw new Error('This catalog is already added');
    }
    const next = [...current, {url: trimmed, name, addedAt: Date.now(), enabled: true}];
    this.setManifests(next);
    return next;
  }

  removeManifest(url: string): StremioManifestEntry[] {
    const next = this.getManifests().filter((m) => m.url !== url);
    this.setManifests(next);
    return next;
  }

  /** Categories the user has long-pressed/hidden out of the catalog tab bar. */
  getHiddenCatalogs(): HiddenCatalogEntry[] {
    return (
      mainStorage.getObject<HiddenCatalogEntry[]>(StremioCatalogKeys.HIDDEN_CATALOGS) || []
    );
  }

  setHiddenCatalogs(entries: HiddenCatalogEntry[]): void {
    mainStorage.setObject(StremioCatalogKeys.HIDDEN_CATALOGS, entries);
  }

  hideCatalog(entry: HiddenCatalogEntry): HiddenCatalogEntry[] {
    const current = this.getHiddenCatalogs();
    if (current.some((c) => c.key === entry.key)) return current;
    const next = [...current, entry];
    this.setHiddenCatalogs(next);
    return next;
  }

  unhideCatalog(key: string): HiddenCatalogEntry[] {
    const next = this.getHiddenCatalogs().filter((c) => c.key !== key);
    this.setHiddenCatalogs(next);
    return next;
  }
}

export const stremioCatalogStorage = new StremioCatalogStorage();
