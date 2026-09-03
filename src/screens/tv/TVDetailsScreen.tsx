import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Image,
  ActivityIndicator,
  ToastAndroid,
} from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { TVFocusablePressable } from '../../components/tv/TVFocusablePressable';
import useContentStore from '../../lib/zustand/contentStore';
import { providerManager } from '../../lib/services/ProviderManager';
import { getCachedMetadata, getOrFetchMetadata } from '../../lib/services/metadataCache';
import type { Info, Link, EpisodeLink, TextTracks } from '../../lib/providers/types';

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
      subtitles?: TextTracks;
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

  const [info, setInfo] = useState<Info | null>(() =>
    item?.link && providerId ? getCachedMetadata(item.link, providerId) || null : null
  );
  const [loading, setLoading] = useState(!info);
  const [error, setError] = useState<string | null>(null);
  const [extractingStreams, setExtractingStreams] = useState(false);

  const [seasonIndex, setSeasonIndex] = useState(0);
  const [episodes, setEpisodes] = useState<EpisodeLink[]>([]);
  const [episodesLoading, setEpisodesLoading] = useState(false);

  // 1. Fetch real metadata (title/synopsis/image/linkList) for this title.
  //    If the home screen already warmed the cache for this title while it
  //    was focused, this resolves instantly and never shows a spinner.
  useEffect(() => {
    let isMounted = true;

    async function fetchMetadata() {
      if (!providerId || !item?.link) {
        setError('No active provider found for this media');
        setLoading(false);
        return;
      }

      const cached = getCachedMetadata(item.link, providerId);
      if (cached) {
        setInfo(cached);
        setSeasonIndex(0);
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);
      try {
        const res = await getOrFetchMetadata(item.link, providerId);
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

  // Closes the race that caused a "flash" of the wrong screen: there is one
  // render frame after `getMetaData` resolves but before the episodes
  // effect has had a chance to flip `episodesLoading` to true, during which
  // `episodes` is still `[]`. Without this derived check, that single frame
  // fell through to the movie "Play Stream" button before snapping to the
  // real episode list a moment later.
  const isAwaitingEpisodes = hasEpisodesLink && episodes.length === 0 && !error;
  const stillResolving = loading || isAwaitingEpisodes || episodesLoading || extractingStreams;

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
          subtitles: best.subtitles,
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
      {/* Backdrop stays fixed behind the scrolling content, rather than
          being confined to its own short header band. */}
      <View style={styles.backdropWrapper}>
        {bannerImage ? (
          <Image
            source={{ uri: bannerImage }}
            style={styles.backdropImage}
            resizeMode="cover"
          />
        ) : null}
        <LinearGradient
          colors={['rgba(10, 10, 14, 0.25)', 'rgba(10, 10, 14, 0.85)', '#0A0A0E']}
          locations={[0, 0.55, 1]}
          style={StyleSheet.absoluteFillObject}
        />
        <LinearGradient
          colors={['rgba(10, 10, 14, 0.95)', 'transparent']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={[StyleSheet.absoluteFillObject, { width: '75%' }]}
        />
      </View>

      <ScrollView
        style={styles.scrollArea}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <TVFocusablePressable
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

        {/* Title block, moved up so the episode/quality list below has
            more of the screen to itself. */}
        <View style={styles.titleBlock}>
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

        {/* Episode / Source list -- full-width rows stacked vertically so
            the whole page (not a cramped inner row) scrolls to reveal
            all of them, over the fixed backdrop above. */}
        {stillResolving ? (
          <View style={styles.centerInline}>
            <ActivityIndicator size="large" color="#8A5CF6" />
            <Text style={styles.loadingSubtext}>
              {extractingStreams
                ? 'Resolving stream links...'
                : isAwaitingEpisodes || episodesLoading
                ? 'Loading episodes...'
                : 'Loading media details...'}
            </Text>
          </View>
        ) : hasEpisodes ? (
          <View style={styles.listSection}>
            <Text style={styles.sectionHeader}>Episodes</Text>
            {episodes.map((ep, index) => (
              <TVFocusablePressable
                key={`ep-${ep.id || ep.link || index}`}
                hasTVPreferredFocus={index === 0}
                scaleFocused={1.02}
                focusedBorderColor="#8A5CF6"
                borderRadius={10}
                onPress={() => resolveAndPlay(ep.link, ep.title || `Episode ${index + 1}`, 'series')}
                style={styles.episodeRow}
              >
                {({ focused }) => (
                  <View style={styles.episodeRowInner}>
                    <View style={[styles.playCircle, focused && styles.playCircleFocused]}>
                      <MaterialCommunityIcons name="play" size={18} color="#FFFFFF" />
                    </View>
                    <View style={styles.episodeTextWrap}>
                      <Text numberOfLines={1} style={styles.episodeTitle}>
                        {ep.title || `Episode ${index + 1}`}
                      </Text>
                      {!!ep.description && (
                        <Text numberOfLines={1} style={styles.episodeDesc}>
                          {ep.description}
                        </Text>
                      )}
                    </View>
                  </View>
                )}
              </TVFocusablePressable>
            ))}
          </View>
        ) : directItems.length > 1 ? (
          <View style={styles.listSection}>
            <Text style={styles.sectionHeader}>Select Source</Text>
            {directItems.map((d, index) => (
              <TVFocusablePressable
                key={`direct-${d.link}-${index}`}
                hasTVPreferredFocus={index === 0}
                scaleFocused={1.02}
                focusedBorderColor="#8A5CF6"
                borderRadius={10}
                onPress={() =>
                  resolveAndPlay(d.link, info?.title || item?.title, d.type || info?.type || 'movie')
                }
                style={styles.episodeRow}
              >
                {({ focused }) => (
                  <View style={styles.episodeRowInner}>
                    <View style={[styles.playCircle, focused && styles.playCircleFocused]}>
                      <MaterialCommunityIcons name="play" size={18} color="#FFFFFF" />
                    </View>
                    <Text numberOfLines={1} style={styles.episodeTitle}>
                      {d.title}
                    </Text>
                  </View>
                )}
              </TVFocusablePressable>
            ))}
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

        <View style={{ height: 60 }} />
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0E',
  },
  backdropWrapper: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  backdropImage: {
    width: '100%',
    height: '100%',
  },
  scrollArea: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 48,
    paddingTop: 20,
    paddingBottom: 40,
  },
  backBtn: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginBottom: 20,
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
  titleBlock: {
    maxWidth: 780,
    marginBottom: 20,
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
    flexWrap: 'wrap',
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
    color: '#D1D5DB',
    fontSize: 14,
    lineHeight: 20,
  },
  seasonRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginBottom: 24,
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
  listSection: {
    marginBottom: 12,
  },
  episodeRow: {
    backgroundColor: '#16161E',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.06)',
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 10,
  },
  episodeRowInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  playCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  playCircleFocused: {
    backgroundColor: '#8A5CF6',
  },
  episodeTextWrap: {
    flex: 1,
  },
  episodeTitle: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
    flex: 1,
  },
  episodeDesc: {
    color: '#9CA3AF',
    fontSize: 12,
    marginTop: 2,
  },
  playActionSection: {
    marginTop: 8,
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
  centerInline: {
    alignItems: 'flex-start',
    paddingVertical: 30,
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
