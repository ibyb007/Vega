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
import { extensionStorage } from '../lib/storage';
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
  } | null>(null);

  // Read installed providers from store
  const storeProviders = useContentStore((state) => state.installedProviders);
  const setInstalledProviders = useContentStore((state) => state.setInstalledProviders);
  const [activeProvidersList, setActiveProvidersList] = useState<Provider[]>(storeProviders || []);

  const searchInputRef = useRef<TextInput>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Sync and hydrate installedProviders directly from MMKV storage if store is empty
  useEffect(() => {
    let list: Provider[] = [];
    if (storeProviders && storeProviders.length > 0) {
      list = storeProviders;
    } else {
      try {
        const raw = extensionStorage.getString('installedProviders');
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length > 0) {
            list = parsed;
            setInstalledProviders(parsed);
          }
        }
      } catch (e) {
        console.warn('[Search] Failed to read installedProviders from MMKV:', e);
      }
    }
    setActiveProvidersList(list);
  }, [storeProviders, setInstalledProviders]);

  const executeMultiProviderSearch = useCallback(
    async (searchQuery: string) => {
      const trimmed = searchQuery.trim();
      if (!trimmed) {
        setResults([]);
        setActiveHero(null);
        return;
      }

      // Re-read current list of providers (including fallback to MMKV)
      let providersToSearch: Provider[] = activeProvidersList;
      if (!providersToSearch || providersToSearch.length === 0) {
        try {
          const raw = extensionStorage.getString('installedProviders');
          if (raw) {
            providersToSearch = JSON.parse(raw);
          }
        } catch {}
      }

      if (!providersToSearch || providersToSearch.length === 0) {
        setResults([]);
        return;
      }

      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      abortControllerRef.current = new AbortController();

      setIsSearching(true);

      // Initialize pending groups for each installed provider
      const initialGroups: SearchResultGroup[] = providersToSearch.map((p) => ({
        provider: p,
        posts: [],
        isLoading: true,
      }));
      setResults(initialGroups);

      // Query all providers in parallel using original Vega providerManager
      await Promise.allSettled(
        providersToSearch.map(async (p, index) => {
          try {
            const data = await providerManager.search(p.value, trimmed, 1);
            let posts: Post[] = [];

            if (Array.isArray(data)) {
              posts = data;
            } else if (data && Array.isArray((data as any).posts)) {
              posts = (data as any).posts;
            } else if (data && Array.isArray((data as any).data)) {
              posts = (data as any).data;
            }

            // Ensure provider is attached to each post for player/details resolution
            posts = posts.map((post) => ({
              ...post,
              provider: post.provider || p.value,
            }));

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
    [activeProvidersList]
  );

  // Set initial fanart hero from first available result
  useEffect(() => {
    if (!activeHero && results.length > 0) {
      for (const group of results) {
        if (group.posts && group.posts.length > 0) {
          const first = group.posts[0];
          setActiveHero({
            title: first.title,
            backdropUrl: first.image,
            overview: first.extra || 'Select to view streams & episodes.',
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
            colors={['rgba(10, 10, 14, 0.3)', 'rgba(10, 10, 14, 0.85)', '#0A0A0E']}
            locations={[0, 0.6, 1]}
            style={StyleSheet.absoluteFill}
          />
          <LinearGradient
            colors={['#0A0A0E', 'rgba(10, 10, 14, 0.75)', 'transparent']}
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
              `Simultaneously search across all ${activeProvidersList.length} installed addon providers.`}
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
                  <Text style={[styles.tabText, activeTab === 'all' && styles.tabTextActive]}>
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
        {activeProvidersList.length === 0 ? (
          <View style={styles.emptyContainer}>
            <MaterialCommunityIcons name="puzzle-outline" size={64} color="#4B5563" />
            <Text style={styles.emptyTitle}>No Addons Installed</Text>
            <Text style={styles.emptySubtitle}>
              Go to the Addons tab to install providers first.
            </Text>
          </View>
        ) : results.length === 0 && !isSearching ? (
          <View style={styles.emptyContainer}>
            <MaterialCommunityIcons name="movie-search-outline" size={64} color="#4B5563" />
            <Text style={styles.emptyTitle}>Universal Search</Text>
            <Text style={styles.emptySubtitle}>
              Type above to search across {activeProvidersList.length} installed addons.
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
    paddingLeft: 96,
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
