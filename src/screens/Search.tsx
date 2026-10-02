import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  ScrollView,
  Image,
  ActivityIndicator,
  Keyboard,
} from 'react-native';
import KeyEvent from 'react-native-keyevent';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import LinearGradient from 'react-native-linear-gradient';
import { TVFocusablePressable } from '../components/tv/TVFocusablePressable';
import { registerRailLeftEdge } from '../lib/tv/registerRailLeftEdge';
import { useTVEntryFocus } from '../lib/tv/useTVEntryFocus';
import useContentStore from '../lib/zustand/contentStore';
import { providerManager } from '../lib/services/ProviderManager';
import { extensionStorage } from '../lib/storage';
import { searchCinemetaCatalog, CinemetaSearchHit } from '../lib/services/cinemetaService';
import { Post, Provider } from '../lib/providers/types';

interface SearchResultGroup {
  provider: Provider;
  providerName: string;
  posts: Post[];
  isLoading: boolean;
  error?: string;
}

interface TVSearchProps {
  onSelectItem: (item: Post) => void;
  onRegisterBackHandler?: (handler: (() => boolean) | null) => void;
  onRegisterEntryHandleGetter?: (getter: (() => number | null) | null) => void;
  onRegisterReturnFocusTrigger?: (trigger: (() => void) | null) => void;
  resetFocusOnMount?: boolean;
}

const getProviderDisplayName = (p: Provider | any): string => {
  return p?.display_name || p?.displayTitle || p?.name || p?.value || 'Provider';
};

// Module-level so it survives this screen unmounting when the user leaves
// the Search tab and comes back -- same pattern as TVHomeScreen's
// `lastFocusedKey`.
let lastFocusedSearchKey: string | null = null;

// Android key codes (react-native-keyevent reports raw KEYCODE_* values).
const KEYCODE_DPAD_CENTER = 23;
const KEYCODE_ENTER = 66;

const SUGGESTION_MIN_CHARS = 2;
const SUGGESTION_DEBOUNCE_MS = 250;
const MAX_SUGGESTIONS = 6;

// Also module-level (mirrors TVDiscoverScreen's `savedDiscoverState`):
// selecting a result opens TVDetailsScreen full-screen, which unmounts this
// whole component (App.tsx swaps its entire content tree while
// `selectedItem` is set). Without this, coming back from details wiped the
// query/results/tab/hero back to their initial empty state even though the
// user never actually left the Search tab -- this keeps that content alive
// across that round trip so Back genuinely returns to where they were.
interface SavedSearchState {
  query: string;
  results: SearchResultGroup[];
  activeTab: string;
  activeHero: {
    title: string;
    backdropUrl?: string;
    overview?: string;
    sourceName?: string;
  } | null;
}
let savedSearchState: SavedSearchState | null = null;

