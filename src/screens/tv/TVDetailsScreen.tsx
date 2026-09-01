import React, { useState, useEffect, useCallback, useMemo } from 'react';
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
import { providerManager } from '../../lib/services/ProviderManager';
import type { Info, Link, EpisodeLink } from '../../lib/providers/types';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

interface TVDetailsScreenProps {
  item: any;
  onBack: () => void;
  onPlayStream: (
    streamUrl: string,
    title?: string,
    extraMeta?: {
      posterUrl?: string;
      itemLink?: string;
      providerValue?: string;
      episodes?: any[];
      currentEpisodeIndex?: number;
      servers?: { name: string; url: string }[];
      qualities?: { name: string; url: string }[];
      headers?: Record<string, string>;
    }
  ) => void;
}

export const TVDetailsScreen: React.FC<TVDetailsScreenProps> = ({
  item,
  onBack,
  onPlayStream,
}) => {
  const activeStoreProvider = useContentStore((state) => state.provider);
  const providerId = item?.provider || activeStoreProvider?.value || '';

  const [info, setInfo] = useState<Info | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [extractingStreams, setExtractingStreams] = useState(false);

  const [seasonIndex, setSeasonIndex] = useState(0);
  const [episodes, setEpisodes] = useState<EpisodeLink[]>([]);
  const [episodesLoading, setEpisodesLoading] = useState(false);

  // 1. Fetch real metadata (title/synopsis/image/linkList) for this title.
  useEffect(() => {
    let isMounted = true;

    async function fetchMetadata() {
      setLoading(true);
      setError(null);
      try {
        if (!providerId || !item?.link) {
          throw new Error('No active provider found for this media');
        }
        const res = await providerManager.getMetaData({
          link: item.link,
          provider: providerId,
        });
        if (isMounted) {
          setInfo(res);
          setSeasonIndex(0);
        }
      } catch (err: any) {
        console.warn('[TVDetailsScreen] getMetaData error:', err);
        if (isMounted) setError(err?.message || 'Failed to load details');
      } finally {
        if (isMounted) setLoading(false);
      }
    }

    fetchMetadata();
    return () => {
      isMounted = false;
    };
  }, [item, providerId]);

  const linkList: Link[] = info?.linkList || [];
  const activeLink = linkList[seasonIndex];
  const hasEpisodesLink = !!activeLink?.episodesLink;

  // 2. Once we know which season/link is selected, fetch its episode list
  //    (series) -- movies use `directLinks` directly, no extra fetch needed.
  useEffect(() => {
    let isMounted = true;

    async function fetchEpisodes() {
      if (!hasEpisodesLink || !activeLink?.episodesLink) {
        setEpisodes([]);
        return;
      }
      setEpisodesLoading(true);
      try {
        const eps = await providerManager.getEpisodes({
          url: activeLink.episodesLink,
          providerValue: providerId,
        });
        if (isMounted) setEpisodes(eps || []);
      } catch (err) {
        console.warn('[TVDetailsScreen] getEpisodes error:', err);
        if (isMounted) setEpisodes([]);
      } finally {
        if (isMounted) setEpisodesLoading(false);
      }
    }

    fetchEpisodes();
    return () => {
      isMounted = false;
    };
  }, [activeLink?.episodesLink, hasEpisodesLink, providerId]);

  const directItems = activeLink?.directLinks || [];

  const resolveAndPlay = useCallback(
    async (link: string, streamTitle: string, type: string) => {
      if (!providerId || !link) {
        ToastAndroid.show('No active provider found for this media', ToastAndroid.SHORT);
        return;
      }

      setExtractingStreams(true);
      try {
        const streams = await providerManager.getStream({
          link,
          type,
          providerValue: providerId,
        });

        if (!streams || streams.length === 0) {
          ToastAndroid.show('No valid stream links found from this source.', ToastAndroid.LONG);
          return;
        }

        const best = streams[0];
        const qualities = streams.map((s, idx) => ({
          name: s.quality ? `${s.quality}p` : s.server || `Source ${idx + 1}`,
          url: s.link,
        }));

        onPlayStream(best.link, streamTitle, {
          posterUrl: info?.image || info?.poster || item?.image,
          itemLink: item?.link,
          providerValue: providerId,
          episodes,
          currentEpisodeIndex: 0,
          qualities,
          headers: best.headers,
        });
      } catch (e: any) {
        console.warn('[TVDetailsScreen] Stream extraction failed:', e);
        ToastAndroid.show(e?.message || 'Failed to extract playback stream', ToastAndroid.LONG);
      } finally {
        setExtractingStreams(false);
      }
    },
    [providerId, info, item, episodes, onPlayStream],
  );

  const bannerImage = info?.image || info?.poster || item?.image;
  const hasEpisodes = episodes.length > 0;

  if (error && !info) {
    return (
      <View style={[styles.container, styles.centerLoading]}>
        <MaterialCommunityIcons name="alert-circle-outline" size={48} color="#EF4444" />
        <Text style={styles.errorTitle}>Failed to load content</Text>
        <Text style={styles.loadingSubtext}>{error}</Text>
        <TVFocusablePressable
          hasTVPreferredFocus
          scaleFocused={1.06}
          focusedBorderColor="#FFFFFF"
          borderRadius={10}
          onPress={onBack}
          style={styles.backBtn}
        >
          {() => (
            <View style={styles.backBtnInner}>
              <MaterialCommunityIcons name="arrow-left" size={20} color="#FFFFFF" />
              <Text style={styles.backBtnText}>Go back</Text>
            </View>
          )}
        </TVFocusablePressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Top Backdrop Header */}
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
            hasTVPreferredFocus={false}
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
            {info?.title || item?.title}
          </Text>

          <View style={styles.badgeRow}>
            {info?.rating ? (
              <View style={styles.ratingBadge}>
                <Text style={styles.ratingText}>★ {info.rating}</Text>
              </View>
            ) : null}
            {(info?.tags || []).slice(0, 3).map((t, i) => (
              <Text key={`${t}-${i}`} style={styles.metaBadge}>
                {t}
              </Text>
            ))}
          </View>

          <Text style={styles.overview} numberOfLines={3}>
            {info?.synopsis || 'Select an episode or source below to start streaming.'}
          </Text>
        </View>
      </View>

      {/* Season / Quality Selector */}
      {linkList.length > 1 && (
        <View style={styles.seasonRow}>
          {linkList.map((l, idx) => (
            <TVFocusablePressable
              key={`${l.title}-${idx}`}
              scaleFocused={1.05}
              focusedBorderColor="#8A5CF6"
              borderRadius={8}
              onPress={() => setSeasonIndex(idx)}
              style={[styles.seasonChip, idx === seasonIndex && styles.seasonChipActive]}
            >
              {() => (
                <Text
                  numberOfLines={1}
                  style={[styles.seasonChipText, idx === seasonIndex && styles.seasonChipTextActive]}
                >
                  {l.title}
                  {l.quality ? ` • ${l.quality}` : ''}
                </Text>
              )}
            </TVFocusablePressable>
          ))}
        </View>
      )}

      {/* Episode / Source Selector */}
      {loading || episodesLoading || extractingStreams ? (
        <View style={styles.centerLoading}>
          <ActivityIndicator size="large" color="#8A5CF6" />
          <Text style={styles.loadingSubtext}>
            {extractingStreams
              ? 'Resolving stream links...'
              : episodesLoading
              ? 'Loading episodes...'
              : 'Loading media details...'}
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
            {episodes.map((ep, index) => (
              <TVFocusablePressable
                key={`ep-${ep.id || ep.link || index}`}
                hasTVPreferredFocus={index === 0}
                scaleFocused={1.06}
                focusedBorderColor="#8A5CF6"
                borderRadius={12}
                onPress={() => resolveAndPlay(ep.link, ep.title || `Episode ${index + 1}`, 'series')}
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
      ) : directItems.length > 1 ? (
        <View style={styles.episodesSection}>
          <Text style={styles.sectionHeader}>Select Source</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.episodesScroll}
          >
            {directItems.map((d, index) => (
              <TVFocusablePressable
                key={`direct-${d.link}-${index}`}
                hasTVPreferredFocus={index === 0}
                scaleFocused={1.06}
                focusedBorderColor="#8A5CF6"
                borderRadius={12}
                onPress={() =>
                  resolveAndPlay(d.link, info?.title || item?.title, d.type || info?.type || 'movie')
                }
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
                      {d.title}
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
            hasTVPreferredFocus={true}
            scaleFocused={1.06}
            focusedBorderColor="#FFFFFF"
            borderRadius={14}
            onPress={() =>
              resolveAndPlay(
                directItems[0]?.link || item?.link,
                info?.title || item?.title,
                directItems[0]?.type || info?.type || 'movie',
              )
            }
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
  seasonRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    paddingLeft: 48,
    marginTop: 20,
  },
  seasonChip: {
    paddingHorizontal: 16,
    paddingVertical: 9,
    backgroundColor: '#16161E',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  seasonChipActive: {
    backgroundColor: 'rgba(138, 92, 246, 0.22)',
    borderColor: '#8A5CF6',
  },
  seasonChipText: {
    color: '#9CA3AF',
    fontSize: 13,
    fontWeight: '600',
  },
  seasonChipTextActive: {
    color: '#FFFFFF',
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
  errorTitle: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '700',
    marginTop: 12,
    marginBottom: 4,
  },
});
