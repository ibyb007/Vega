import React, { useState } from 'react';
import {
  Pressable,
  PressableProps,
  StyleSheet,
  ViewStyle,
  StyleProp,
  View,
} from 'react-native';

interface TVFocusablePressableProps extends Omit<PressableProps, 'style' | 'children'> {
  style?: StyleProp<ViewStyle>;
  focusedBorderColor?: string;
  scaleFocused?: number;
  borderRadius?: number;
  hasTVPreferredFocus?: boolean;
  focusable?: boolean;
  onFocusChange?: (focused: boolean) => void;
  children: ((state: { focused: boolean }) => React.ReactNode) | React.ReactNode;
}

// Forwards its ref to the underlying Pressable's native view. This matters
// for TV focus targeting (e.g. `nextFocusLeft={findNodeHandle(ref.current)}`)
// -- Android's focus engine needs the handle of the actual focusable node,
// not a decorative inner View, or it silently falls back to its default
// nearest-neighbor search once the declared target turns out to be
// unfocusable.
export const TVFocusablePressable = React.forwardRef<View, TVFocusablePressableProps>(
  (
    {
      style,
      focusedBorderColor = '#8A5CF6',
      scaleFocused = 1.05,
      borderRadius = 8,
      hasTVPreferredFocus = false,
      focusable = true,
      onFocusChange,
      children,
      onFocus,
      onBlur,
      ...rest
    },
    ref
  ) => {
    const [isFocused, setIsFocused] = useState(false);

    return (
      <Pressable
        {...rest}
        ref={ref}
        focusable={focusable}
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
  }
);

const styles = StyleSheet.create({
  base: {
    borderWidth: 2,
    borderColor: 'transparent',
  },
});
