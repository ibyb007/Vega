import React, { useState, forwardRef, useImperativeHandle, useRef } from 'react';
import {
  Pressable,
  PressableProps,
  StyleProp,
  ViewStyle,
  StyleSheet,
  findNodeHandle,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  withTiming,
  Easing,
} from 'react-native-reanimated';

interface TVFocusablePressableProps extends Omit<PressableProps, 'style' | 'children'> {
  children: ((state: { focused: boolean }) => React.ReactNode) | React.ReactNode;
  style?: StyleProp<ViewStyle>;
  scaleFocused?: number;
  focusedBorderColor?: string;
  borderRadius?: number;
  onFocusChange?: (focused: boolean) => void;
  trapFocusLeft?: boolean;
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export const TVFocusablePressable = forwardRef<any, TVFocusablePressableProps>(
  (
    {
      children,
      style,
      scaleFocused = 1.04,
      focusedBorderColor = '#8A5CF6',
      borderRadius = 12,
      onFocusChange,
      trapFocusLeft = false,
      onFocus,
      onBlur,
      ...rest
    },
    ref
  ) => {
    const [isFocused, setIsFocused] = useState(false);
    const localRef = useRef<any>(null);

    useImperativeHandle(ref, () => localRef.current);

    const animatedStyle = useAnimatedStyle(() => {
      return {
        transform: [
          {
            scale: withTiming(isFocused ? scaleFocused : 1, {
              duration: 160,
              easing: Easing.out(Easing.quad),
            }),
          },
        ],
        borderWidth: withTiming(isFocused ? 2 : 0, { duration: 120 }),
        borderColor: isFocused ? focusedBorderColor : 'transparent',
      };
    }, [isFocused]);

    return (
      <AnimatedPressable
        ref={localRef}
        focusable={true}
        hasTVPreferredFocus={rest.hasTVPreferredFocus}
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
        {...(trapFocusLeft
          ? { nextFocusLeft: findNodeHandle(localRef.current) ?? undefined }
          : {})}
        style={[styles.base, { borderRadius }, style, animatedStyle]}
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
