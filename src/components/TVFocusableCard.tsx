// src/components/TVFocusableCard.tsx
import React, { useState } from 'react';
import { Pressable, Image, Text, View } from 'react-native';

interface TVFocusableCardProps {
  title: string;
  posterUrl: string;
  onPress: () => void;
  hasTVPreferredFocus?: boolean;
}

export const TVFocusableCard: React.FC<TVFocusableCardProps> = ({
  title,
  posterUrl,
  onPress,
  hasTVPreferredFocus = false,
}) => {
  const [isFocused, setIsFocused] = useState(false);

  return (
    <Pressable
      hasTVPreferredFocus={hasTVPreferredFocus}
      onFocus={() => setIsFocused(true)}
      onBlur={() => setIsFocused(false)}
      onPress={onPress}
      style={{
        width: 140,
        marginHorizontal: 8,
        marginVertical: 12,
        transform: [{ scale: isFocused ? 1.08 : 1.0 }],
      }}
    >
      <View
        style={{
          borderRadius: 8,
          overflow: 'hidden',
          borderWidth: 2,
          borderColor: isFocused ? '#9333ea' : 'transparent', // Purple highlight
        }}
      >
        <Image
          source={{ uri: posterUrl }}
          style={{ width: '100%', height: 210, backgroundColor: '#1e1e24' }}
          resizeMode="cover"
        />
      </View>
      <Text
        numberOfLines={1}
        style={{
          color: isFocused ? '#ffffff' : '#a1a1aa',
          fontSize: 13,
          marginTop: 6,
          fontWeight: isFocused ? 'bold' : 'normal',
        }}
      >
        {title}
      </Text>
    </Pressable>
  );
};
