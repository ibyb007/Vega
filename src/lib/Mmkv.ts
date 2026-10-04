// Re-exports the shared MMKV-backed storage instances from StorageService,
// which wraps react-native-mmkv (TurboModule-based, New Architecture
// compatible). Kept as a thin re-export so existing imports of
// `../Mmkv` (e.g. SettingsStorage.ts) don't need to change — MMKV and
// MmmkvCache already expose the same getString/setString/getBool/setBool
// etc. methods that this file's callers rely on.
export {mainStorage as MMKV, cacheStorage as MmmkvCache} from './storage/StorageService';
