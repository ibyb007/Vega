import React, { useState, forwardRef } from 'react';
import {
  Pressable,
  PressableProps,
  StyleSheet,
  ViewStyle,
  StyleProp,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  withTiming,
  Easing,
} from 'react-native-reanimated';

interface TVFocusablePressableProps extends PressableProps {
  children: React.ReactNode | ((state: { focused: boolean }) => React.ReactNode);
  scaleFocused?: number;
  focusedBorderColor?: string;
  borderRadius?: number;
  hasTVPreferredFocus?: boolean;
  style?: StyleProp<ViewStyle>;
  onFocusChange?: (focused: boolean) => void;
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export const TVFocusablePressable = forwardRef<any, TVFocusablePressableProps>(
  (
    {
      children,
      scaleFocused = 1.06,
      focusedBorderColor = '#FFFFFF',
      borderRadius = 8,
      hasTVPreferredFocus = false,
      style,
      onFocus,
      onBlur,
      onFocusChange,
      ...rest
    },
    ref
  ) => {
    const [isFocused, setIsFocused] = useState(false);

    const animatedStyle = useAnimatedStyle(() => {
      return {
        transform: [
          {
            scale: withTiming(isFocused ? scaleFocused : 1.0, {
              duration: 180,
              easing: Easing.out(Easing.quad),
            }),
          },
        ],
        borderWidth: withTiming(isFocused ? 2.5 : 0, { duration: 150 }),
        borderColor: isFocused ? focusedBorderColor : 'transparent',
      };
    }, [isFocused]);

    const handleFocus = (e: any) => {
      setIsFocused(true);
      onFocusChange?.(true);
      onFocus?.(e);
    };

    const handleBlur = (e: any) => {
      setIsFocused(false);
      onFocusChange?.(false);
      onBlur?.(e);
    };

    return (
      <AnimatedPressable
        ref={ref}
        focusable={true}
        hasTVPreferredFocus={hasTVPreferredFocus}
        onFocus={handleFocus}
        onBlur={handleBlur}
        style={[
          styles.base,
          { borderRadius },
          animatedStyle,
          style,
        ]}
        {...rest}
      >
        {typeof children === 'function' ? children({ focused: isFocused }) : children}
      </AnimatedPressable>
    );
  }
);

const styles = StyleSheet.create({
  base: {
    overflow: 'hidden',
  },
});
