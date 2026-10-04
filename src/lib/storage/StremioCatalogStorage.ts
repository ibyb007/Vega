import {mainStorage} from './StorageService';

/**
 * Storage keys for Stremio catalog manifests (used by the TV Discover tab).
 */
export enum StremioCatalogKeys {
  MANIFESTS = 'stremioCatalogManifests',
  HIDDEN_CATALOGS = 'stremioHiddenCatalogs',
}

export interface StremioManifestEntry {
  url: string;
  name: string;
  addedAt: number;
}

export interface HiddenCatalogEntry {
  key: string; // `${manifestUrl}::${type}::${id}` -- see catalogKey() in TVDiscoverScreen
  name: string;
  manifestName: string;
}

const DEFAULT_MANIFESTS: StremioManifestEntry[] = [
  {
    url: 'https://v3-cinemeta.strem.io/manifest.json',
    name: 'Cinemeta',
    addedAt: 0,
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
      return DEFAULT_MANIFESTS;
    }
    return saved;
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
    const next = [...current, {url: trimmed, name, addedAt: Date.now()}];
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