export default function TVSearch({
  onSelectItem,
  onRegisterBackHandler,
  onRegisterEntryHandleGetter,
  onRegisterReturnFocusTrigger,
  resetFocusOnMount,
}: TVSearchProps) {
  const { setItemRef, keyFor, shouldPreferFocus } = useTVEntryFocus(
    () => lastFocusedSearchKey,
    onRegisterEntryHandleGetter,
    onRegisterReturnFocusTrigger,
    resetFocusOnMount,
    () => {
      lastFocusedSearchKey = null;
    }
  );
  const [query, setQuery] = useState(savedSearchState?.query ?? '');
  const [isSearching, setIsSearching] = useState(false);
  const [results, setResults] = useState<SearchResultGroup[]>(savedSearchState?.results ?? []);
  const [activeTab, setActiveTab] = useState<string>(savedSearchState?.activeTab ?? 'all');
  const [activeHero, setActiveHero] = useState<{
    title: string;
    backdropUrl?: string;
    overview?: string;
    sourceName?: string;
  } | null>(savedSearchState?.activeHero ?? null);

  // Keep the module-level snapshot in sync with the latest state so it's
  // ready the instant this screen unmounts (there's no unmount event to
  // hook into that fires reliably before App.tsx tears the tree down).
  useEffect(() => {
    savedSearchState = { query, results, activeTab, activeHero };
  }, [query, results, activeTab, activeHero]);

  const storeProviders = useContentStore((state) => state.installedProviders);
  const setInstalledProviders = useContentStore((state) => state.setInstalledProviders);
  const [activeProviders, setActiveProviders] = useState<Provider[]>([]);

  const searchInputRef = useRef<TextInput | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // ---- Search field focus / keyboard handling ---------------------------
  // The TextInput itself is the D-pad focus target (it used to be nested
  // inside a focusable Pressable, which fought it for focus: the first OK
  // only moved native focus, and the layout change when the clear button
  // appeared after the 1st letter made Android drop the cursor).
  const [inputFocused, setInputFocused] = useState(false);
  const inputFocusedRef = useRef(false);
  const keyboardVisibleRef = useRef(false);

  // TextInput doesn't take `hasTVPreferredFocus`, so to put native focus on
  // it *without* popping the keyboard we briefly turn off
  // showSoftInputOnFocus, focus(), then turn it back on.
  const [softKeyboardOnFocus, setSoftKeyboardOnFocus] = useState(true);
  const [quietFocusNonce, setQuietFocusNonce] = useState(0);
  const focusInputQuietly = useCallback(() => {
    setSoftKeyboardOnFocus(false);
    setQuietFocusNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    if (quietFocusNonce === 0) return;
    const raf = requestAnimationFrame(() => searchInputRef.current?.focus());
    const restore = setTimeout(() => setSoftKeyboardOnFocus(true), 250);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(restore);
    };
  }, [quietFocusNonce]);

  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => {
      keyboardVisibleRef.current = true;
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      keyboardVisibleRef.current = false;
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  // Safety net for "OK doesn't open the keyboard": if OK/Enter is released
  // while the field is focused and no keyboard appeared, ask for it.
  useEffect(() => {
    const handleKeyUp = (e: { keyCode?: number }) => {
      if (e?.keyCode !== KEYCODE_DPAD_CENTER && e?.keyCode !== KEYCODE_ENTER) return;
      if (!inputFocusedRef.current) return;
      setTimeout(() => {
        if (inputFocusedRef.current && !keyboardVisibleRef.current) {
          searchInputRef.current?.focus();
        }
      }, 150);
    };
    KeyEvent.onKeyUpListener(handleKeyUp);
    return () => KeyEvent.removeKeyUpListener();
  }, []);

  // Stable ref callback (an inline one re-runs on every keystroke). Reads
  // the latest focus helpers through a ref so its identity never changes.
  const preferFocusRef = useRef(shouldPreferFocus);
  preferFocusRef.current = shouldPreferFocus;
  const setSearchInputRef = useCallback(
    (el: TextInput | null) => {
      searchInputRef.current = el;
      setItemRef('search-bar', el);
      if (el) {
        registerRailLeftEdge('search', el);
        // Fresh visit (or rail handing focus back) -> land on the field.
        if (preferFocusRef.current('search-bar', true)) focusInputQuietly();
      }
    },
    [setItemRef, focusInputQuietly]
  );

  // ---- Inline suggestions (Cinemeta, same source the app already uses) --
  const [suggestions, setSuggestions] = useState<CinemetaSearchHit[]>([]);
  // True right after a submit / suggestion pick / restored query so the
  // list stays closed until the user types again.
  const suppressSuggestionsRef = useRef<boolean>(Boolean(savedSearchState?.query));
  const suggestReqRef = useRef(0);

  useEffect(() => {
    const q = query.trim();
    const reqId = ++suggestReqRef.current;
    if (suppressSuggestionsRef.current || q.length < SUGGESTION_MIN_CHARS) {
      setSuggestions([]);
      return;
    }
    const timer = setTimeout(async () => {
      const [movies, series] = await Promise.all([
        searchCinemetaCatalog(q, 'movie'),
        searchCinemetaCatalog(q, 'series'),
      ]);
      if (reqId !== suggestReqRef.current || suppressSuggestionsRef.current) return;

      const lower = q.toLowerCase();
      const interleaved: CinemetaSearchHit[] = [];
      for (let i = 0; i < Math.max(movies.length, series.length); i++) {
        if (movies[i]) interleaved.push(movies[i]);
        if (series[i]) interleaved.push(series[i]);
      }
      const seen = new Set<string>();
      const unique = interleaved.filter((h) => {
        if (seen.has(h.imdbId)) return false;
        seen.add(h.imdbId);
        return true;
      });
      // Titles that start with what was typed first, otherwise keep order.
      const prefix = unique.filter((h) => h.name.toLowerCase().startsWith(lower));
      const rest = unique.filter((h) => !h.name.toLowerCase().startsWith(lower));
      setSuggestions([...prefix, ...rest].slice(0, MAX_SUGGESTIONS));
    }, SUGGESTION_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const handleChangeText = useCallback((text: string) => {
    suppressSuggestionsRef.current = false;
    setQuery(text);
  }, []);

  // No local back-stack on this screen — Back is handled centrally by
  // App.tsx, which moves focus to the Search button on the rail.
  useEffect(() => {
    onRegisterBackHandler?.(() => false);
    return () => onRegisterBackHandler?.(null);
  }, [onRegisterBackHandler]);

  const getPersistedProviders = useCallback((): Provider[] => {
    try {
      const raw = extensionStorage.getString('installedProviders');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      }
    } catch (e) {
      console.warn('[Search] Failed to read installedProviders from MMKV:', e);
    }
    return [];
  }, []);

  useEffect(() => {
    let list = storeProviders || [];
    if (!list || list.length === 0) {
      const persisted = getPersistedProviders();
      if (persisted.length > 0) {
        list = persisted;
        setInstalledProviders(persisted);
      }
    }
    setActiveProviders(list);
  }, [storeProviders, getPersistedProviders, setInstalledProviders]);

  const normalizePosts = (data: any, providerValue: string, providerName: string): Post[] => {
    let rawList: any[] = [];
    if (Array.isArray(data)) {
      rawList = data;
    } else if (data && Array.isArray(data.posts)) {
      rawList = data.posts;
    } else if (data && Array.isArray(data.data)) {
      rawList = data.data;
    } else if (data && Array.isArray(data.results)) {
      rawList = data.results;
    }

    return rawList
      .filter((item) => Boolean(item && (item.title || item.name)))
      .map((item) => ({
        ...item,
        title: item.title || item.name || 'Untitled',
        image: item.image || item.poster || item.banner || '',
        link: item.link || item.url || '',
        provider: item.provider || providerValue,
        providerName: providerName,
      }));
  };

  const executeMultiProviderSearch = useCallback(
    async (searchQuery: string) => {
      const trimmed = searchQuery.trim();
      if (!trimmed) {
        setResults([]);
        setActiveHero(null);
        return;
      }

      let currentList = activeProviders;
      if (!currentList || currentList.length === 0) {
        currentList = getPersistedProviders();
      }

      if (!currentList || currentList.length === 0) {
        setResults([]);
        return;
      }

      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      abortControllerRef.current = new AbortController();

      setIsSearching(true);

      const initialGroups: SearchResultGroup[] = currentList.map((p) => ({
        provider: p,
        providerName: getProviderDisplayName(p),
        posts: [],
        isLoading: true,
      }));
      setResults(initialGroups);

      await Promise.allSettled(
        currentList.map(async (p, index) => {
          const pName = getProviderDisplayName(p);
          try {
            let data: any = null;

            if (typeof (providerManager as any).getSearchPosts === 'function') {
              data = await (providerManager as any).getSearchPosts({
                searchQuery: trimmed,
                page: 1,
                providerValue: p.value,
                signal: abortControllerRef.current?.signal,
              });
            } else if (typeof (providerManager as any).search === 'function') {
              data = await (providerManager as any).search(p.value, trimmed, 1);
            }

            const cleanPosts = normalizePosts(data, p.value, pName);

            setResults((prev) => {
              const next = [...prev];
              if (next[index]) {
                next[index] = {
                  ...next[index],
                  posts: cleanPosts,
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
    [activeProviders, getPersistedProviders]
  );

  const submitSearch = useCallback(
    (text: string) => {
      suppressSuggestionsRef.current = true;
      setSuggestions([]);
      executeMultiProviderSearch(text);
    },
    [executeMultiProviderSearch]
  );

  // IME "search" key: run the search, drop the keyboard, but keep D-pad
  // focus on the field so Down/Right keep working from there.
  const handleSubmitEditing = useCallback(() => {
    submitSearch(query);
    searchInputRef.current?.blur();
    focusInputQuietly();
  }, [query, submitSearch, focusInputQuietly]);

  const handlePickSuggestion = useCallback(
    (hit: CinemetaSearchHit) => {
      setQuery(hit.name);
      submitSearch(hit.name);
      focusInputQuietly();
    },
    [submitSearch, focusInputQuietly]
  );

  const handleClear = useCallback(() => {
    suppressSuggestionsRef.current = true;
    setQuery('');
    setSuggestions([]);
    setResults([]);
    setActiveHero(null);
    focusInputQuietly();
  }, [focusInputQuietly]);

  useEffect(() => {
    if (!activeHero && results.length > 0) {
      for (const group of results) {
        if (group.posts && group.posts.length > 0) {
          const first: any = group.posts[0];
          setActiveHero({
            title: first.title,
            backdropUrl: first.image,
            overview: first.extra || 'Select to browse stream links and episodes.',
            sourceName: group.providerName,
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
      {activeHero?.backdropUrl && (
        <View style={styles.heroBackgroundContainer} pointerEvents="none">
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

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        <View style={styles.heroMetaWrapper}>
          <View style={styles.heroHeaderRow}>
            <Text numberOfLines={1} style={styles.heroTitle}>
              {activeHero?.title || 'Universal Search'}
            </Text>
            {activeHero?.sourceName ? (
              <View style={styles.sourceBadge}>
                <MaterialCommunityIcons name="server-network" size={12} color="#FFFFFF" />
                <Text style={styles.sourceBadgeText}>{activeHero.sourceName}</Text>
              </View>
            ) : null}
          </View>
          <Text numberOfLines={2} style={styles.heroOverview}>
            {activeHero?.overview ||
              `Simultaneously query across all ${activeProviders.length} active addon providers.`}
          </Text>
        </View>

        <View style={styles.header}>
          <View
            style={[
              styles.searchBarWrapper,
              inputFocused && styles.searchBarWrapperFocused,
            ]}
          >
            <MaterialCommunityIcons name="magnify" size={24} color="#8A5CF6" />
            <TextInput
              key={keyFor('search-bar')}
              ref={setSearchInputRef}
              value={query}
              onChangeText={handleChangeText}
              onSubmitEditing={handleSubmitEditing}
              onFocus={() => {
                inputFocusedRef.current = true;
                setInputFocused(true);
                lastFocusedSearchKey = 'search-bar';
              }}
              onBlur={() => {
                inputFocusedRef.current = false;
                setInputFocused(false);
              }}
              showSoftInputOnFocus={softKeyboardOnFocus}
              placeholder="Search movies, TV shows, anime across all addons..."
              placeholderTextColor="#6B7280"
              style={styles.input}
              returnKeyType="search"
              submitBehavior="submit"
              autoCorrect={false}
              autoCapitalize="none"
            />
            {/* Always mounted: mounting it on the 1st typed letter changed
                the layout under the focused field and dropped the cursor. */}
            <TVFocusablePressable
              focusable={query.length > 0}
              scaleFocused={1.1}
              focusedBorderColor="#8A5CF6"
              borderRadius={8}
              onPress={handleClear}
              style={[styles.clearBtn, query.length === 0 && styles.clearBtnHidden]}
            >
              {() => <MaterialCommunityIcons name="close" size={20} color="#9CA3AF" />}
            </TVFocusablePressable>
          </View>

          <TVFocusablePressable
            key={keyFor('search-submit')}
            ref={(el) => setItemRef('search-submit', el)}
            hasTVPreferredFocus={shouldPreferFocus('search-submit', false)}
            onFocus={() => (lastFocusedSearchKey = 'search-submit')}
            scaleFocused={1.05}
            focusedBorderColor="#FFFFFF"
            borderRadius={12}
            onPress={() => submitSearch(query)}
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

        {suggestions.length > 0 && (
          <View style={styles.suggestionsPanel}>
            {suggestions.map((hit) => (
              <TVFocusablePressable
                key={`suggest-${hit.type}-${hit.imdbId}`}
                scaleFocused={1.02}
                focusedBorderColor="#8A5CF6"
                borderRadius={10}
                onPress={() => handlePickSuggestion(hit)}
                style={styles.suggestionRow}
              >
                {({ focused }) => (
                  <View style={styles.suggestionInner}>
                    <MaterialCommunityIcons
                      name={hit.type === 'movie' ? 'movie-open-outline' : 'television-classic'}
                      size={20}
                      color={focused ? '#FFFFFF' : '#8A5CF6'}
                    />
                    <Text
                      numberOfLines={1}
                      style={[styles.suggestionTitle, focused && styles.suggestionTitleFocused]}
                    >
                      {hit.name}
                    </Text>
                    {hit.year ? <Text style={styles.suggestionMeta}>{hit.year}</Text> : null}
                    <Text style={styles.suggestionMeta}>
                      {hit.type === 'movie' ? 'Movie' : 'Series'}
                    </Text>
                  </View>
                )}
              </TVFocusablePressable>
            ))}
          </View>
        )}

        {results.length > 0 && (
          <View style={styles.tabBar}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.tabScroll}
            >
              <TVFocusablePressable
                key={keyFor('tab-all')}
                ref={(el) => {
                  setItemRef('tab-all', el);
                  // Fixed first tab in this horizontal bar -- another of the
                  // screen's left-edge rows once results are showing.
                  if (el) registerRailLeftEdge('search', el);
                }}
                hasTVPreferredFocus={shouldPreferFocus('tab-all', false)}
                onFocus={() => (lastFocusedSearchKey = 'tab-all')}
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

              {results.map((group) => {
                const tabKey = `tab-${group.provider.value}`;
                return (
                  <TVFocusablePressable
                    key={keyFor(tabKey)}
                    ref={(el) => setItemRef(tabKey, el)}
                    hasTVPreferredFocus={shouldPreferFocus(tabKey, false)}
                    onFocus={() => (lastFocusedSearchKey = tabKey)}
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
                          {group.providerName}
                        </Text>
                        <View style={styles.tabBadge}>
                          <Text style={styles.tabBadgeText}>{group.posts.length}</Text>
                        </View>
                      </View>
                    )}
                  </TVFocusablePressable>
                );
              })}
            </ScrollView>
          </View>
        )}

        {activeProviders.length === 0 ? (
          <View style={styles.emptyContainer}>
            <MaterialCommunityIcons name="puzzle-outline" size={64} color="#4B5563" />
            <Text style={styles.emptyTitle}>No Addons Installed</Text>
            <Text style={styles.emptySubtitle}>
              Go to the Addons menu and install providers to activate universal search.
            </Text>
          </View>
        ) : results.length === 0 && !isSearching ? (
          <View style={styles.emptyContainer}>
            <MaterialCommunityIcons name="movie-search-outline" size={64} color="#4B5563" />
            <Text style={styles.emptyTitle}>Universal Search</Text>
            <Text style={styles.emptySubtitle}>
              Type your query above to search across all {activeProviders.length} active addon scrapers.
            </Text>
          </View>
        ) : (
          <View style={styles.resultsWrapper}>
            {displayResults.map((group) => {
              if (!group.isLoading && group.posts.length === 0) return null;

              return (
                <View key={group.provider.value} style={styles.providerSection}>
                  <View style={styles.sectionHeader}>
                    <View style={styles.sectionTitleRow}>
                      <MaterialCommunityIcons name="server-network" size={18} color="#8A5CF6" />
                      <Text style={styles.sectionTitle}>{group.providerName}</Text>
                    </View>
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
                      {group.posts.map((item: any, pIndex) => {
                        const posterKey = `poster-${group.provider.value}-${item.link}-${pIndex}`;
                        return (
                          <TVFocusablePressable
                            key={keyFor(posterKey)}
                            ref={(el) => {
                              setItemRef(posterKey, el);
                              if (pIndex === 0 && el) {
                                // First poster of this provider's row sits
                                // at the screen's left edge -- register
                                // eagerly on mount (race-free) since these
                                // rows can re-render/reorder as results
                                // stream in.
                                registerRailLeftEdge('search', el);
                              }
                            }}
                            hasTVPreferredFocus={shouldPreferFocus(posterKey, false)}
                            scaleFocused={1.08}
                            focusedBorderColor="#8A5CF6"
                            borderRadius={10}
                            onFocus={() => {
                              lastFocusedSearchKey = posterKey;
                              setActiveHero({
                                title: item.title,
                                backdropUrl: item.image,
                                overview: item.extra || 'Select to browse stream links and episodes.',
                                sourceName: group.providerName,
                              });
                            }}
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
                                <View style={styles.cardTopSourceBadge}>
                                  <Text numberOfLines={1} style={styles.cardTopSourceText}>
                                    {group.providerName}
                                  </Text>
                                </View>
                                {focused && <View style={styles.cardGlow} />}
                                <View style={styles.cardLabelBottom}>
                                  <Text numberOfLines={1} style={styles.cardLabelText}>
                                    {item.title}
                                  </Text>
                                </View>
                              </View>
                            )}
                          </TVFocusablePressable>
                        );
                      })}
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
    // Trimmed from 96 -- see TVDiscoverScreen.tsx's CONTAINER_PADDING_LEFT
    // comment for why.
    paddingLeft: 20,
    paddingRight: 48,
    paddingTop: 36,
    paddingBottom: 60,
  },
  heroMetaWrapper: {
    maxWidth: 680,
    marginBottom: 20,
  },
  heroHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 6,
  },
  heroTitle: {
    color: '#FFFFFF',
    fontSize: 32,
    fontWeight: '800',
    letterSpacing: 0.4,
    textShadowColor: 'rgba(0,0,0,0.9)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 6,
  },
  sourceBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#8A5CF6',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  sourceBadgeText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
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
    paddingHorizontal: 16,
    backgroundColor: '#16161E',
    borderRadius: 14,
    borderWidth: 2,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  searchBarWrapperFocused: {
    borderColor: '#8A5CF6',
    transform: [{ scale: 1.02 }],
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
  clearBtnHidden: {
    opacity: 0,
  },
  suggestionsPanel: {
    maxWidth: 820,
    marginTop: -12,
    marginBottom: 24,
    padding: 6,
    backgroundColor: '#16161E',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  suggestionRow: {
    backgroundColor: 'transparent',
  },
  suggestionInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  suggestionTitle: {
    flex: 1,
    color: '#D1D5DB',
    fontSize: 15,
    fontWeight: '600',
  },
  suggestionTitleFocused: {
    color: '#FFFFFF',
  },
  suggestionMeta: {
    color: '#6B7280',
    fontSize: 12,
    fontWeight: '600',
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
  sectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
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
  cardTopSourceBadge: {
    position: 'absolute',
    top: 6,
    left: 6,
    backgroundColor: 'rgba(10, 10, 14, 0.85)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  cardTopSourceText: {
    color: '#D1D5DB',
    fontSize: 10,
    fontWeight: '700',
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
