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
 * Uses `react-native-mmkv` v4 (Nitro-based) instead of the legacy
 * `react-native-mmkv-storage`, which predates the New Architecture and
 * threw "undefined is not a function" during module init.
 *
 * v4 removed the `MMKV` class in favor of the `createMMKV()` factory
 * function - `new MMKV()` no longer exists and throws
 * "undefined cannot be used as a constructor".
 */
export class StorageService implements IStorageService {
  private storage: MMKV;

  constructor(instanceId?: string) {
    this.storage = instanceId ? createMMKV({id: instanceId}) : createMMKV();
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

// Create and export default instances
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
