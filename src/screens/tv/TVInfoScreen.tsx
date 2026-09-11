import React, { useState, useCallback, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Image,
  ScrollView,
  ActivityIndicator,
  ToastAndroid,
} from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { TVFocusablePressable } from '../../components/tv/TVFocusablePressable';
import { useContentDetails } from '../../lib/hooks/useContentInfo';
import { useEpisodes, useStreamData } from '../../lib/hooks/useEpisodes';
import { settingsStorage } from '../../lib/storage';
import useContentStore from '../../lib/zustand/contentStore';
import useContinueWatchingStore from '../../lib/zustand/continueWatchingStore';
import {
  fetchMatchingCinemetaMeta,
  CinemetaMeta,
} from '../../lib/services/cinemetaService';

export interface TVInfoItem {
  link: string;
  provider?: string;
  image?: string;
  title: string;
  imdbId?: string;
  type?: string;
}

export interface TVStreamSelection {
  url: string;
  title: string;
  headers?: any;
  qualities?: { label: string; url: string; headers?: any }[];
  itemLink?: string;
  episodeId?: string;
  startPosition?: number;
}

interface TVInfoScreenProps {
  item: TVInfoItem;
  providerValue: string;
  onBack: () => void;
  onPlay: (payload: TVStreamSelection) => void;
}

// Check against Settings excluded qualities accurately (handles "1080", "1080p", "4k", "2160p")
const isQualityExcluded = (
  target: string | undefined | null,
  excludedList: string[],
): boolean => {
  if (!target || !excludedList || excludedList.length === 0) return false;
  const text = target.toLowerCase().trim();

  return excludedList.some((ex) => {
    const exLower = ex.toLowerCase().trim();
    if (!exLower) return false;

    if (exLower === '4k' || exLower === '2160p' || exLower === '2160') {
      return text.includes('4k') || text.includes('2160');
    }
    const cleanNum = exLower.replace('p', '');
    return text.includes(exLower) || (cleanNum.length >= 3 && text.includes(cleanNum));
  });
};

