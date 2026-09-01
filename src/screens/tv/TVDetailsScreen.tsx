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
  onPlayStream: (streamUrl: string, title?: string, extraMeta?: any) => void;
}

export const TVDetailsScreen: React.FC<TVDetailsScreenProps> = ({
  item,
  onBack,
  onPlayStream,
}) => {
  const primaryColor = useThemeStore((state) => state.primaryColor) || '#8A5CF6';
  const provider = useContentStore((state) => state.provider);

  // Pre-seed with available item data so layout renders immediately without blank page
  const [details, setDetails] = useState<any | null>(item || null);
  const [loading, setLoading] = useState(true);
  const [selectedSeason, setSelectedSeason] = useState<number>(1);
  const [extractingStreams, setExtractingStreams] = useState(false);

  useEffect(() => {
    let isMounted = true;

    async function fetchMetadata() {
      try {
        const providerId = item.provider || provider?.value;
        const res = await providerManager.getDetails(providerId, item.link);
        if (isMounted && res) {
          setDetails(res);
        }
      } catch (e) {
        console.warn('[TVDetails] Metadata fetch error:', e);
      } finally {
        if (isMounted) setLoading(false);
      }
    }

    fetchMetadata();
    return () => {
      isMounted = false;
    };
  }, [item, provider?.value]);

  // Highest quality backdrop resolution
  const backdropUri = useMemo(() => {
    const raw =
      details?.backdrop ||
      details?.backdropUrl ||
      details?.banner ||
      details?.image ||
      details?.poster ||
      item?.image;
    if (!raw) return null;
    if (typeof raw === 'string' && raw.includes('/w500/')) {
      return raw.replace('/w500/', '/original/');
    }
    return raw;
  }, [details, item]);

  // Normalized episodes list
  const episodesList: any[] = useMemo(() => {
    if (!details) return [];
    if (Array.isArray(details.episodes) && details.episodes.length > 0) return details.episodes;
    if (Array.isArray(details.epList) && details.epList.length > 0) return details.epList;
    return [];
  }, [details]);

  // Distinct seasons
  const seasonsList = useMemo(() => {
    if (episodesList.length === 0) return [];
    const seasons = Array.from(
      new Set(episodesList.map((ep) => ep.season || 1))
    ).sort((a, b) => Number(a) - Number(b));
    return seasons;
  }, [episodesList]);

  // Filter episodes by season
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
        onPlayStream(streamUrl, targetItem.title || details?.title || item.title, {
          episodes: episodesList,
          servers: streamRes?.servers || [],
          qualities: streamRes?.qualities || [],
        });
      } else {
        ToastAndroid.show('No playable streams found for this item.', ToastAndroid.LONG);
      }
    } catch (e: any) {
      ToastAndroid.show(e?.message || 'Failed to extract stream links.', ToastAndroid.LONG);
    } finally {
      setExtractingStreams(false);
    }
  };

  return (
    <View style={styles.container}>
      {/* Background Fanart Image Fixed Behind All Content */}
      <View style={styles.backdropLayer} pointerEvents="none">
        {backdropUri && (
          <Image
            source={{ uri: backdropUri }}
            style={styles.backdropImage}
            resizeMode="cover"
          />
        )}
        {/* Gradients to keep text and stream items readable while scrolling */}
        <LinearGradient
          colors={['rgba(10, 10, 14, 0.4)', 'rgba(10, 10, 14, 0.85)', '#0A0A0E']}
          locations={[0, 0.45, 0.9]}
          style={styles.bottomGradient}
        />
        <LinearGradient
          colors={['rgba(10, 10, 14, 0.95)', 'rgba(10, 10, 14, 0.7)', 'transparent']}
          locations={[0, 0.45, 0.85]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={styles.leftGradient}
        />
      </View>

      {/* Main Scrollable Viewport Over Backdrop */}
      <ScrollView
        showsVerticalScrollIndicator={true}
        contentContainerStyle={styles.scrollContent}
        nestedScrollEnabled={true}
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
            <View style={styles.backBtnInner}>
              <MaterialCommunityIcons name="arrow-left" size={18} color="#FFFFFF" />
              <Text style={styles.backBtnText}>Back</Text>
            </View>
          )}
        </TVFocusablePressable>

        {/* Header Metadata (Raised Higher to Maximize List Area) */}
        <View style={styles.compactHeader}>
          <Text style={styles.title} numberOfLines={2}>
            {details?.title || item.title}
          </Text>

          <View style={styles.badgesRow}>
            {details?.rating ? (
              <View style={styles.ratingBadge}>
                <Text style={styles.ratingText}>★ {details.rating}</Text>
              </View>
            ) : null}
            {details?.year ? <Text style={styles.metaBadge}>{details.year}</Text> : null}
            {details?.quality ? <Text style={styles.metaBadge}>{details.quality}</Text> : null}
            {details?.tags && Array.isArray(details.tags) && (
              <Text style={styles.tagsText}>{details.tags.slice(0, 4).join(' • ')}</Text>
            )}
          </View>

          <Text style={styles.overview} numberOfLines={2}>
            {details?.description ||
              details?.overview ||
              details?.synopsis ||
              item.extra ||
              'Select an episode or quality source below to start streaming.'}
          </Text>
        </View>

        {/* Seasons Row (if multi-season series) */}
        {seasonsList.length > 1 && (
          <View style={styles.seasonsContainer}>
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
                    borderRadius={8}
                    onPress={() => setSelectedSeason(Number(seasonNum))}
                    style={[
                      styles.seasonTab,
                      isSeasonActive && { backgroundColor: primaryColor, borderColor: primaryColor },
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
          </View>
        )}

        {/* Quality / Episode List (Vertical, Scrollable, Full Real Estate) */}
        <View style={styles.listSection}>
          <Text style={styles.sectionHeader}>
            {episodesList.length > 0 ? 'Episodes & Qualities' : 'Available Streams & Qualities'}
          </Text>

          {loading ? (
            <View style={styles.inlineLoading}>
              <ActivityIndicator size="large" color={primaryColor} />
              <Text style={styles.loadingText}>Fetching available sources...</Text>
            </View>
          ) : extractingStreams ? (
            <View style={styles.inlineLoading}>
              <ActivityIndicator size="large" color={primaryColor} />
              <Text style={styles.loadingText}>Resolving playback link...</Text>
            </View>
          ) : currentSeasonEpisodes.length > 0 ? (
            <View style={styles.verticalItemsList}>
              {currentSeasonEpisodes.map((ep: any, index: number) => (
                <TVFocusablePressable
                  key={`ep-${ep.id || ep.link || index}`}
                  scaleFocused={1.02}
                  focusedBorderColor={primaryColor}
                  borderRadius={10}
                  onPress={() => handleResolveAndPlay(ep)}
                  style={styles.listItemCard}
                >
                  {({ focused }) => (
                    <View style={styles.listItemInner}>
                      <MaterialCommunityIcons
                        name="play-circle-outline"
                        size={28}
                        color={focused ? primaryColor : '#9CA3AF'}
                      />
                      <View style={styles.listItemMeta}>
                        <Text numberOfLines={1} style={styles.listItemTitle}>
                          {ep.title || `Episode ${index + 1}`}
                        </Text>
                        {ep.quality && (
                          <Text style={styles.listItemSub}>{ep.quality}</Text>
                        )}
                      </View>
                      <MaterialCommunityIcons name="chevron-right" size={20} color="#6B7280" />
                    </View>
                  )}
                </TVFocusablePressable>
              ))}
            </View>
          ) : (
            /* Single movie or direct link fallback */
            <View style={styles.verticalItemsList}>
              <TVFocusablePressable
                scaleFocused={1.02}
                focusedBorderColor={primaryColor}
                borderRadius={10}
                onPress={() => handleResolveAndPlay(item)}
                style={styles.listItemCard}
              >
                {({ focused }) => (
                  <View style={styles.listItemInner}>
                    <MaterialCommunityIcons
                      name="play"
                      size={28}
                      color={focused ? primaryColor : '#FFFFFF'}
                    />
                    <View style={styles.listItemMeta}>
                      <Text numberOfLines={1} style={styles.listItemTitle}>
                        {details?.title || item.title}
                      </Text>
                      <Text style={styles.listItemSub}>
                        {details?.quality || 'Default Quality'}
                      </Text>
                    </View>
                    <MaterialCommunityIcons name="chevron-right" size={20} color="#6B7280" />
                  </View>
                )}
              </TVFocusablePressable>
            </View>
          )}
        </View>
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0E',
  },
  backdropLayer: {
    ...StyleSheet.absoluteFillObject,
    height: SCREEN_HEIGHT,
    zIndex: 0,
  },
  backdropImage: {
    width: '100%',
    height: '100%',
    position: 'absolute',
    top: 0,
    right: 0,
    opacity: 0.55,
  },
  bottomGradient: {
    ...StyleSheet.absoluteFillObject,
  },
  leftGradient: {
    ...StyleSheet.absoluteFillObject,
    width: '80%',
  },
  scrollContent: {
    paddingLeft: 88, // Clears the sidebar navigation rail
    paddingRight: 64,
    paddingTop: 20,
    paddingBottom: 60,
    zIndex: 1,
  },
  backButton: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginBottom: 10,
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
  compactHeader: {
    maxWidth: 820,
    marginBottom: 16,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 30,
    fontWeight: '800',
    letterSpacing: 0.3,
    marginBottom: 6,
    textShadowColor: 'rgba(0, 0, 0, 0.95)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 6,
  },
  badgesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 8,
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
  tagsText: {
    color: '#9CA3AF',
    fontSize: 13,
    fontWeight: '500',
  },
  overview: {
    color: '#D1D5DB',
    fontSize: 13,
    lineHeight: 19,
    textShadowColor: 'rgba(0, 0, 0, 0.8)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  seasonsContainer: {
    marginBottom: 12,
  },
  seasonsScroll: {
    gap: 10,
    paddingVertical: 4,
  },
  seasonTab: {
    backgroundColor: '#16161E',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  seasonTabText: {
    color: '#9CA3AF',
    fontSize: 13,
    fontWeight: '700',
  },
  listSection: {
    marginTop: 6,
  },
  sectionHeader: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 12,
    letterSpacing: 0.2,
  },
  inlineLoading: {
    paddingVertical: 36,
    alignItems: 'center',
    gap: 12,
  },
  loadingText: {
    color: '#9CA3AF',
    fontSize: 14,
  },
  verticalItemsList: {
    gap: 10,
    paddingBottom: 24,
  },
  listItemCard: {
    backgroundColor: 'rgba(22, 22, 30, 0.85)',
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  listItemInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  listItemMeta: {
    flex: 1,
  },
  listItemTitle: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  listItemSub: {
    color: '#9CA3AF',
    fontSize: 12,
    marginTop: 2,
  },
});
