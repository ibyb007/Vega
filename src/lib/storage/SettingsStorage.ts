import { MMKV } from '../Mmkv';

/**
 * Storage keys for settings
 */
const SETTINGS_KEYS = {
  USE_EXTERNAL_PLAYER: 'useExternalPlayer',
  PRIMARY_COLOR: 'primaryColor',
  IS_CUSTOM_THEME: 'isCustomTheme',
  ACCENT_SOURCE: 'accentSource',
  EXCLUDED_QUALITIES: 'excludedQualities',
  DOH_ENABLED: 'dohEnabled',
  DOH_PROVIDER: 'dohProvider',
  DOH_CUSTOM_URL: 'dohCustomUrl',
  TMDB_API_KEY: 'tmdbApiKey',
  AUTO_CHECK_UPDATE: 'autoCheckUpdate',
  AUTO_DOWNLOAD_UPDATE: 'autoDownloadUpdate',
  SHOW_MEDIA_CONTROLS: 'showMediaControls',
  HIDE_SEEK_BUTTONS: 'hideSeekButtons',
  PLAYER_EPISODE_SIDEBAR: 'showPlayerEpisodeSidebar',
  SWIPE_GESTURE: 'swipeGestureEnabled',
  ENABLE_2X_GESTURE: 'enable2xGesture',
  SUBTITLE_FONT_SIZE: 'subtitleFontSize',
  SUBTITLE_OPACITY: 'subtitleOpacity',
  SUBTITLE_BOTTOM_PADDING: 'subtitleBottomPadding',
  SUBTITLE_TEXT_COLOR: 'subtitleTextColor',
  SUBTITLE_FONT_FAMILY: 'subtitleFontFamily',
  SUBTITLE_EDGE_TYPE: 'subtitleEdgeType',
  SUBTITLE_EDGE_COLOR: 'subtitleEdgeColor',
  SUBTITLE_OUTLINE_WIDTH: 'subtitleOutlineWidth',
  LAUNCHER_ICON: 'launcherIcon',
  DYNAMIC_INFO_ACCENT: 'dynamicInfoAccentEnabled',
  DEFAULT_PLAYER: 'defaultPlayer',
} as const;

export class SettingsStorage {
  // Theme settings (read eagerly by themeStore.ts on app start)
  getPrimaryColor(): string {
    return MMKV.getString(SETTINGS_KEYS.PRIMARY_COLOR) || '#FFFFFF';
  }

  setPrimaryColor(color: string): void {
    MMKV.setString(SETTINGS_KEYS.PRIMARY_COLOR, color);
  }

  isCustomTheme(): boolean {
    return MMKV.getBool(SETTINGS_KEYS.IS_CUSTOM_THEME, false);
  }

  setCustomTheme(isCustom: boolean): void {
    MMKV.setBool(SETTINGS_KEYS.IS_CUSTOM_THEME, isCustom);
  }

  /**
   * Accent source for the Material 3 palette. `wallpaper` follows Material You
   * (Android 12+), `custom` derives the palette from the stored seed color.
   */
  getAccentSource(): 'wallpaper' | 'custom' {
    return MMKV.getString(SETTINGS_KEYS.ACCENT_SOURCE) === 'custom'
      ? 'custom'
      : 'wallpaper';
  }

  setAccentSource(source: 'wallpaper' | 'custom'): void {
    MMKV.setString(SETTINGS_KEYS.ACCENT_SOURCE, source);
  }

  // DNS over HTTPS (DoH)
  isDoHActive(): boolean {
    return MMKV.getBool(SETTINGS_KEYS.DOH_ENABLED, true);
  }

  setDoHActive(enabled: boolean): void {
    MMKV.setBool(SETTINGS_KEYS.DOH_ENABLED, enabled);
  }

  isDohEnabled(): boolean {
    return this.isDoHActive();
  }

  setDohEnabled(enabled: boolean): void {
    this.setDoHActive(enabled);
  }

  getDohProvider(): string {
    return MMKV.getString(SETTINGS_KEYS.DOH_PROVIDER) || 'cloudflare';
  }

  setDohProvider(provider: string): void {
    MMKV.setString(SETTINGS_KEYS.DOH_PROVIDER, provider);
  }

