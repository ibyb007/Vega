import {createMMKV, type MMKV} from 'react-native-mmkv';
import type {StateStorage} from 'zustand/middleware';

/**
 * Interface for the StorageService class
 */
export interface IStorageService {
  getString(key: string): string | undefined;
  setString(key: string, value: string): void;
  getBool(key: string, defaultValue?: boolean): boolean;
  setBool(key: string, value: boolean): void;
  getNumber(key: string): number | undefined;
  setNumber(key: string, value: number): void;
  getObject<T>(key: string): T | undefined;
  setObject<T>(key: string, value: T): void;
  getArray<T>(key: string): T[] | undefined;
  setArray<T>(key: string, value: T[]): void;
  delete(key: string): void;
  contains(key: string): boolean;
  clearAll(): void;
  getKeys(): Promise<string[]>;
}

/**
 * Base storage service that wraps MMKV operations.
 *
 * Uses `react-native-mmkv` v4 (Nitro-based). The underlying native MMKV
 * instance is created LAZILY on first use rather than in the constructor.
 * Creating several Nitro MMKV HybridObjects back-to-back at module-load
 * time (as mainStorage/cacheStorage/providerKvStorage all being
 * instantiated eagerly would do) has known startup issues on Android
 * (see https://github.com/mrousavy/react-native-mmkv/issues/937) -
 * spreading instance creation out over time avoids that.
 */
export class StorageService implements IStorageService {
  private _storage: MMKV | undefined;

  constructor(private readonly instanceId?: string) {}

  private get storage(): MMKV {
    if (!this._storage) {
      this._storage = this.instanceId
        ? createMMKV({id: this.instanceId})
        : createMMKV();
    }
    return this._storage;
  }

  // String operations
  getString(key: string): string | undefined {
    return this.storage.getString(key) ?? undefined;
  }

  setString(key: string, value: string): void {
    this.storage.set(key, value);
  }

  // Boolean operations
  getBool(key: string, defaultValue?: boolean): boolean {
    const value = this.storage.getBoolean(key);
    return value == null ? defaultValue || false : value;
  }

  setBool(key: string, value: boolean): void {
    this.storage.set(key, value);
  }

  // Number operations
  getNumber(key: string): number | undefined {
    return this.storage.getNumber(key) ?? undefined;
  }

  setNumber(key: string, value: number): void {
    this.storage.set(key, value);
  }

  // Object operations
  getObject<T>(key: string): T | undefined {
    const json = this.storage.getString(key);
    if (!json) {
      return undefined;
    }
    try {
      return JSON.parse(json) as T;
    } catch (e) {
      console.error(`Failed to parse stored object for key ${key}:`, e);
      return undefined;
    }
  }

  setObject<T>(key: string, value: T): void {
    this.storage.set(key, JSON.stringify(value));
  }

  // Array operations
  getArray<T>(key: string): T[] | undefined {
    return this.getObject<T[]>(key);
  }

  setArray<T>(key: string, value: T[]): void {
    this.setObject(key, value);
  }

  // Delete operations
  delete(key: string): void {
    // v4 renamed delete() -> remove() since `delete` is reserved in C++
    this.storage.remove(key);
  }

  // Check if key exists
  contains(key: string): boolean {
    return this.storage.contains(key);
  }

  // Clear all storage
  clearAll(): void {
    this.storage.clearAll();
  }

  // Get all keys
  async getKeys(): Promise<string[]> {
    try {
      return this.storage.getAllKeys();
    } catch {
      return [];
    }
  }
}

// These are cheap JS objects only - the actual native MMKV instance for
// each isn't created until its first getX/setX/delete/etc call.
export const mainStorage: IStorageService = new StorageService();
export const cacheStorage: IStorageService = new StorageService('cache');
export const providerKvStorage: IStorageService = new StorageService('provider_kv');

export const clearAllMMKVStorage = (): void => {
  cacheStorage.clearAll();
  mainStorage.clearAll();
  providerKvStorage.clearAll();
};

export const createZustandStorage = (
  storage: IStorageService = mainStorage,
): StateStorage => ({
  getItem: name => storage.getString(name) ?? null,
  setItem: (name, value) => storage.setString(name, value),
  removeItem: name => storage.delete(name),
});
