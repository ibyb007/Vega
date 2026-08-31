import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Image,
  ActivityIndicator,
  Dimensions,
} from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { TVFocusablePressable } from '../../components/tv/TVFocusablePressable';
import useContentStore from '../../lib/zustand/contentStore';
import { providerManager } from '../../lib/services/ProviderManager';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

interface TVDetailsScreenProps {
  item: any;
  onBack: () => void;
  onPlayStream: (streamUrl: string, title?: string) => void;
}

export const TVDetailsScreen: React.FC<TVDetailsScreenProps> = ({
  item,
  onBack,
  onPlayStream,
}) => {
  const provider = useContentStore((state) => state.provider);
  const [details, setDetails] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [extractingStreams, setExtractingStreams] = useState(false);

  useEffect(() => {
    let isMounted = true;

    async function fetchMetadata() {
      setLoading(true);
      try {
        const providerId = item.provider || provider?.value;
        const res = await providerManager.getDetails(providerId, item.link);
        if (isMounted) {
          setDetails(res || item);
        }
      } catch {
        if (isMounted) {
          setDetails(item);
        }
      } finally {
        if (isMounted) setLoading(false);
      }
    }

    fetchMetadata();
    return () => {
      isMounted = false;
    };
  }, [item, provider?.value]);

  const handleEpisodeOrPlay = async (targetItem: any) => {
    setExtractingStreams(true);
    try {
      const providerId = item.provider || provider?.value;
      const streamRes = await providerManager.getStream(
        providerId,
        targetItem.link || item.link,
        targetItem.type || item.type
      );

      const streamUrl =
        typeof streamRes === 'string'
          ? streamRes
          : streamRes?.url || streamRes?.streamUrl || streamRes?.link;

      if (streamUrl) {
        onPlayStream(streamUrl, targetItem.title || details?.title || item.title);
      }
    } catch (e: any) {
      console.warn('Failed to resolve stream link:', e);
    } finally {
      setExtractingStreams(false);
    }
  };

  const bannerImage = details?.image || details?.backdrop || item.image;
  const episodesList = details?.episodes || details?.epList || [];
  const hasEpisodes = episodesList.length > 0;

  return (
    <View style={styles.container}>
      {/* Top Backdrop Banner */}
      <View style={styles.backdropHero}>
        {bannerImage ? (
          <Image
            source={{ uri: bannerImage }}
            style={styles.backdropImage}
            resizeMode="cover"
          />
        ) : null}

        <LinearGradient
          colors={['transparent', 'rgba(10, 10, 14, 0.7)', '#0A0A0E']}
          locations={[0, 0.6, 1]}
          style={styles.bottomGradient}
        />
        <LinearGradient
          colors={['rgba(10, 10, 14, 0.95)', 'transparent']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={styles.leftGradient}
        />

        <View style={styles.heroInfo}>
          <TVFocusablePressable
            hasTVPreferredFocus={true}
            scaleFocused={1.08}
            focusedBorderColor="#8A5CF6"
            borderRadius={8}
            onPress={onBack}
            style={styles.backBtn}
          >
            {() => (
              <View style={styles.backBtnInner}>
                <MaterialCommunityIcons name="arrow-left" size={20} color="#FFFFFF" />
                <Text style={styles.backBtnText}>Back</Text>
              </View>
            )}
          </TVFocusablePressable>

          <Text style={styles.title} numberOfLines={2}>
            {details?.title || item.title}
          </Text>

          <View style={styles.badgeRow}>
            {details?.rating && (
              <View style={styles.ratingBadge}>
                <Text style={styles.ratingText}>★ {details.rating}</Text>
              </View>
            )}
            {details?.year && <Text style={styles.metaBadge}>{details.year}</Text>}
            {details?.quality && <Text style={styles.metaBadge}>{details.quality}</Text>}
          </View>

          <Text style={styles.overview} numberOfLines={3}>
            {details?.description ||
              details?.overview ||
              item.extra ||
              'Select an episode or stream link below.'}
          </Text>
        </View>
      </View>

      {/* Episodes / Play Action Section */}
      {loading || extractingStreams ? (
        <View style={styles.centerLoading}>
          <ActivityIndicator size="large" color="#8A5CF6" />
          <Text style={styles.loadingSubtext}>
            {extractingStreams ? 'Resolving stream links...' : 'Loading media details...'}
          </Text>
        </View>
      ) : hasEpisodes ? (
        <View style={styles.episodesSection}>
          <Text style={styles.sectionHeader}>Select Episode</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.episodesScroll}
          >
            {episodesList.map((ep: any, index: number) => (
              <TVFocusablePressable
                key={`ep-${ep.id || ep.link || index}`}
                scaleFocused={1.06}
                focusedBorderColor="#8A5CF6"
                borderRadius={12}
                onPress={() => handleEpisodeOrPlay(ep)}
                style={styles.episodeCard}
              >
                {({ focused }) => (
                  <View style={styles.episodeInner}>
                    <MaterialCommunityIcons
                      name="play-circle-outline"
                      size={28}
                      color={focused ? '#8A5CF6' : '#9CA3AF'}
                    />
                    <Text style={styles.episodeTitle} numberOfLines={1}>
                      {ep.title || `Episode ${index + 1}`}
                    </Text>
                  </View>
                )}
              </TVFocusablePressable>
            ))}
          </ScrollView>
        </View>
      ) : (
        <View style={styles.playActionSection}>
          <TVFocusablePressable
            scaleFocused={1.06}
            focusedBorderColor="#FFFFFF"
            borderRadius={14}
            onPress={() => handleEpisodeOrPlay(item)}
            style={styles.playBtn}
          >
            {() => (
              <View style={styles.playBtnInner}>
                <MaterialCommunityIcons name="play" size={26} color="#FFFFFF" />
                <Text style={styles.playBtnText}>Play Movie / Stream</Text>
              </View>
            )}
          </TVFocusablePressable>
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0E',
  },
  backdropHero: {
    height: 350,
    width: SCREEN_WIDTH,
    position: 'relative',
    justifyContent: 'flex-end',
  },
  backdropImage: {
    width: '100%',
    height: '100%',
    position: 'absolute',
    top: 0,
    right: 0,
  },
  bottomGradient: {
    ...StyleSheet.absoluteFillObject,
  },
  leftGradient: {
    ...StyleSheet.absoluteFillObject,
    width: '75%',
  },
  heroInfo: {
    position: 'absolute',
    bottom: 24,
    left: 48,
    maxWidth: 720,
    zIndex: 10,
  },
  backBtn: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginBottom: 14,
  },
  backBtnInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  backBtnText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  title: {
    color: '#FFFFFF',
    fontSize: 32,
    fontWeight: '800',
    marginBottom: 8,
  },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 10,
  },
  ratingBadge: {
    backgroundColor: '#F59E0B',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  ratingText: {
    color: '#000000',
    fontSize: 12,
    fontWeight: '800',
  },
  metaBadge: {
    color: '#D1D5DB',
    fontSize: 12,
    fontWeight: '600',
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 4,
  },
  overview: {
    color: '#9CA3AF',
    fontSize: 14,
    lineHeight: 20,
  },
  episodesSection: {
    paddingLeft: 48,
    marginTop: 24,
  },
  sectionHeader: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 14,
  },
  episodesScroll: {
    gap: 14,
    paddingRight: 60,
  },
  episodeCard: {
    width: 220,
    height: 75,
    backgroundColor: '#16161E',
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  episodeInner: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    gap: 12,
  },
  episodeTitle: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
    flex: 1,
  },
  playActionSection: {
    paddingLeft: 48,
    marginTop: 28,
  },
  playBtn: {
    alignSelf: 'flex-start',
    backgroundColor: '#8A5CF6',
    paddingHorizontal: 28,
    paddingVertical: 14,
  },
  playBtnInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  playBtnText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '800',
  },
  centerLoading: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingSubtext: {
    color: '#9CA3AF',
    fontSize: 15,
    marginTop: 14,
  },
});
