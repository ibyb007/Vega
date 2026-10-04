import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { TVFocusablePressable } from './TVFocusablePressable';

interface TVNoProviderFallbackProps {
  onInstallProviders: () => void;
  onOpenSettings?: () => void;
}

export const TVNoProviderFallback: React.FC<TVNoProviderFallbackProps> = ({
  onInstallProviders,
  onOpenSettings,
}) => {
  return (
    <View style={styles.container}>
      <View style={styles.iconWrapper}>
        <MaterialCommunityIcons name="package-variant-closed" size={80} color="#FFFFFF" />
      </View>

      <Text style={styles.title}>No Provider Installed</Text>
      <Text style={styles.subtitle}>
        Connect your cloud provider to play network streams or browse media catalogs.
      </Text>

      <View style={styles.buttonContainer}>
        <TVFocusablePressable
          hasTVPreferredFocus={true}
          scaleFocused={1.05}
          focusedBorderColor="#8A5CF6"
          borderRadius={14}
          onPress={onInstallProviders}
          style={styles.primaryButton}
        >
          {({ focused }) => (
            <View style={styles.buttonInner}>
              <MaterialCommunityIcons name="download" size={22} color="#000000" />
              <Text style={styles.primaryButtonText}>Install Cloud Providers</Text>
            </View>
          )}
        </TVFocusablePressable>

        {onOpenSettings && (
          <TVFocusablePressable
            scaleFocused={1.05}
            focusedBorderColor="#8A5CF6"
            borderRadius={14}
            onPress={onOpenSettings}
            style={styles.secondaryButton}
          >
            {({ focused }) => (
              <View style={styles.buttonInner}>
                <MaterialCommunityIcons name="cog-outline" size={22} color="#FFFFFF" />
                <Text style={styles.secondaryButtonText}>Settings</Text>
              </View>
            )}
          </TVFocusablePressable>
        )}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 48,
    backgroundColor: '#0A0A0E',
  },
  iconWrapper: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 24,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 32,
    fontWeight: '800',
    marginBottom: 12,
    textAlign: 'center',
  },
  subtitle: {
    color: '#9CA3AF',
    fontSize: 16,
    lineHeight: 24,
    textAlign: 'center',
    maxWidth: 520,
    marginBottom: 36,
  },
  buttonContainer: {
    width: 320,
    gap: 14,
  },
  primaryButton: {
    backgroundColor: '#FFFFFF',
    paddingVertical: 14,
    paddingHorizontal: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  secondaryButton: {
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    paddingVertical: 14,
    paddingHorizontal: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  buttonInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  primaryButtonText: {
    color: '#000000',
    fontSize: 16,
    fontWeight: '700',
  },
  secondaryButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
});
