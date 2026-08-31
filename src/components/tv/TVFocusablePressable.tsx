import React, { useState } from 'react';
import {
  Pressable,
  PressableProps,
  StyleSheet,
  ViewStyle,
  StyleProp,
} from 'react-native';

interface TVFocusablePressableProps extends Omit<PressableProps, 'style' | 'children'> {
  style?: StyleProp<ViewStyle>;
  focusedBorderColor?: string;
  scaleFocused?: number;
  borderRadius?: number;
  hasTVPreferredFocus?: boolean;
  onFocusChange?: (focused: boolean) => void;
  children: ((state: { focused: boolean }) => React.ReactNode) | React.ReactNode;
}

export const TVFocusablePressable: React.FC<TVFocusablePressableProps> = ({
  style,
  focusedBorderColor = '#8A5CF6',
  scaleFocused = 1.05,
  borderRadius = 8,
  hasTVPreferredFocus = false,
  onFocusChange,
  children,
  onFocus,
  onBlur,
  ...rest
}) => {
  const [isFocused, setIsFocused] = useState(false);

  return (
    <Pressable
      {...rest}
      focusable={true}
      hasTVPreferredFocus={hasTVPreferredFocus}
      onFocus={(e) => {
        setIsFocused(true);
        onFocusChange?.(true);
        onFocus?.(e);
      }}
      onBlur={(e) => {
        setIsFocused(false);
        onFocusChange?.(false);
        onBlur?.(e);
      }}
      style={[
        style,
        styles.base,
        { borderRadius },
        isFocused && {
          borderColor: focusedBorderColor,
          transform: [{ scale: scaleFocused }],
          zIndex: 99,
        },
      ]}
    >
      {typeof children === 'function' ? children({ focused: isFocused }) : children}
    </Pressable>
  );
};

const styles = StyleSheet.create({
  base: {
    borderWidth: 2,
    borderColor: 'transparent',
  },
});
