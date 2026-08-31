import React, { useState, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Image,
  ActivityIndicator,
  Dimensions,
  ToastAndroid,
} from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { TVFocusablePressable } from '../../components/tv/TVFocusablePressable';
import useContentStore from '../../lib/zustand/contentStore';
import useThemeStore from '../../lib/zustand/themeStore';
import { providerManager } from '../../lib/services/ProviderManager';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

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
  const primaryColor = useThemeStore((state) => state.primaryColor) || '#8A5CF6';
  const provider = useContentStore((state) => state.provider);

  const [details, setDetails] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedSeason, setSelectedSeason] = useState<number>(1);
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
      } catch (e) {
        console.warn('[TVDetails] Metadata fetch error:', e);
        if (isMounted) setDetails(item);
      } finally {
        if (isMounted) setLoading(false);
      }
    }

    fetchMetadata();
    return () => {
      isMounted = false;
    };
  }, [item, provider?.value]);

  // Resolve best backdrop image using original Vega cascade
  const backdropUri = useMemo(() => {
    const raw =
      details?.backdrop ||
      details?.backdropUrl ||
      details?.banner ||
      details?.image ||
      details?.poster ||
      item?.image;
    if (!raw) return null;
    // Upgrade TMDB / Vega poster resolution if standard low-res path exists
    if (typeof raw === 'string' && raw.includes('/w500/')) {
      return raw.replace('/w500/', '/original/');
    }
    return raw;
  }, [details, item]);

  // Extract season numbers & episodes
  const episodesList: any[] = useMemo(() => {
    if (!details) return [];
    if (Array.isArray(details.episodes)) return details.episodes;
    if (Array.isArray(details.epList)) return details.epList;
    return [];
  }, [details]);

  const seasonsList = useMemo(() => {
    if (episodesList.length === 0) return [];
    const seasons = Array.from(
      new Set(episodesList.map((ep) => ep.season || 1))
    ).sort((a, b) => Number(a) - Number(b));
    return seasons;
  }, [episodesList]);

  const currentSeasonEpisodes = useMemo(() => {
    if (episodesList.length === 0) return [];
    if (seasonsList.length <= 1) return episodesList;
    return episodesList.filter((ep) => (ep.season || 1) === selectedSeason);
  }, [episodesList, seasonsList, selectedSeason]);

  const handleResolveAndPlay = async (targetItem: any) => {
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
      } else {
        ToastAndroid.show('No active stream links returned by provider.', ToastAndroid.LONG);
      }
    } catch (e: any) {
      ToastAndroid.show(e?.message || 'Failed to extract stream link', ToastAndroid.LONG);
    } finally {
      setExtractingStreams(false);
    }
  };

  return (
    <View style={styles.container}>
      {/* Absolute Backdrop Banner with Gradient Vignette */}
      <View style={styles.backdropContainer}>
        {backdropUri && (
          <Image
            source={{ uri: backdropUri }}
            style={styles.backdropImage}
            resizeMode="cover"
          />
        )}
        <LinearGradient
          colors={['transparent', 'rgba(10, 10, 14, 0.75)', '#0A0A0E']}
          locations={[0, 0.55, 1]}
          style={styles.bottomGradient}
        />
        <LinearGradient
          colors={['rgba(10, 10, 14, 0.98)', 'rgba(10, 10, 14, 0.65)', 'transparent']}
          locations={[0, 0.45, 0.85]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={styles.leftGradient}
        />
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {/* Back Button */}
        <TVFocusablePressable
          hasTVPreferredFocus={true}
          scaleFocused={1.08}
          focusedBorderColor={primaryColor}
          borderRadius={8}
          onPress={onBack}
          style={styles.backButton}
        >
          {() => (
            <View style={styles.btnInner}>
              <MaterialCommunityIcons name="arrow-left" size={20} color="#FFFFFF" />
              <Text style={styles.backButtonText}>Back</Text>
            </View>
          )}
        </TVFocusablePressable>

        {/* Media Metadata */}
        <View style={styles.metaContainer}>
          <Text style={styles.title} numberOfLines={2}>
            {details?.title || item.title}
          </Text>

          <View style={styles.badgesRow}>
            {details?.rating && (
              <View style={styles.ratingBadge}>
                <Text style={styles.ratingText}>★ {details.rating}</Text>
              </View>
            )}
            {details?.year && <Text style={styles.metaBadge}>{details.year}</Text>}
            {details?.quality && <Text style={styles.metaBadge}>{details.quality}</Text>}
            {details?.tags && Array.isArray(details.tags) && (
              <Text style={styles.tagsText}>{details.tags.slice(0, 3).join(' • ')}</Text>
            )}
          </View>

          <Text style={styles.overview} numberOfLines={4}>
            {details?.description ||
              details?.overview ||
              details?.synopsis ||
              item.extra ||
              'No overview available for this title.'}
          </Text>
        </View>

        {/* Loading / Extraction State */}
        {loading || extractingStreams ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={primaryColor} />
            <Text style={styles.loadingText}>
              {extractingStreams ? 'Extracting stream sources...' : 'Loading media details...'}
            </Text>
          </View>
        ) : episodesList.length > 0 ? (
          /* TV Series / Multi-Episode Layout */
          <View style={styles.episodesWrapper}>
            {/* Season Tabs */}
            {seasonsList.length > 1 && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.seasonsScroll}
              >
                {seasonsList.map((seasonNum) => {
                  const isSeasonActive = selectedSeason === seasonNum;
                  return (
                    <TVFocusablePressable
                      key={`season-${seasonNum}`}
                      scaleFocused={1.05}
                      focusedBorderColor={primaryColor}
                      borderRadius={10}
                      onPress={() => setSelectedSeason(Number(seasonNum))}
                      style={[
                        styles.seasonTab,
                        isSeasonActive && { backgroundColor: primaryColor },
                      ]}
                    >
                      {() => (
                        <Text style={[styles.seasonTabText, isSeasonActive && { color: '#FFFFFF' }]}>
                          Season {seasonNum}
                        </Text>
                      )}
                    </TVFocusablePressable>
                  );
                })}
              </ScrollView>
            )}

            {/* Episode Cards */}
            <Text style={styles.sectionTitle}>Episodes</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.episodesScroll}
            >
              {currentSeasonEpisodes.map((ep: any, index: number) => (
                <TVFocusablePressable
                  key={`ep-${ep.id || ep.link || index}`}
                  scaleFocused={1.06}
                  focusedBorderColor={primaryColor}
                  borderRadius={12}
                  onPress={() => handleResolveAndPlay(ep)}
                  style={styles.episodeCard}
                >
                  {({ focused }) => (
                    <View style={styles.episodeCardInner}>
                      <MaterialCommunityIcons
                        name="play-circle-outline"
                        size={32}
                        color={focused ? primaryColor : '#9CA3AF'}
                      />
                      <View style={styles.episodeMeta}>
                        <Text numberOfLines={1} style={styles.episodeTitle}>
                          {ep.title || `Episode ${index + 1}`}
                        </Text>
                        {ep.quality && <Text style={styles.episodeQuality}>{ep.quality}</Text>}
                      </View>
                    </View>
                  )}
                </TVFocusablePressable>
              ))}
            </ScrollView>
          </View>
        ) : (
          /* Movie / Direct Play Layout */
          <View style={styles.playActionWrapper}>
            <TVFocusablePressable
              scaleFocused={1.06}
              focusedBorderColor="#FFFFFF"
              borderRadius={14}
              onPress={() => handleResolveAndPlay(item)}
              style={[styles.playButton, { backgroundColor: primaryColor }]}
            >
              {() => (
                <View style={styles.btnInner}>
                  <MaterialCommunityIcons name="play" size={26} color="#FFFFFF" />
                  <Text style={styles.playButtonText}>Play Movie / Stream</Text>
                </View>
              )}
            </TVFocusablePressable>
          </View>
        )}
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0E',
  },
  backdropContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 420,
    overflow: 'hidden',
  },
  backdropImage: {
    width: '100%',
    height: '100%',
    position: 'absolute',
    right: 0,
    top: 0,
  },
  bottomGradient: {
    ...StyleSheet.absoluteFillObject,
  },
  leftGradient: {
    ...StyleSheet.absoluteFillObject,
    width: '75%',
  },
  scrollContent: {
    paddingLeft: 88, // Clears the sidebar navigation rail
    paddingRight: 48,
    paddingTop: 32,
    paddingBottom: 60,
  },
  backButton: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    paddingHorizontal: 14,
    paddingVertical: 8,
    marginBottom: 20,
  },
  btnInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  backButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  metaContainer: {
    maxWidth: 720,
    marginBottom: 28,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 34,
    fontWeight: '800',
    letterSpacing: 0.4,
    marginBottom: 10,
    textShadowColor: 'rgba(0, 0, 0, 0.9)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 8,
  },
  badgesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 12,
  },
  ratingBadge: {
    backgroundColor: '#F59E0B',
    paddingHorizontal: 7,
    paddingVertical: 3,
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
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
  },
  tagsText: {
    color: '#9CA3AF',
    fontSize: 13,
    fontWeight: '500',
  },
  overview: {
    color: '#D1D5DB',
    fontSize: 14,
    lineHeight: 22,
    textShadowColor: 'rgba(0, 0, 0, 0.8)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  loadingContainer: {
    paddingVertical: 40,
    alignItems: 'center',
    gap: 12,
  },
  loadingText: {
    color: '#9CA3AF',
    fontSize: 15,
  },
  episodesWrapper: {
    marginTop: 10,
  },
  seasonsScroll: {
    gap: 12,
    marginBottom: 18,
  },
  seasonTab: {
    backgroundColor: '#16161E',
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  seasonTabText: {
    color: '#9CA3AF',
    fontSize: 13,
    fontWeight: '700',
  },
  sectionTitle: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 12,
  },
  episodesScroll: {
    gap: 14,
    paddingRight: 40,
    paddingVertical: 6,
  },
  episodeCard: {
    width: 240,
    height: 80,
    backgroundColor: '#16161E',
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    paddingHorizontal: 14,
    justifyContent: 'center',
  },
  episodeCardInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  episodeMeta: {
    flex: 1,
  },
  episodeTitle: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  episodeQuality: {
    color: '#9CA3AF',
    fontSize: 12,
    marginTop: 2,
  },
  playActionWrapper: {
    marginTop: 12,
  },
  playButton: {
    alignSelf: 'flex-start',
    paddingHorizontal: 28,
    paddingVertical: 14,
  },
  playButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '800',
  },
});
