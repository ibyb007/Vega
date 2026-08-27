// src/screens/StremioTVScreen.tsx
import React, { useState } from 'react';
import { View, Text, FlatList, Pressable, StyleSheet, BackHandler } from 'react-native';
import Video from 'react-native-video';
import { TVFocusableCard } from '../components/TVFocusableCard';
import { launchVideo } from '../lib/services/PlayerLauncher';

const SAMPLE_MEDIA = [
  { id: '1', title: 'Example Stream 1', poster: 'https://image.tmdb.org/t/p/w500/8b8R8l88Qje9dn9OE8PY05Nxl1X.jpg', streamUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4' },
  { id: '2', title: 'Example Stream 2', poster: 'https://image.tmdb.org/t/p/w500/qJ2tW6WMUDux911r6m7haRef0WH.jpg', streamUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4' },
];

export const StremioTVScreen = () => {
  const [activeTab, setActiveTab] = useState<'Home' | 'Discover' | 'Library' | 'Settings'>('Home');
  const [activeStream, setActiveStream] = useState<string | null>(null);
  const [selectedPlayer] = useState<'exoplayer' | 'vlc' | 'external'>('exoplayer');

  const handleMediaSelect = async (item: typeof SAMPLE_MEDIA[0]) => {
    if (selectedPlayer === 'exoplayer') {
      setActiveStream(item.streamUrl);
    } else {
      await launchVideo(item.streamUrl, item.title, selectedPlayer);
    }
  };

  React.useEffect(() => {
    const onBackPress = () => {
      if (activeStream) {
        setActiveStream(null);
        return true;
      }
      return false;
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', onBackPress);
    return () => sub.remove();
  }, [activeStream]);

  if (activeStream) {
    return (
      <View style={styles.playerContainer}>
        <Video
          source={{ uri: activeStream }}
          style={StyleSheet.absoluteFill}
          controls={true}
          resizeMode="contain"
          onError={() => setActiveStream(null)}
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Stremio Left TV Sidebar */}
      <View style={styles.sidebar}>
        {(['Home', 'Discover', 'Library', 'Settings'] as const).map((tab) => (
          <Pressable
            key={tab}
            onPress={() => setActiveTab(tab)}
            style={({ focused }) => [
              styles.navButton,
              activeTab === tab && styles.navButtonActive,
              focused && styles.navButtonFocused,
            ]}
          >
            {({ focused }) => (
              <Text
                style={[
                  styles.navText,
                  focused && styles.navTextFocused,
                ]}
              >
                {tab}
              </Text>
            )}
          </Pressable>
        ))}
      </View>

      {/* Main Content Area */}
      <View style={styles.content}>
        <Text style={styles.rowTitle}>Popular Movies & Series</Text>
        <FlatList
          horizontal
          data={SAMPLE_MEDIA}
          keyExtractor={(item) => item.id}
          renderItem={({ item, index }) => (
            <TVFocusableCard
              hasTVPreferredFocus={index === 0}
              title={item.title}
              posterUrl={item.poster}
              onPress={() => handleMediaSelect(item)}
            />
          )}
        />
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, flexDirection: 'row', backgroundColor: '#0f0f13' },
  sidebar: { width: 140, backgroundColor: '#14141b', paddingVertical: 20, alignItems: 'center' },
  navButton: { paddingVertical: 14, paddingHorizontal: 16, width: '90%', borderRadius: 6, marginVertical: 4 },
  navButtonActive: { backgroundColor: '#21212f' },
  navButtonFocused: { backgroundColor: '#9333ea' },
  navText: { color: '#8e8ea0', fontSize: 15, fontWeight: '600', textAlign: 'center' },
  navTextFocused: { color: '#ffffff' },
  content: { flex: 1, padding: 24 },
  rowTitle: { color: '#ffffff', fontSize: 20, fontWeight: 'bold', marginBottom: 12 },
  playerContainer: { flex: 1, backgroundColor: '#000000' },
});
