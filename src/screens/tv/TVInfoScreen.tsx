import React, { useState, useCallback, useEffect } from 'react';
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

export interface TVInfoItem {
  link: string;
  provider?: string;
  image?: string;
  title: string;
}

export interface TVStreamSelection {
  url: string;
  title: string;
  headers?: any;
}

interface TVInfoScreenProps {
  item: TVInfoItem;
  providerValue: string;
  onBack: () => void;
  onPlay: (payload: TVStreamSelection) => void;
}

// The screen a poster press should open: metadata + season/quality picker +
// an episode (or direct-link) list. Selecting a row resolves the actual
// playable stream via the provider's `getStream` module, then hands off to
// the player. This mirrors the mobile app's Info -> SeasonList -> Player flow.
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

  const linkList = info?.linkList || [];
  const activeLink = linkList[seasonIndex];
  const hasEpisodesLink = !!activeLink?.episodesLink;
  const isSeries = (info?.type || 'series') !== 'movie' && hasEpisodesLink;

  const { data: episodes = [], isLoading: episodesLoading } = useEpisodes(
    activeLink?.episodesLink,
    providerValue,
    isSeries,
  );

  useEffect(() => {
    setSeasonIndex(0);
  }, [info?.linkList]);

  const resolveAndPlay = useCallback(
    async (link: string, title: string, type: string) => {
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
        const best = streams[0];
        onPlay({ url: best.link, title, headers: best.headers });
      } catch (e: any) {
        ToastAndroid.show(
          e?.message || 'Failed to load stream',
          ToastAndroid.LONG,
        );
      } finally {
        setResolvingLink(null);
      }
    },
    [fetchStreams, providerValue, onPlay, resolvingLink],
  );

  const title = info?.title || item.title;
  const posterImage = info?.poster || info?.image || item.image;
  const backgroundImage = info?.image || posterImage;

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

  const directItems = activeLink?.directLinks || [];

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
          <Text numberOfLines={2} style={styles.title}>
            {title}
          </Text>
          {!!info?.tags?.length && (
            <View style={styles.tagsRow}>
              {info.tags.slice(0, 4).map((t, i) => (
                <Text key={`${t}-${i}`} style={styles.tag}>
                  {t}
                </Text>
              ))}
            </View>
          )}
          <Text numberOfLines={3} style={styles.synopsis}>
            {info?.synopsis || 'No synopsis available'}
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
                    resolveAndPlay(ep.link, ep.title || `Episode ${idx + 1}`, 'series')
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
            {directItems.length === 0 ? (
              <Text style={styles.emptyText}>No playable sources found.</Text>
            ) : (
              directItems.map((d, idx) => (
                <TVFocusablePressable
                  key={`${d.link}-${idx}`}
                  hasTVPreferredFocus={linkList.length <= 1 && idx === 0}
                  scaleFocused={1.02}
                  focusedBorderColor="#8A5CF6"
                  borderRadius={10}
                  onPress={() =>
                    resolveAndPlay(d.link, title, d.type || info?.type || 'movie')
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
  title: {
    color: '#FFFFFF',
    fontSize: 32,
    fontWeight: '900',
    letterSpacing: 0.4,
    marginBottom: 8,
  },
  tagsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 10,
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
    backgroundColor: '#16161E',
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
    backgroundColor: '#16161E',
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
