import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  ScrollView,
  Image,
  ActivityIndicator,
  Dimensions,
} from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import LinearGradient from 'react-native-linear-gradient';
import { TVFocusablePressable } from '../components/tv/TVFocusablePressable';
import useContentStore from '../lib/zustand/contentStore';
import { providerManager } from '../lib/services/ProviderManager';
import { Post, Provider } from '../lib/providers/types';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

interface SearchResultGroup {
  provider: Provider;
  posts: Post[];
  isLoading: boolean;
  error?: string;
}

interface TVSearchProps {
  onSelectItem: (item: Post) => void;
}

export default function TVSearch({ onSelectItem }: TVSearchProps) {
  const [query, setQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [results, setResults] = useState<SearchResultGroup[]>([]);
  const [activeTab, setActiveTab] = useState<string>('all');
  const [activeHero, setActiveHero] = useState<{
    title: string;
    backdropUrl?: string;
    overview?: string;
    year?: string;
  } | null>(null);

  const installedProviders = useContentStore((state) => state.installedProviders);
  const searchInputRef = useRef<TextInput>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const executeMultiProviderSearch = useCallback(
    async (searchQuery: string) => {
      const trimmed = searchQuery.trim();
      if (!trimmed || installedProviders.length === 0) {
        setResults([]);
        setActiveHero(null);
        return;
      }

      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      abortControllerRef.current = new AbortController();

      setIsSearching(true);

      // Initialize placeholder states for all installed addons
      const initialGroups: SearchResultGroup[] = installedProviders.map((p) => ({
        provider: p,
        posts: [],
        isLoading: true,
      }));
      setResults(initialGroups);

      // Query all providers simultaneously
      await Promise.allSettled(
        installedProviders.map(async (p, index) => {
          try {
            const data = await providerManager.search(p.value, trimmed, 1);
            const posts = Array.isArray(data) ? data : (data as any)?.posts || [];

            setResults((prev) => {
              const next = [...prev];
              if (next[index]) {
                next[index] = {
                  ...next[index],
                  posts,
                  isLoading: false,
                };
              }
              return next;
            });
          } catch (err: any) {
            setResults((prev) => {
              const next = [...prev];
              if (next[index]) {
                next[index] = {
                  ...next[index],
                  posts: [],
                  isLoading: false,
                  error: err?.message || 'Search failed',
                };
              }
              return next;
            });
          }
        })
      );

      setIsSearching(false);
    },
    [installedProviders]
  );

  // Set the first available search result as the initial fanart hero
  useEffect(() => {
    if (!activeHero && results.length > 0) {
      for (const group of results) {
        if (group.posts && group.posts.length > 0) {
          const first = group.posts[0];
          setActiveHero({
            title: first.title,
            backdropUrl: first.image,
            overview: first.extra || 'Press select to load playback sources.',
          });
          break;
        }
      }
    }
  }, [results, activeHero]);

  const allPosts = results.flatMap((r) => r.posts);
  const displayResults =
    activeTab === 'all'
      ? results
      : results.filter((r) => r.provider.value === activeTab);

  return (
    <View style={styles.container}>
      {/* Top Fanart Hero Background */}
      {activeHero?.backdropUrl && (
        <View style={styles.heroBackgroundContainer}>
          <Image
            source={{ uri: activeHero.backdropUrl }}
            style={styles.heroBackgroundImage}
            resizeMode="cover"
          />
          <LinearGradient
            colors={['rgba(10, 10, 14, 0.4)', 'rgba(10, 10, 14, 0.85)', '#0A0A0E']}
            locations={[0, 0.6, 1]}
            style={StyleSheet.absoluteFill}
          />
          <LinearGradient
            colors={['#0A0A0E', 'rgba(10, 10, 14, 0.7)', 'transparent']}
            start={{ x: 0, y: 0 }}
            end={{ x: 0.8, y: 0 }}
            style={StyleSheet.absoluteFill}
          />
        </View>
      )}

      {/* Main Content Area */}
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {/* Dynamic Fanart Title Meta */}
        <View style={styles.heroMetaWrapper}>
          <Text numberOfLines={1} style={styles.heroTitle}>
            {activeHero?.title || 'Universal Search'}
          </Text>
          <Text numberOfLines={2} style={styles.heroOverview}>
            {activeHero?.overview ||
              `Simultaneously querying all ${installedProviders.length} installed addon providers.`}
          </Text>
        </View>

        {/* Search Input Field & Submit Action */}
        <View style={styles.header}>
          <View style={styles.searchBarWrapper}>
            <MaterialCommunityIcons name="magnify" size={24} color="#8A5CF6" />
            <TextInput
              ref={searchInputRef}
              value={query}
              onChangeText={setQuery}
              onSubmitEditing={() => executeMultiProviderSearch(query)}
              placeholder="Search movies, TV series, anime across all addons..."
              placeholderTextColor="#6B7280"
              style={styles.input}
              returnKeyType="search"
            />
            {query.length > 0 && (
              <TVFocusablePressable
                scaleFocused={1.1}
                focusedBorderColor="#8A5CF6"
                borderRadius={8}
                onPress={() => {
                  setQuery('');
                  setResults([]);
                  setActiveHero(null);
                }}
                style={styles.clearBtn}
              >
                {() => <MaterialCommunityIcons name="close" size={20} color="#9CA3AF" />}
              </TVFocusablePressable>
            )}
          </View>

          <TVFocusablePressable
            hasTVPreferredFocus={true}
            scaleFocused={1.05}
            focusedBorderColor="#FFFFFF"
            borderRadius={12}
            onPress={() => executeMultiProviderSearch(query)}
            style={styles.searchSubmitBtn}
          >
            {() => (
              <View style={styles.searchBtnContent}>
                {isSearching ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <>
                    <MaterialCommunityIcons name="cloud-search" size={20} color="#FFFFFF" />
                    <Text style={styles.searchBtnText}>Search</Text>
                  </>
                )}
              </View>
            )}
          </TVFocusablePressable>
        </View>

        {/* Addon Provider Filter Pills */}
        {results.length > 0 && (
          <View style={styles.tabBar}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.tabScroll}
            >
              <TVFocusablePressable
                scaleFocused={1.06}
                focusedBorderColor="#8A5CF6"
                borderRadius={20}
                onPress={() => setActiveTab('all')}
                style={[styles.tabItem, activeTab === 'all' && styles.tabItemActive]}
              >
                {() => (
                  <Text
                    style={[styles.tabText, activeTab === 'all' && styles.tabTextActive]}
                  >
                    All Addons ({allPosts.length})
                  </Text>
                )}
              </TVFocusablePressable>

              {results.map((group) => (
                <TVFocusablePressable
                  key={group.provider.value}
                  scaleFocused={1.06}
                  focusedBorderColor="#8A5CF6"
                  borderRadius={20}
                  onPress={() => setActiveTab(group.provider.value)}
                  style={[
                    styles.tabItem,
                    activeTab === group.provider.value && styles.tabItemActive,
                  ]}
                >
                  {() => (
                    <View style={styles.tabContentRow}>
                      <Text
                        style={[
                          styles.tabText,
                          activeTab === group.provider.value && styles.tabTextActive,
                        ]}
                      >
                        {group.provider.displayTitle || group.provider.name}
                      </Text>
                      <View style={styles.tabBadge}>
                        <Text style={styles.tabBadgeText}>{group.posts.length}</Text>
                      </View>
                    </View>
                  )}
                </TVFocusablePressable>
              ))}
            </ScrollView>
          </View>
        )}

        {/* Empty States */}
        {installedProviders.length === 0 ? (
          <View style={styles.emptyContainer}>
            <MaterialCommunityIcons name="puzzle-outline" size={64} color="#4B5563" />
            <Text style={styles.emptyTitle}>No Addons Installed</Text>
            <Text style={styles.emptySubtitle}>
              Go to the Addons tab and install provider extensions to enable search.
            </Text>
          </View>
        ) : results.length === 0 && !isSearching ? (
          <View style={styles.emptyContainer}>
            <MaterialCommunityIcons name="movie-search-outline" size={64} color="#4B5563" />
            <Text style={styles.emptyTitle}>Ready to Search</Text>
            <Text style={styles.emptySubtitle}>
              Type your title above and press Search to fetch results from all installed addons.
            </Text>
          </View>
        ) : (
          /* Multi-Provider Result Sections */
          <View style={styles.resultsWrapper}>
            {displayResults.map((group) => {
              if (!group.isLoading && group.posts.length === 0) return null;

              return (
                <View key={group.provider.value} style={styles.providerSection}>
                  <View style={styles.sectionHeader}>
                    <Text style={styles.sectionTitle}>
                      {group.provider.displayTitle || group.provider.name}
                    </Text>
                    {group.isLoading ? (
                      <ActivityIndicator size="small" color="#8A5CF6" />
                    ) : (
                      <Text style={styles.sectionCount}>{group.posts.length} results</Text>
                    )}
                  </View>

                  {group.posts.length > 0 ? (
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      contentContainerStyle={styles.horizontalRow}
                    >
                      {group.posts.map((item, pIndex) => (
                        <TVFocusablePressable
                          key={`${item.link}-${pIndex}`}
                          scaleFocused={1.08}
                          focusedBorderColor="#8A5CF6"
                          borderRadius={10}
                          onFocus={() =>
                            setActiveHero({
                              title: item.title,
                              backdropUrl: item.image,
                              overview: item.extra || 'Select to browse stream links and episodes.',
                            })
                          }
                          onPress={() => onSelectItem(item)}
                          style={styles.card}
                        >
                          {({ focused }) => (
                            <View style={styles.cardInner}>
                              <Image
                                source={{
                                  uri:
                                    item.image ||
                                    'https://placehold.jp/24/363636/ffffff/200x300.png?text=Vega',
                                }}
                                style={styles.cardPoster}
                                resizeMode="cover"
                              />
                              {focused && <View style={styles.cardGlow} />}
                              <View style={styles.cardLabelBottom}>
                                <Text numberOfLines={1} style={styles.cardLabelText}>
                                  {item.title}
                                </Text>
                              </View>
                            </View>
                          )}
                        </TVFocusablePressable>
                      ))}
                    </ScrollView>
                  ) : null}
                </View>
              );
            })}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0E',
  },
  heroBackgroundContainer: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: '75%',
    height: 380,
    overflow: 'hidden',
  },
  heroBackgroundImage: {
    width: '100%',
    height: '100%',
  },
  scrollContent: {
    paddingLeft: 96, // Ample clearance for the collapsed TV Navigation Rail
    paddingRight: 48,
    paddingTop: 36,
    paddingBottom: 60,
  },
  heroMetaWrapper: {
    maxWidth: 680,
    marginBottom: 20,
  },
  heroTitle: {
    color: '#FFFFFF',
    fontSize: 32,
    fontWeight: '800',
    letterSpacing: 0.4,
    marginBottom: 6,
    textShadowColor: 'rgba(0,0,0,0.9)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 6,
  },
  heroOverview: {
    color: '#9CA3AF',
    fontSize: 14,
    lineHeight: 20,
    textShadowColor: 'rgba(0,0,0,0.8)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    marginBottom: 24,
    maxWidth: 820,
  },
  searchBarWrapper: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#16161E',
    borderRadius: 14,
    paddingHorizontal: 16,
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  input: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 15,
    paddingVertical: 12,
    marginLeft: 12,
  },
  clearBtn: {
    padding: 6,
  },
  searchSubmitBtn: {
    backgroundColor: '#8A5CF6',
    paddingVertical: 12,
    paddingHorizontal: 22,
  },
  searchBtnContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  searchBtnText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  tabBar: {
    marginBottom: 28,
  },
  tabScroll: {
    gap: 10,
    paddingVertical: 4,
  },
  tabItem: {
    backgroundColor: '#16161E',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  tabItemActive: {
    backgroundColor: '#8A5CF6',
    borderColor: '#8A5CF6',
  },
  tabText: {
    color: '#9CA3AF',
    fontSize: 13,
    fontWeight: '600',
  },
  tabTextActive: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
  tabContentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  tabBadge: {
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 10,
  },
  tabBadgeText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
  },
  resultsWrapper: {
    gap: 28,
  },
  providerSection: {
    marginBottom: 8,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  sectionTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
  },
  sectionCount: {
    color: '#9CA3AF',
    fontSize: 13,
  },
  horizontalRow: {
    gap: 16,
    paddingVertical: 4,
  },
  card: {
    width: 145,
    height: 218,
    backgroundColor: '#16161E',
    borderRadius: 10,
  },
  cardInner: {
    flex: 1,
    borderRadius: 10,
    overflow: 'hidden',
    position: 'relative',
  },
  cardPoster: {
    width: '100%',
    height: '100%',
    borderRadius: 10,
  },
  cardGlow: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 10,
    borderWidth: 2.5,
    borderColor: '#8A5CF6',
    zIndex: 2,
  },
  cardLabelBottom: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(10, 10, 14, 0.85)',
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  cardLabelText: {
    color: '#D1D5DB',
    fontSize: 11,
    fontWeight: '600',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 80,
  },
  emptyTitle: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '700',
    marginTop: 16,
  },
  emptySubtitle: {
    color: '#9CA3AF',
    fontSize: 14,
    marginTop: 6,
    textAlign: 'center',
    maxWidth: 440,
    lineHeight: 20,
  },
});
