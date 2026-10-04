import React, { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { M3HostThemeContext, M3PaletteContext } from './M3PaletteContext';

const DEFAULT_THEME_PALETTE = {
  primary: '#8A5CF6',
  onPrimary: '#FFFFFF',
  primaryContainer: '#4C1D95',
  onPrimaryContainer: '#EDE9FE',
  inversePrimary: '#A78BFA',
  secondary: '#A78BFA',
  onSecondary: '#1E1B4B',
  secondaryContainer: '#312E81',
  onSecondaryContainer: '#EDE9FE',
  tertiary: '#C4B5FD',
  onTertiary: '#1E1B4B',
  tertiaryContainer: '#4C1D95',
  onTertiaryContainer: '#EDE9FE',
  background: '#0A0A0E',
  onBackground: '#FFFFFF',
  surface: '#121217',
  onSurface: '#FFFFFF',
  surfaceVariant: '#1F1F28',
  onSurfaceVariant: '#9CA3AF',
  surfaceTint: '#8A5CF6',
  inverseSurface: '#F3F4F6',
  inverseOnSurface: '#111827',
  error: '#EF4444',
  onError: '#FFFFFF',
  errorContainer: '#7F1D1D',
  onErrorContainer: '#FEE2E2',
  outline: '#374151',
  outlineVariant: '#1F2937',
  scrim: '#000000',
  surfaceBright: '#262633',
  surfaceDim: '#0A0A0E',
  surfaceContainer: '#14141B',
  surfaceContainerHigh: '#1E1E28',
  surfaceContainerHighest: '#282836',
  surfaceContainerLow: '#0E0E14',
  surfaceContainerLowest: '#050507',
  primaryFixed: '#EDE9FE',
  primaryFixedDim: '#DDD6FE',
  onPrimaryFixed: '#1E1B4B',
  onPrimaryFixedVariant: '#4C1D95',
  secondaryFixed: '#EDE9FE',
  secondaryFixedDim: '#DDD6FE',
  onSecondaryFixed: '#1E1B4B',
  onSecondaryFixedVariant: '#312E81',
  tertiaryFixed: '#EDE9FE',
  tertiaryFixedDim: '#DDD6FE',
  onTertiaryFixed: '#1E1B4B',
  onTertiaryFixedVariant: '#4C1D95',
} as any;

export const M3ThemeProvider = ({ children }: { children: React.ReactNode }) => {
  const hostTheme = useMemo(() => ({ colorScheme: 'dark' as const }), []);

  return (
    <M3HostThemeContext.Provider value={hostTheme}>
      <M3PaletteContext.Provider value={DEFAULT_THEME_PALETTE}>
        <View style={styles.container}>{children}</View>
      </M3PaletteContext.Provider>
    </M3HostThemeContext.Provider>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0E',
  },
});

export { useM3Colors } from './M3PaletteContext';