  // Capital-H aliases -- `TVSettingsScreen` calls `getDoHProvider`/
  // `setDoHProvider` (matching `isDoHActive`/`setDoHActive`'s casing), but
  // only the lowercase-h versions existed here, so the TV settings
  // screen's DoH provider picker silently failed to persist (same
  // class of bug as the missing default-player methods below).
  getDoHProvider(): string {
    return this.getDohProvider();
  }

  setDoHProvider(provider: string): void {
    this.setDohProvider(provider);
  }

  getDohCustomUrl(): string {
    return MMKV.getString(SETTINGS_KEYS.DOH_CUSTOM_URL) || '';
  }

  setDohCustomUrl(url: string): void {
    MMKV.setString(SETTINGS_KEYS.DOH_CUSTOM_URL, url);
  }

  // TMDB Metadata
  getTmdbApiKey(): string {
    return MMKV.getString(SETTINGS_KEYS.TMDB_API_KEY) || '';
  }

  setTmdbApiKey(key: string): void {
    MMKV.setString(SETTINGS_KEYS.TMDB_API_KEY, key);
  }

  // Player Settings
  isAutoCheckUpdateEnabled(): boolean {
    return MMKV.getBool(SETTINGS_KEYS.AUTO_CHECK_UPDATE, true);
  }

  setAutoCheckUpdateEnabled(enabled: boolean): void {
    MMKV.setBool(SETTINGS_KEYS.AUTO_CHECK_UPDATE, enabled);
  }

  isAutoDownloadEnabled(): boolean {
    return MMKV.getBool(SETTINGS_KEYS.AUTO_DOWNLOAD_UPDATE, false);
  }

  setAutoDownloadEnabled(enabled: boolean): void {
    MMKV.setBool(SETTINGS_KEYS.AUTO_DOWNLOAD_UPDATE, enabled);
  }

  getExcludedQualities(): string[] {
    return MMKV.getArray<string>(SETTINGS_KEYS.EXCLUDED_QUALITIES) || [];
  }

  setExcludedQualities(qualities: string[]): void {
    MMKV.setArray(SETTINGS_KEYS.EXCLUDED_QUALITIES, qualities);
  }

  showMediaControls(): boolean {
    return MMKV.getBool(SETTINGS_KEYS.SHOW_MEDIA_CONTROLS, true);
  }

  setShowMediaControls(show: boolean): void {
    MMKV.setBool(SETTINGS_KEYS.SHOW_MEDIA_CONTROLS, show);
  }

  hideSeekButtons(): boolean {
    return MMKV.getBool(SETTINGS_KEYS.HIDE_SEEK_BUTTONS, false);
  }

  setHideSeekButtons(hide: boolean): void {
    MMKV.setBool(SETTINGS_KEYS.HIDE_SEEK_BUTTONS, hide);
  }

  showPlayerEpisodeSidebar(): boolean {
    return MMKV.getBool(SETTINGS_KEYS.PLAYER_EPISODE_SIDEBAR, true);
  }

  setShowPlayerEpisodeSidebar(show: boolean): void {
    MMKV.setBool(SETTINGS_KEYS.PLAYER_EPISODE_SIDEBAR, show);
  }

  isSwipeGestureEnabled(): boolean {
    return MMKV.getBool(SETTINGS_KEYS.SWIPE_GESTURE, false);
  }

  setSwipeGestureEnabled(enabled: boolean): void {
    MMKV.setBool(SETTINGS_KEYS.SWIPE_GESTURE, enabled);
  }

  isEnable2xGestureEnabled(): boolean {
    return MMKV.getBool(SETTINGS_KEYS.ENABLE_2X_GESTURE, false);
  }

  // Subtitles Preferences
  getSubtitleFontSize(): number {
    return MMKV.getNumber(SETTINGS_KEYS.SUBTITLE_FONT_SIZE) ?? 18;
  }

  setSubtitleFontSize(size: number): void {
    MMKV.setNumber(SETTINGS_KEYS.SUBTITLE_FONT_SIZE, size);
  }

  getSubtitleOpacity(): number {
    return MMKV.getNumber(SETTINGS_KEYS.SUBTITLE_OPACITY) ?? 1;
  }

