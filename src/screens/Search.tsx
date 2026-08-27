import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  ScrollView,
  Image,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { TVFocusablePressable } from '../components/tv/TVFocusablePressable';
import { TVHeroMeta, TVHeroMedia } from '../components/tv/TVHeroMeta';
import { providerManager } from '../lib/services/ProviderManager';
import useContentStore from '../lib/zustand/contentStore';
import debounce from 'lodash/debounce';

interface TVSearchProps {
  onSelectItem?: (item: any) => void;
}

export const TVSearch: React.FC<TVSearchProps> = ({ onSelectItem }) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeHero, setActiveHero] = useState<TVHeroMedia | null>(null);

  const provider = useContentStore((state) => state.provider);
  const installedProviders = useContentStore((state) => state.installedProviders);
  const abortControllerRef = useRef<AbortController | null>(null);

  const searchAcrossProviders = async (searchQuery: string) => {
    if (!searchQuery.trim() || searchQuery.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    setLoading(true);
    try {
      // Use active provider or fallback across all installed providers
      const providerValue = provider?.value || installedProviders[0]?.value;
      if (!providerValue) {
        setLoading(false);
        return;
      }

      const posts = await providerManager.getSearchPosts({
        searchQuery,
        page: 1,
        providerValue,
        signal: abortControllerRef.current.signal,
      });

      if (posts && Array.isArray(posts)) {
        setResults(posts);
        if (posts.length > 0) {
          setActiveHero({
            title: posts[0].title,
            backdropUrl: posts[0].image,
            posterUrl: posts[0].image,
            overview: posts[0].overview || 'Select to browse streams.',
          });
        }
      }
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        console.error('Search error:', err);
      }
    } finally {
      setLoading(false);
    }
  };

  const debouncedSearch = useRef(
    debounce((text: string) => searchAcrossProviders(text), 400)
  ).current;

  useEffect(() => {
    debouncedSearch(query);
    return () => debouncedSearch.cancel();
  }, [query]);

  return (
    <View style={styles.container}>
      {/* Top Dynamic Fanart Header for focused result */}
      <TVHeroMeta media={activeHero} />

      {/* D-Pad Focusable Search Input Field */}
      <View style={styles.searchBarWrapper}>
        <TVFocusablePressable
          hasTVPreferredFocus={true}
          scaleFocused={1.02}
          focusedBorderColor="#8A5CF6"
          borderRadius={12}
          style={styles.inputContainer}
        >
          {({ focused }) => (
            <View style={styles.inputRow}>
              <MaterialCommunityIcons
                name="magnify"
                size={24}
                color={focused ? '#8A5CF6' : '#9CA3AF'}
              />
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="Search movies, series, anime..."
                placeholderTextColor="#6B7280"
                style={styles.input}
              />
              {loading && <ActivityIndicator size="small" color="#8A5CF6" />}
            </View>
          )}
        </TVFocusablePressable>
      </View>

      {/* Grid of Results directly on the same screen */}
      <ScrollView
        contentContainerStyle={styles.resultsGrid}
        showsVerticalScrollIndicator={false}
      >
        {results.map((item, index) => (
          <TVFocusablePressable
            key={item.id || item.link || index}
            scaleFocused={1.08}
            focusedBorderColor="#8A5CF6"
            borderRadius={8}
            onFocus={() =>
              setActiveHero({
                title: item.title,
                backdropUrl: item.image,
                posterUrl: item.image,
                overview: item.overview || 'Press select to load playback sources.',
              })
            }
            onPress={() => onSelectItem?.(item)}
            style={styles.card}
          >
            {({ focused }) => (
              <View style={styles.cardInner}>
                <Image
                  source={{
                    uri:
                      item.image ||
                      'https://placehold.jp/24/363636/ffffff/100x150.png?text=Vega',
                  }}
                  style={styles.cardPoster}
                  resizeMode="cover"
                />
                {focused && (
                  <View style={styles.cardBadge}>
                    <Text numberOfLines={1} style={styles.cardTitle}>
                      {item.title}
                    </Text>
                  </View>
                )}
              </View>
            )}
          </TVFocusablePressable>
        ))}

        {!loading && results.length === 0 && query.length >= 2 && (
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>No results found for "{query}"</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
};

export default TVSearch;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0E',
  },
  searchBarWrapper: {
    paddingLeft: 96,
    paddingRight: 48,
    marginBottom: 16,
    zIndex: 20,
  },
  inputContainer: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  input: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '500',
  },
  resultsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingLeft: 96,
    paddingRight: 48,
    paddingBottom: 40,
    gap: 16,
  },
  card: {
    width: 140,
    height: 210,
  },
  cardInner: {
    flex: 1,
    position: 'relative',
  },
  cardPoster: {
    width: '100%',
    height: '100%',
    borderRadius: 8,
  },
  cardBadge: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(0,0,0,0.85)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderBottomLeftRadius: 8,
    borderBottomRightRadius: 8,
  },
  cardTitle: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '600',
  },
  emptyState: {
    width: '100%',
    paddingVertical: 40,
    alignItems: 'center',
  },
  emptyText: {
    color: '#9CA3AF',
    fontSize: 16,
  },
});