export const TVInfoScreen: React.FC<TVInfoScreenProps> = ({
  item,
  providerValue,
  onBack,
  onPlay,
}) => {
  const { info, isLoading, error, refetch } = useContentDetails(
    item.link,
    providerValue,
  );
  const { fetchStreams } = useStreamData();

  const [seasonIndex, setSeasonIndex] = useState(0);
  const [resolvingLink, setResolvingLink] = useState<string | null>(null);
  const [cinemetaMeta, setCinemetaMeta] = useState<CinemetaMeta | null>(null);

  const excludedQualities = useMemo(
    () => settingsStorage.getExcludedQualities() || [],
    [],
  );

  // Fetch Cinemeta metadata for landscape logo and fanart
  useEffect(() => {
    let isMounted = true;
    const targetImdbId = info?.imdbId || item.imdbId;
    const targetType = info?.type || item.type || 'movie';
    const targetTitle = info?.title || item.title;

    if (targetImdbId || targetTitle) {
      fetchMatchingCinemetaMeta(targetImdbId, targetType, targetTitle)
        .then((meta) => {
          if (isMounted && meta) {
            setCinemetaMeta(meta);
          }
        })
        .catch(() => {});
    }

    return () => {
      isMounted = false;
    };
  }, [info?.imdbId, info?.type, info?.title, item.imdbId, item.type, item.title]);

  // Filter season/quality tabs against excluded settings
  const rawLinkList = info?.linkList || [];
  const linkList = useMemo(() => {
    if (!excludedQualities.length) return rawLinkList;
    const filtered = rawLinkList.filter(
      (l) =>
        !isQualityExcluded(l?.quality, excludedQualities) &&
        !isQualityExcluded(l?.title, excludedQualities),
    );
    return filtered.length > 0 ? filtered : rawLinkList;
  }, [rawLinkList, excludedQualities]);

  const activeLink = linkList[seasonIndex] || linkList[0];
  const hasEpisodesLink = !!activeLink?.episodesLink;
  const isSeries = (info?.type || 'series') !== 'movie' && hasEpisodesLink;

  const { data: rawEpisodes = [], isLoading: episodesLoading } = useEpisodes(
    activeLink?.episodesLink,
    providerValue,
    isSeries,
  );

  // Filter episodes if quality is attached to episode objects
  const episodes = useMemo(() => {
    if (!excludedQualities.length) return rawEpisodes;
    const filtered = rawEpisodes.filter(
      (ep: any) =>
        !isQualityExcluded(ep?.quality, excludedQualities) &&
        !isQualityExcluded(ep?.title, excludedQualities),
    );
    return filtered.length > 0 ? filtered : rawEpisodes;
  }, [rawEpisodes, excludedQualities]);

  useEffect(() => {
    setSeasonIndex(0);
  }, [info?.linkList]);

  // Read saved progress using canonical episode link or main item link
  const getSavedResumePosition = useCallback(
    (canonicalLink: string): number => {
      try {
        const cwState: any = useContinueWatchingStore.getState?.();
        const cwItems = cwState?.items || [];
        const cwMatch = cwItems.find(
          (c: any) =>
            c?.infoUrl === canonicalLink ||
            c?.link === canonicalLink ||
            c?.id === canonicalLink ||
            c?.episodeId === canonicalLink,
        );
        if (cwMatch?.position) return cwMatch.position;

        const csState: any = useContentStore.getState?.();
        const history = csState?.watchHistory || [];
        const hMatch = history.find(
          (h: any) =>
            h?.link === canonicalLink ||
            h?.id === canonicalLink ||
            h?.episodeId === canonicalLink,
        );
        if (hMatch?.currentTime) return hMatch.currentTime;
      } catch (err) {
        console.warn('[TVInfoScreen] Failed to retrieve resume position:', err);
      }
      return 0;
    },
    [],
  );

  const resolveAndPlay = useCallback(
    async (link: string, title: string, type: string, episodeKey?: string) => {
      if (!link || resolvingLink) {
        return;
      }
      setResolvingLink(link);
      try {
        const streams = await fetchStreams(link, type, providerValue);
        if (!streams || streams.length === 0) {
          ToastAndroid.show('No playable stream found', ToastAndroid.SHORT);
          return;
        }

        const filteredStreams = streams.filter(
          (s) =>
            !isQualityExcluded(s?.quality, excludedQualities) &&
            !isQualityExcluded(s?.server, excludedQualities),
        );
        const usableStreams = filteredStreams.length > 0 ? filteredStreams : streams;

        const best = usableStreams[0];
        const qualities = usableStreams.map((s, idx) => ({
          label: s.quality ? `${s.quality}p` : s.server || `Source ${idx + 1}`,
          url: s.link,
          headers: s.headers,
        }));

        const canonicalKey = episodeKey || link || item.link;
        const resumePos = getSavedResumePosition(canonicalKey);

        onPlay({
          url: best.link,
          title,
          headers: best.headers,
          qualities,
          itemLink: item.link,
          episodeId: canonicalKey,
          startPosition: resumePos,
        });
      } catch (e: any) {
        ToastAndroid.show(
          e?.message || 'Failed to load stream',
          ToastAndroid.LONG,
        );
      } finally {
        setResolvingLink(null);
      }
    },
    [
      fetchStreams,
      providerValue,
      onPlay,
      resolvingLink,
      excludedQualities,
      item.link,
      getSavedResumePosition,
    ],
  );

  const title = info?.title || item.title;
  const posterImage = info?.poster || info?.image || item.image;
  const backgroundImage = cinemetaMeta?.background || info?.image || posterImage;
  const logoUrl = cinemetaMeta?.logo || (info as any)?.logo;

  if (isLoading && !info) {
    return (
      <View style={styles.centerFill}>
        <ActivityIndicator size="large" color="#8A5CF6" />
        <Text style={styles.loadingText}>Loading details…</Text>
      </View>
    );
  }

  if (error && !info) {
    return (
      <View style={styles.centerFill}>
        <MaterialCommunityIcons
          name="alert-circle-outline"
          size={48}
          color="#EF4444"
        />
        <Text style={styles.errorTitle}>Failed to load content</Text>
        <Text style={styles.errorText}>
          {(error as any)?.message || 'An unexpected error occurred'}
        </Text>
        <View style={styles.errorActions}>
          <TVFocusablePressable
            hasTVPreferredFocus
            scaleFocused={1.05}
            focusedBorderColor="#8A5CF6"
            borderRadius={10}
            onPress={() => refetch()}
            style={styles.retryBtn}
          >
            {() => <Text style={styles.retryBtnText}>Try again</Text>}
          </TVFocusablePressable>
          <TVFocusablePressable
            scaleFocused={1.05}
            focusedBorderColor="#FFFFFF"
            borderRadius={10}
            onPress={onBack}
            style={styles.backBtn}
          >
            {() => <Text style={styles.backBtnText}>Go back</Text>}
          </TVFocusablePressable>
        </View>
      </View>
    );
  }

  const rawDirectItems = activeLink?.directLinks || [];
  const directItems = rawDirectItems.filter(
    (d: any) =>
      !isQualityExcluded(d?.title, excludedQualities) &&
      !isQualityExcluded(d?.quality, excludedQualities),
  );
  const usableDirectItems = directItems.length > 0 ? directItems : rawDirectItems;

  return (
    <View style={styles.container}>
      <View style={styles.hero}>
        {backgroundImage ? (
          <Image
            source={{ uri: backgroundImage }}
            style={StyleSheet.absoluteFillObject}
            resizeMode="cover"
          />
        ) : null}
        <LinearGradient
          colors={['transparent', 'rgba(10,10,14,0.85)', '#0A0A0E']}
          style={StyleSheet.absoluteFillObject}
          start={{ x: 0.5, y: 0.1 }}
          end={{ x: 0.5, y: 1.0 }}
        />
        <LinearGradient
          colors={['#0A0A0E', 'rgba(10,10,14,0.65)', 'transparent']}
          style={StyleSheet.absoluteFillObject}
          start={{ x: 0.0, y: 0.5 }}
          end={{ x: 0.7, y: 0.5 }}
        />

        <TVFocusablePressable
          hasTVPreferredFocus
          scaleFocused={1.08}
          focusedBorderColor="#FFFFFF"
          borderRadius={22}
          onPress={onBack}
          style={styles.backIconBtn}
        >
          {() => (
            <MaterialCommunityIcons name="arrow-left" size={22} color="#FFFFFF" />
          )}
        </TVFocusablePressable>

        <View style={styles.heroContent}>
          {/* Stremio Poster Logo with Fallback to Text Title */}
          {logoUrl ? (
            <Image
              source={{ uri: logoUrl }}
              style={styles.titleLogo}
              resizeMode="contain"
            />
          ) : (
            <Text numberOfLines={2} style={styles.title}>
              {title}
            </Text>
          )}

          <View style={styles.badgesRow}>
            {info?.rating || cinemetaMeta?.imdbRating ? (
              <View style={styles.ratingBadge}>
                <Text style={styles.ratingText}>
                  ★ {info?.rating || cinemetaMeta?.imdbRating}
                </Text>
              </View>
            ) : null}
            {info?.year || cinemetaMeta?.year ? (
              <Text style={styles.metaBadge}>
                {info?.year || cinemetaMeta?.year}
              </Text>
            ) : null}
            {!!info?.tags?.length && (
              <View style={styles.tagsRow}>
                {info.tags.slice(0, 4).map((t, i) => (
                  <Text key={`${t}-${i}`} style={styles.tag}>
                    {t}
                  </Text>
                ))}
              </View>
            )}
          </View>

          <Text numberOfLines={3} style={styles.synopsis}>
            {info?.synopsis || cinemetaMeta?.description || 'No synopsis available'}
          </Text>
        </View>
      </View>

      <ScrollView style={styles.body} showsVerticalScrollIndicator={false}>
        {linkList.length > 1 && (
          <View style={styles.seasonRow}>
            {linkList.map((l, idx) => (
              <TVFocusablePressable
                key={`${l.title}-${idx}`}
                scaleFocused={1.05}
                focusedBorderColor="#8A5CF6"
                borderRadius={10}
                onPress={() => setSeasonIndex(idx)}
                style={[
                  styles.seasonChip,
                  idx === seasonIndex && styles.seasonChipActive,
                ]}
              >
                {() => (
                  <Text
                    numberOfLines={1}
                    style={[
                      styles.seasonChipText,
                      idx === seasonIndex && styles.seasonChipTextActive,
                    ]}
                  >
                    {l.title}
                    {l.quality ? ` • ${l.quality}` : ''}
                  </Text>
                )}
              </TVFocusablePressable>
            ))}
          </View>
        )}

        {isSeries ? (
          episodesLoading ? (
            <View style={styles.centerInline}>
              <ActivityIndicator size="small" color="#8A5CF6" />
              <Text style={styles.loadingText}>Loading episodes…</Text>
            </View>
          ) : episodes.length === 0 ? (
            <Text style={styles.emptyText}>No episodes found for this season.</Text>
          ) : (
            <View style={styles.episodeList}>
              {episodes.map((ep, idx) => (
                <TVFocusablePressable
                  key={`${ep.link}-${idx}`}
                  hasTVPreferredFocus={linkList.length <= 1 && idx === 0}
                  scaleFocused={1.02}
                  focusedBorderColor="#8A5CF6"
                  borderRadius={10}
                  onPress={() =>
                    resolveAndPlay(
                      ep.link,
                      ep.title || `Episode ${idx + 1}`,
                      'series',
                      ep.link || `ep-${idx + 1}`,
                    )
                  }
                  style={styles.episodeRow}
                >
                  {({ focused }) => (
                    <View style={styles.episodeRowInner}>
                      <View
                        style={[
                          styles.playCircle,
                          focused && styles.playCircleFocused,
                        ]}
                      >
                        {resolvingLink === ep.link ? (
                          <ActivityIndicator size="small" color="#FFFFFF" />
                        ) : (
                          <MaterialCommunityIcons name="play" size={18} color="#FFFFFF" />
                        )}
                      </View>
                      <View style={styles.episodeTextWrap}>
                        <Text numberOfLines={1} style={styles.episodeTitle}>
                          {ep.title || `Episode ${idx + 1}`}
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
          )
        ) : (
          <View style={styles.episodeList}>
            {usableDirectItems.length === 0 ? (
              <Text style={styles.emptyText}>No playable sources found.</Text>
            ) : (
              usableDirectItems.map((d, idx) => (
                <TVFocusablePressable
                  key={`${d.link}-${idx}`}
                  hasTVPreferredFocus={linkList.length <= 1 && idx === 0}
                  scaleFocused={1.02}
                  focusedBorderColor="#8A5CF6"
                  borderRadius={10}
                  onPress={() =>
                    resolveAndPlay(
                      d.link,
                      title,
                      d.type || info?.type || 'movie',
                      item.link,
                    )
                  }
                  style={styles.episodeRow}
                >
                  {({ focused }) => (
                    <View style={styles.episodeRowInner}>
                      <View
                        style={[
                          styles.playCircle,
                          focused && styles.playCircleFocused,
                        ]}
                      >
                        {resolvingLink === d.link ? (
                          <ActivityIndicator size="small" color="#FFFFFF" />
                        ) : (
                          <MaterialCommunityIcons name="play" size={18} color="#FFFFFF" />
                        )}
                      </View>
                      <Text numberOfLines={1} style={styles.episodeTitle}>
                        {d.title}
                      </Text>
                    </View>
                  )}
                </TVFocusablePressable>
              ))
            )}
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
  centerFill: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#0A0A0E',
    padding: 24,
  },
  centerInline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 16,
    paddingHorizontal: 32,
  },
  loadingText: {
    color: '#9CA3AF',
    fontSize: 15,
    marginTop: 12,
  },
  errorTitle: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '700',
    marginTop: 12,
  },
  errorText: {
    color: '#9CA3AF',
    fontSize: 14,
    marginTop: 6,
    textAlign: 'center',
    maxWidth: 480,
  },
  errorActions: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 22,
  },
  retryBtn: {
    backgroundColor: '#EF4444',
    paddingVertical: 10,
    paddingHorizontal: 20,
  },
  retryBtnText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 14,
  },
  backBtn: {
    backgroundColor: 'rgba(255,255,255,0.1)',
    paddingVertical: 10,
    paddingHorizontal: 20,
  },
  backBtnText: {
    color: '#D1D5DB',
    fontWeight: '600',
    fontSize: 14,
  },
  hero: {
    height: 320,
    width: '100%',
    justifyContent: 'flex-end',
  },
  backIconBtn: {
    position: 'absolute',
    top: 20,
    left: 32,
    width: 44,
    height: 44,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
  },
  heroContent: {
    paddingLeft: 32,
    paddingRight: 48,
    paddingBottom: 24,
    maxWidth: 780,
  },
  titleLogo: {
    width: 280,
    height: 80,
    marginBottom: 8,
    alignSelf: 'flex-start',
  },
  title: {
    color: '#FFFFFF',
    fontSize: 32,
    fontWeight: '900',
    letterSpacing: 0.4,
    marginBottom: 8,
  },
  badgesRow: {
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
  tagsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  tag: {
    color: '#D1D5DB',
    fontSize: 12,
    fontWeight: '600',
    backgroundColor: 'rgba(255,255,255,0.12)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
  },
  synopsis: {
    color: '#9CA3AF',
    fontSize: 14,
    lineHeight: 20,
  },
  body: {
    flex: 1,
    paddingHorizontal: 32,
    paddingTop: 20,
  },
  seasonRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginBottom: 20,
  },
  seasonChip: {
    paddingHorizontal: 16,
    paddingVertical: 9,
    backgroundColor: 'rgba(22, 22, 30, 0.4)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
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
  emptyText: {
    color: '#6B7280',
    fontSize: 14,
    paddingVertical: 16,
  },
  episodeList: {
    gap: 10,
  },
  episodeRow: {
    backgroundColor: 'rgba(22, 22, 30, 0.4)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    paddingVertical: 12,
    paddingHorizontal: 14,
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
    backgroundColor: 'rgba(255,255,255,0.1)',
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
  },
  episodeDesc: {
    color: '#9CA3AF',
    fontSize: 12,
    marginTop: 2,
  },
});

export default TVInfoScreen;