  setSubtitleOpacity(opacity: number): void {
    MMKV.setNumber(SETTINGS_KEYS.SUBTITLE_OPACITY, opacity);
  }

  getSubtitleBottomPadding(): number {
    return MMKV.getNumber(SETTINGS_KEYS.SUBTITLE_BOTTOM_PADDING) ?? 12;
  }

  setSubtitleBottomPadding(padding: number): void {
    MMKV.setNumber(SETTINGS_KEYS.SUBTITLE_BOTTOM_PADDING, padding);
  }

  getSubtitleTextColor(): string {
    return MMKV.getString(SETTINGS_KEYS.SUBTITLE_TEXT_COLOR) || '#FFFFFF';
  }

  setSubtitleTextColor(color: string): void {
    MMKV.setString(SETTINGS_KEYS.SUBTITLE_TEXT_COLOR, color);
  }

  getSubtitleFontFamily(): string {
    return MMKV.getString(SETTINGS_KEYS.SUBTITLE_FONT_FAMILY) || 'default';
  }

  setSubtitleFontFamily(font: string): void {
    MMKV.setString(SETTINGS_KEYS.SUBTITLE_FONT_FAMILY, font);
  }

  getSubtitleEdgeType(): 'outline' | 'dropShadow' | 'raised' | 'depressed' | 'none' {
    return (
      (MMKV.getString(SETTINGS_KEYS.SUBTITLE_EDGE_TYPE) as any) || 'outline'
    );
  }

  setSubtitleEdgeType(edge: string): void {
    MMKV.setString(SETTINGS_KEYS.SUBTITLE_EDGE_TYPE, edge);
  }

  getSubtitleEdgeColor(): string {
    return MMKV.getString(SETTINGS_KEYS.SUBTITLE_EDGE_COLOR) || '#000000';
  }

  setSubtitleEdgeColor(color: string): void {
    MMKV.setString(SETTINGS_KEYS.SUBTITLE_EDGE_COLOR, color);
  }

  getSubtitleOutlineWidth(): number {
    return MMKV.getNumber(SETTINGS_KEYS.SUBTITLE_OUTLINE_WIDTH) ?? 2;
  }

  setSubtitleOutlineWidth(width: number): void {
    MMKV.setNumber(SETTINGS_KEYS.SUBTITLE_OUTLINE_WIDTH, width);
  }

  // Appearance
  getLauncherIcon(): 'white' | 'tomato' | 'gray' | 'blue' | 'lavender' {
    return (MMKV.getString(SETTINGS_KEYS.LAUNCHER_ICON) as any) || 'white';
  }

  setLauncherIcon(icon: string): void {
    MMKV.setString(SETTINGS_KEYS.LAUNCHER_ICON, icon);
  }

  isDynamicInfoAccentEnabled(): boolean {
    return MMKV.getBool(SETTINGS_KEYS.DYNAMIC_INFO_ACCENT, true);
  }

  setDynamicInfoAccentEnabled(enabled: boolean): void {
    MMKV.setBool(SETTINGS_KEYS.DYNAMIC_INFO_ACCENT, enabled);
  }

  // Default video player (Android TV settings screen). Was previously
  // called by `TVSettingsScreen` but never defined here at all -- the
  // calls were guarded with `settingsStorage?.setDefaultPlayer &&`, so the
  // missing method just silently no-opped instead of throwing, and the
  // picker always fell back to 'exo' on the next screen visit.
  getDefaultPlayer(): 'exo' | 'vlc' | 'system' {
    const saved = MMKV.getString(SETTINGS_KEYS.DEFAULT_PLAYER);
    if (saved === 'vlc' || saved === 'system' || saved === 'exo') return saved;
    return 'exo';
  }

  setDefaultPlayer(player: 'exo' | 'vlc' | 'system'): void {
    MMKV.setString(SETTINGS_KEYS.DEFAULT_PLAYER, player);
  }

  // Common Getters/Setters
  getBool(key: string, defaultValue = false): boolean {
    return MMKV.getBool(key, defaultValue);
  }

  setBool(key: string, value: boolean): void {
    MMKV.setBool(key, value);
  }
}

export const settingsStorage = new SettingsStorage();
