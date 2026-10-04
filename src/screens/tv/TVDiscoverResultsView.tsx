import React, { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  Image,
  ActivityIndicator,
  Modal,
} from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { TVFocusablePressable } from '../../components/tv/TVFocusablePressable';
import { registerRailLeftEdge } from '../../lib/tv/registerRailLeftEdge';
import { useTVEntryFocus } from '../../lib/tv/useTVEntryFocus';
import type { useReadingOrderFocus } from '../../lib/tv/useReadingOrderFocus';
import { Post, Info, Link, EpisodeLink } from '../../lib/providers/types';
import { CatalogMediaItem, DiscoverCatalog } from '../../lib/services/stremioCatalog';
import { findCinemetaEpisode, formatEpisodeReleaseDate, CinemetaMeta } from '../../lib/services/cinemetaService';
import { parseSeasonNumber, parseEpisodeNumber, formatEpisodeLabel } from '../../lib/utils/episodeParsing';
import { getFileSizeLabel, stripFileSize } from '../../lib/utils/fileSize';
import { styles, SCREEN_WIDTH, SCREEN_HEIGHT, isQualityExcluded, DiscoverResumeHint } from './TVDiscoverScreen';

// The "page 2" of TVDiscoverScreen: season/quality picker, episode/source
// list, and playback resolution for one tapped catalog item. Split out of
// TVDiscoverScreen.tsx (which now handles only "page 1" -- catalog pills,
// hero, posters grid) because the two pages share almost no state and
// editing either one no longer means scrolling through the other's ~2,700
// lines to find the right scope. TVDiscoverScreen renders this in place of
// its own JSX whenever `screenMode === 'results'`.
//
// This is a render-only extraction, not a rewrite: every prop below is a
// value, ref, or callback that already existed in TVDiscoverScreen, passed
// through unchanged -- including `chain`. It's tempting to give this page
// its own `useReadingOrderFocus()` instance instead of receiving one, since
// page 1 never reads from it -- but page 1's `setItemRef` (also shared,
// also passed straight through) calls `chain.register()` for every
// `results:`-prefixed key regardless of which page is showing, so the
// instance that registers rows and the instance this page reads
// (`chain.propsFor`/`chain.beginRender`) have to be the same object.
//
// `shouldPreferResultsFocus`, `noteResultsFocus` and `onResultsScroll` stay
// defined in TVDiscoverScreen -- they're the only things that read or write
// the module-level `lastFocusedDiscoverResultsKey` / `lastResultsScrollY`,
// so keeping them there means this file never touches those variables
// directly. Likewise `onSelectLink` wraps the one spot that mutates
// `savedDiscoverState`.
export interface TVDiscoverResultsViewProps {
  resultsTarget: (CatalogMediaItem & { logo?: string; cast?: string[]; runtime?: string }) | null;
  selectedCatalog?: DiscoverCatalog | null;
  resultsLoading: boolean;
  matchedAddonPosts: Post[];
  activeSourcePost: Post | null;
  sourceInfo: Info | null;
  loadingSourceInfo: boolean;
  activeLinkIndex: number;
  episodes: EpisodeLink[];
  episodesLoading: boolean;
  sourceCinemetaMeta: CinemetaMeta | null;
  extractingLink: boolean;
  resumeHint: DiscoverResumeHint | null;
  excludedQualities: string[];
  resultsScrollRef: React.RefObject<ScrollView | null>;
  sourcesRowFirstRef: React.RefObject<View | null>;

  // Focus plumbing owned by the parent (see file comment above).
  chain: ReturnType<typeof useReadingOrderFocus>;
  keyFor: ReturnType<typeof useTVEntryFocus>['keyFor'];
  setItemRef: ReturnType<typeof useTVEntryFocus>['setItemRef'];
  shouldPreferResultsFocus: (key: string, defaultValue: boolean) => boolean;
  noteResultsFocus: (key: string, keepResumePending?: boolean) => void;
  onResultsScroll: (e: any) => void;
  handleResultsContentSizeChange: () => void;

  // Actions.
  onSelectLink: (idx: number) => void;
  backToBrowse: () => void;
  handleSelectSourceCard: (sourcePost: Post) => void | Promise<void>;
  handleResolveAndPlay: (
    link: string,
    title: string,
    type: string,
    episodeIdx?: number,
    customEpisodes?: EpisodeLink[],
    episodeKey?: string,
  ) => void | Promise<void>;
}

export const TVDiscoverResultsView: React.FC<TVDiscoverResultsViewProps> = ({
  resultsTarget,
  selectedCatalog,
  resultsLoading,
  matchedAddonPosts,
  activeSourcePost,
  sourceInfo,
  loadingSourceInfo,
  activeLinkIndex,
  chain,
  episodes,
  episodesLoading,
  sourceCinemetaMeta,
  extractingLink,
  resumeHint,
  excludedQualities,
  resultsScrollRef,
  sourcesRowFirstRef,
  keyFor,
  setItemRef,
  shouldPreferResultsFocus,
  noteResultsFocus,
  onResultsScroll,
  handleResultsContentSizeChange,
  onSelectLink,
  backToBrowse,
  handleSelectSourceCard,
  handleResolveAndPlay,
}) => {
  // Controls the season/quality picker popup -- purely local to this page,
  // nothing outside it reads this.
  const [seasonPickerVisible, setSeasonPickerVisible] = useState(false);

  const banner = resultsTarget?.banner || resultsTarget?.poster;
  const rawLinkList: Link[] = sourceInfo?.linkList || [];
  const linkList = rawLinkList.filter(
    (l) =>
      !isQualityExcluded(l?.quality, excludedQualities) &&
      !isQualityExcluded(l?.title, excludedQualities),
  );
  const usableLinkList = linkList.length > 0 ? linkList : rawLinkList;
  const activeLink = usableLinkList[activeLinkIndex] || usableLinkList[0];

  const rawDirectItems = activeLink?.directLinks || [];
  const directItems = rawDirectItems.filter(
    (d) =>
      !isQualityExcluded(d?.title, excludedQualities) &&
      !isQualityExcluded((d as any)?.quality, excludedQualities),
  );
  const usableDirectItems = directItems.length > 0 ? directItems : rawDirectItems;

  const isSeries =
    Boolean(activeLink?.episodesLink) ||
    resultsTarget?.type === 'series' ||
    sourceInfo?.type === 'series' ||
    sourceInfo?.type === 'tv' ||
    selectedCatalog?.type === 'series' ||
    episodes.length > 0 ||
    Boolean(usableDirectItems.length > 0 && usableDirectItems.some((d) => d.type === 'series')) ||
    Boolean(usableDirectItems.length > 1 && resultsTarget?.type !== 'movie');

  const isAwaitingEpisodes = isSeries && episodesLoading && episodes.length === 0;
  const logoUrl = resultsTarget?.logo || (sourceCinemetaMeta as any)?.logo;

  // Reading-order Left/Right chain: reset at the top of every results
  // render; each focusable below adds itself, in visual order, via
  // `chain.propsFor(key)`.
  chain.beginRender();


  return (
    <View style={styles.resultsRoot}>
      <View style={styles.resultsBackdropLayer} pointerEvents="none">
        {banner ? (
          <Image source={{ uri: banner }} style={styles.resultsBackdropImage} resizeMode="cover" />
        ) : null}
        <LinearGradient
          colors={['rgba(10, 10, 14, 0.4)', 'rgba(10, 10, 14, 0.4)', 'transparent']}
          locations={[0, 0.42, 0.85]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={styles.resultsLeftGradient}
        />
        <LinearGradient
          colors={['transparent', 'rgba(10, 10, 14, 0.4)', 'rgba(10, 10, 14, 0.4)']}
          locations={[0.2, 0.65, 1]}
          style={styles.resultsBottomGradient}
        />
      </View>

      <ScrollView
        ref={resultsScrollRef}
        style={styles.resultsScrollView}
        contentContainerStyle={styles.resultsScrollContent}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={onResultsScroll}
        onContentSizeChange={handleResultsContentSizeChange}
        // Clipping is OFF on purpose. With it on, every row scrolled out of
        // view is detached from the window, which broke two things here:
        //  1. Coming back from the player, the episode/button the person
        //     left off on (usually below the fold) had no attached view to
        //     take focus, so Android fell back to the first focusable (the
        //     Back button) and the page jumped to the top.
        //  2. The Left/Right reading-order links (useReadingOrderFocus) are
        //     explicit next-focus ids, which only resolve to attached views.
        // The old reason for keeping it on (winning a focus race against
        // the nav rail while this screen mounted) is gone: the rail is
        // hidden while page 2 is showing.
        removeClippedSubviews={false}
      >
        <TVFocusablePressable
          key={keyFor('results:back')}
          ref={(el) => setItemRef('results:back', el)}
          {...chain.propsFor('results:back')}
          hasTVPreferredFocus={shouldPreferResultsFocus('results:back', true)}
          onFocus={() => {
            noteResultsFocus('results:back');
          }}
          scaleFocused={1.04}
          focusedBorderColor="#8A5CF6"
          borderRadius={8}
          onPress={backToBrowse}
          style={styles.backBtn}
        >
          {() => (
            <View style={styles.backBtnInner}>
              <MaterialCommunityIcons name="arrow-left" size={18} color="#FFFFFF" />
              <Text style={styles.backBtnText}>
                {activeSourcePost ? 'Back to Sources' : 'Back to Discover'}
              </Text>
            </View>
          )}
        </TVFocusablePressable>

        <View style={styles.cleanHeaderContainer}>
          {logoUrl ? (
            <Image
              source={{ uri: logoUrl }}
              style={styles.targetLogo}
              resizeMode="contain"
            />
          ) : (
            <Text style={styles.targetTitle}>{resultsTarget?.title}</Text>
          )}

          <View style={styles.metaRow}>
            {resultsTarget?.rating ? (
              <View style={styles.ratingBadge}>
                <Text style={styles.ratingText}>★ {resultsTarget.rating}</Text>
              </View>
            ) : null}
            {resultsTarget?.runtime ? (
              <Text style={styles.targetMetaText}>{resultsTarget.runtime}</Text>
            ) : null}
            {resultsTarget?.year ? <Text style={styles.targetMetaText}>{resultsTarget.year}</Text> : null}
            {resultsTarget?.genres && resultsTarget.genres.length > 0 ? (
              <Text style={styles.targetGenreText}>{resultsTarget.genres.join(' • ')}</Text>
            ) : null}
          </View>
          <Text numberOfLines={5} style={styles.targetOverview}>
            {resultsTarget?.overview || 'Select a matched addon source below to view stream links.'}
          </Text>
          {resultsTarget?.cast && resultsTarget.cast.length > 0 ? (
            <Text numberOfLines={1} style={styles.targetCastText}>
              <Text style={styles.targetCastLabel}>Cast: </Text>
              {resultsTarget.cast.slice(0, 3).join(', ')}
            </Text>
          ) : null}
        </View>

        <View style={styles.sectionContainer}>
          <Text style={styles.sectionHeader}>Matching Addon Sources</Text>
          {matchedAddonPosts.length === 0 ? (
            resultsLoading ? (
              <View style={styles.loadingRow}>
                <ActivityIndicator size="small" color="#8A5CF6" />
                <Text style={styles.loadingText}>Searching installed addons for exact matches...</Text>
              </View>
            ) : (
              <Text style={styles.emptySubtitle}>No matching releases found in your installed addons.</Text>
            )
          ) : (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.sourcesRow}
              scrollEventThrottle={16}
            >
              {matchedAddonPosts.map((post, idx) => {
                const isSelected = activeSourcePost?.link === post.link;
                const isFirst = idx === 0;
                const sourceKey = `results:source:${post.link}:${idx}`;
                const isResumeSource =
                  !!resumeHint &&
                  ((resumeHint.infoUrl && post.link === resumeHint.infoUrl) ||
                    (!resumeHint.infoUrl && resumeHint.providerValue === post.provider));
                return (
                  <TVFocusablePressable
                    key={keyFor(sourceKey)}
                    ref={(el) => {
                      setItemRef(sourceKey, el);
                      if (isFirst) sourcesRowFirstRef.current = el;
                    }}
                    {...chain.propsFor(sourceKey)}
                    hasTVPreferredFocus={
                      resumeHint
                        ? shouldPreferResultsFocus(sourceKey, isResumeSource)
                        : shouldPreferResultsFocus(sourceKey, false)
                    }
                    scaleFocused={1.04}
                    focusedBorderColor="#8A5CF6"
                    borderRadius={10}
                    onFocus={() => {
                      noteResultsFocus(sourceKey, isResumeSource);
                      if (isFirst) registerRailLeftEdge('discover', sourcesRowFirstRef.current);
                    }}
                    onPress={() => handleSelectSourceCard(post)}
                    style={[styles.sourceCard, isSelected && styles.sourceCardActive]}
                  >
                    {({ focused }) => (
                      <View style={styles.sourceCardInner}>
                        <Image
                          source={{
                            uri: post.image || resultsTarget?.poster || 'https://placehold.jp/24/363636/ffffff/200x300.png?text=Vega',
                          }}
                          style={styles.sourcePoster}
                          resizeMode="cover"
                        />
                        {isResumeSource && (
                          <View style={styles.sourceResumeBadge}>
                            <Text style={styles.sourceResumeBadgeText}>Resume</Text>
                          </View>
                        )}
                        <View style={styles.sourceBadge}>
                          <Text numberOfLines={1} style={styles.sourceBadgeText}>
                            {post.provider}
                          </Text>
                        </View>
                        {focused && <View style={styles.focusBorderGlow} />}
                      </View>
                    )}
                  </TVFocusablePressable>
                );
              })}
              {resultsLoading ? (
                // Still searching the remaining addons -- more cards will
                // be appended after these as they are confirmed.
                <View style={styles.sourcesLoadingTail}>
                  <ActivityIndicator size="small" color="#8A5CF6" />
                </View>
              ) : null}
            </ScrollView>
          )}
        </View>

        {activeSourcePost && (
          <View style={styles.sectionContainer}>
            <Text style={styles.sectionHeader}>
              Episodes & Streams ({activeSourcePost.provider})
            </Text>

            {loadingSourceInfo || extractingLink || isAwaitingEpisodes ? (
              <View style={styles.loadingRow}>
                <ActivityIndicator size="small" color="#8A5CF6" />
                <Text style={styles.loadingText}>
                  {extractingLink
                    ? 'Extracting stream link...'
                    : loadingSourceInfo
                    ? 'Loading media details...'
                    : 'Loading episodes...'}
                </Text>
              </View>
            ) : !sourceInfo ? (
              <Text style={styles.emptySubtitle}>
                Could not load details from this source. Try another source above.
              </Text>
            ) : (
              <View style={styles.pickerSection}>
                {usableLinkList.length > 1 &&
                  (!isSeries ||
                    usableLinkList.some((l) => Boolean(l.episodesLink)) ||
                    parseSeasonNumber(usableLinkList[0]?.title) !== null) && (
                  <View style={styles.subBlock}>
                    <Text style={styles.subHeader}>Seasons &amp; Quality</Text>
                    {/* Single trigger button that opens the season/quality
                        picker popup below -- same picker TVDetailsScreen
                        uses, rather than an inline (and, with many
                        options, multi-row) chip list. One reading-order
                        stop here regardless of how many options exist. */}
                    <TVFocusablePressable
                      key={keyFor('results:linkPicker')}
                      ref={(el) => setItemRef('results:linkPicker', el)}
                      {...chain.propsFor('results:linkPicker')}
                      hasTVPreferredFocus={shouldPreferResultsFocus('results:linkPicker', false)}
                      onFocus={() => {
                        noteResultsFocus('results:linkPicker');
                      }}
                      scaleFocused={1.03}
                      focusedBorderColor="#8A5CF6"
                      borderRadius={10}
                      onPress={() => setSeasonPickerVisible(true)}
                      style={styles.seasonPickerBtn}
                    >
                      {() => (
                        <View style={styles.seasonPickerBtnInner}>
                          <MaterialCommunityIcons name="playlist-play" size={18} color="#FFFFFF" />
                          <Text style={styles.seasonPickerBtnText}>
                            {activeLink?.title || 'Select'}
                            {activeLink?.quality ? ` • ${activeLink.quality}` : ''}
                          </Text>
                          <MaterialCommunityIcons name="chevron-down" size={20} color="#C4B5FD" />
                        </View>
                      )}
                    </TVFocusablePressable>
                  </View>
                )}

                {isSeries ? (
                  episodesLoading ? (
                    <View style={styles.loadingRow}>
                      <ActivityIndicator size="small" color="#8A5CF6" />
                      <Text style={styles.loadingText}>Loading episodes...</Text>
                    </View>
                  ) : episodes.length > 0 ? (
                    <View style={styles.subBlock}>
                      <Text style={styles.subHeader}>Episodes</Text>
                      <View style={styles.episodesGrid}>
                        {episodes.map((ep, idx) => {
                          // Prefer the season parsed from the episode's
                          // own title (a flattened "every season in one
                          // list" provider gives each episode its own
                          // "S01 E01" / "S02 E01" title) over the
                          // tab-level guess -- otherwise every episode
                          // collapses onto the same season number and two
                          // different episodes can render the exact same
                          // "S01E01" label.
                          const seasonNum =
                            parseSeasonNumber(ep.title) ?? parseSeasonNumber(activeLink?.title) ?? activeLinkIndex + 1;
                          const episodeNum = parseEpisodeNumber(ep.title) ?? idx + 1;
                          const cinemetaEp = findCinemetaEpisode(
                            sourceCinemetaMeta,
                            seasonNum,
                            episodeNum,
                          );
                          // Cinemeta's per-episode `thumbnail` is the
                          // actual still for that episode; many addon
                          // providers -- especially ones with no TMDB/
                          // IMDb id to key off of -- only ever return the
                          // show's own poster as `ep.image` for every
                          // episode. Prefer the real Cinemeta still when
                          // we have one and only fall back to the
                          // provider's image if Cinemeta has nothing for
                          // this episode.
                          const episodeThumb = cinemetaEp?.thumbnail || ep.image;
                          const episodeOverview = ep.description || cinemetaEp?.overview;
                          const episodeReleaseDate = formatEpisodeReleaseDate(cinemetaEp?.released);
                          // Same "GB/MB baked into the title" extraction
                          // TVDetailsScreen uses, so a provider that
                          // mentions file size sees the same badge here.
                          const sizeLabel = getFileSizeLabel(ep);
                          const displayTitle = sizeLabel ? stripFileSize(ep.title) || ep.title : ep.title;
                          const episodeKey = `results:ep:${ep.link || idx}`;
                          // Stable per-episode identity (matches the
                          // `episodeKey` format ContinueWatchingItem and
                          // TVDetailsScreen use) -- passed through to
                          // handleResolveAndPlay as its own `episodeKey`
                          // resume-matching parameter, distinct from the
                          // `episodeKey` above which is only this card's
                          // UI focus-tracking key. Raw provider links
                          // aren't reliable for this (they can differ
                          // across quality picks or separate fetches),
                          // but the parsed season/episode numbers are.
                          const stableEpisodeKey = `S${seasonNum}E${episodeNum}`;
                          const isResumeTarget = resumeHint?.episodeKey
                            ? resumeHint.episodeKey === stableEpisodeKey
                            : !!resumeHint?.episodeLink && ep.link === resumeHint.episodeLink;
                          return (
                            <TVFocusablePressable
                              key={keyFor(episodeKey)}
                              ref={(el) => setItemRef(episodeKey, el)}
                              {...chain.propsFor(episodeKey)}
                              hasTVPreferredFocus={
                                resumeHint?.episodeKey || resumeHint?.episodeLink
                                  ? shouldPreferResultsFocus(episodeKey, isResumeTarget)
                                  : shouldPreferResultsFocus(episodeKey, false)
                              }
                              onFocus={() => {
                                noteResultsFocus(episodeKey);
                              }}
                              scaleFocused={1.02}
                              focusedBorderColor="#8A5CF6"
                              borderRadius={8}
                              onPress={() =>
                                handleResolveAndPlay(
                                  ep.link,
                                  sourceInfo?.title ||
                                    activeSourcePost?.title ||
                                    resultsTarget?.title ||
                                    ep.title ||
                                    `Episode ${idx + 1}`,
                                  'series',
                                  idx,
                                  episodes,
                                  stableEpisodeKey,
                                )
                              }
                              style={styles.episodeCard}
                            >
                              {() => (
                                <View style={styles.episodeInner}>
                                  {episodeThumb ? (
                                    <View style={styles.episodeThumbWrap}>
                                      <Image
                                        source={{ uri: episodeThumb }}
                                        style={styles.episodeThumb}
                                        resizeMode="cover"
                                      />
                                      <View style={styles.episodeThumbPlayOverlay}>
                                        <MaterialCommunityIcons name="play" size={16} color="#FFFFFF" />
                                      </View>
                                    </View>
                                  ) : (
                                    <MaterialCommunityIcons name="play-circle-outline" size={22} color="#8A5CF6" />
                                  )}
                                  <View style={styles.episodeTextWrap}>
                                    <Text numberOfLines={1} style={styles.episodeText}>
                                      {formatEpisodeLabel(
                                        seasonNum,
                                        episodeNum,
                                        cinemetaEp?.name || cinemetaEp?.title || displayTitle,
                                        `Episode ${idx + 1}`
                                      )}
                                    </Text>
                                    {!!episodeReleaseDate && (
                                      <Text numberOfLines={1} style={styles.episodeReleaseText}>
                                        {episodeReleaseDate}
                                      </Text>
                                    )}
                                    {!!episodeOverview && (
                                      <Text numberOfLines={2} style={styles.episodeOverviewText}>
                                        {episodeOverview}
                                      </Text>
                                    )}
                                  </View>
                                  {!!sizeLabel && (
                                    <View style={styles.sizeBadge}>
                                      <Text style={styles.sizeBadgeText}>{sizeLabel}</Text>
                                    </View>
                                  )}
                                  {isResumeTarget && resumeHint?.position ? (
                                    <Text style={styles.resumeBadge}>
                                      Resume {Math.floor(resumeHint.position / 60)}:
                                      {String(Math.floor(resumeHint.position % 60)).padStart(2, '0')}
                                    </Text>
                                  ) : null}
                                </View>
                              )}
                            </TVFocusablePressable>
                          );
                        })}
                      </View>
                    </View>
                  ) : usableDirectItems.length > 0 ? (
                    // No dedicated `episodesLink` for this season -- the
                    // provider only gave a flat `directLinks` list (e.g. a
                    // season whose only episode released so far is
                    // S02E01). Render those exactly like real episodes
                    // instead of falling through to "No episodes found",
                    // matching TVDetailsScreen's equivalent fallback.
                    <View style={styles.subBlock}>
                      <Text style={styles.subHeader}>Episodes</Text>
                      <View style={styles.episodesGrid}>
                        {usableDirectItems.map((d, idx) => {
                          const seasonNum =
                            parseSeasonNumber(d.title) ?? parseSeasonNumber(activeLink?.title) ?? activeLinkIndex + 1;
                          const episodeNum = parseEpisodeNumber(d.title) ?? idx + 1;
                          const cinemetaEp = findCinemetaEpisode(
                            sourceCinemetaMeta,
                            seasonNum,
                            episodeNum,
                          );
                          const episodeThumb = cinemetaEp?.thumbnail || d.image;
                          const episodeOverview = d.description || cinemetaEp?.overview;
                          const episodeReleaseDate = formatEpisodeReleaseDate(cinemetaEp?.released);
                          const sizeLabel = getFileSizeLabel(d);
                          const displayTitle = sizeLabel ? stripFileSize(d.title) || d.title : d.title;
                          const episodeKey = `results:direct-ep:${d.link || idx}`;
                          const stableEpisodeKey = `S${seasonNum}E${episodeNum}`;
                          const isResumeTarget = resumeHint?.episodeKey
                            ? resumeHint.episodeKey === stableEpisodeKey
                            : !!resumeHint?.episodeLink && d.link === resumeHint.episodeLink;
                          const episodesForPlayer: EpisodeLink[] = usableDirectItems.map((item, i) => ({
                            title: item.title || `Episode ${i + 1}`,
                            link: item.link,
                            image: item.image,
                            description: item.description,
                            skip: item.skip,
                          }));
                          return (
                            <TVFocusablePressable
                              key={keyFor(episodeKey)}
                              ref={(el) => setItemRef(episodeKey, el)}
                              {...chain.propsFor(episodeKey)}
                              hasTVPreferredFocus={
                                resumeHint?.episodeKey || resumeHint?.episodeLink
                                  ? shouldPreferResultsFocus(episodeKey, isResumeTarget)
                                  : shouldPreferResultsFocus(episodeKey, false)
                              }
                              onFocus={() => {
                                noteResultsFocus(episodeKey);
                              }}
                              scaleFocused={1.02}
                              focusedBorderColor="#8A5CF6"
                              borderRadius={8}
                              onPress={() =>
                                handleResolveAndPlay(
                                  d.link,
                                  sourceInfo?.title ||
                                    activeSourcePost?.title ||
                                    resultsTarget?.title ||
                                    d.title ||
                                    `Episode ${idx + 1}`,
                                  'series',
                                  idx,
                                  episodesForPlayer,
                                  stableEpisodeKey,
                                )
                              }
                              style={styles.episodeCard}
                            >
                              {() => (
                                <View style={styles.episodeInner}>
                                  {episodeThumb ? (
                                    <View style={styles.episodeThumbWrap}>
                                      <Image
                                        source={{ uri: episodeThumb }}
                                        style={styles.episodeThumb}
                                        resizeMode="cover"
                                      />
                                      <View style={styles.episodeThumbPlayOverlay}>
                                        <MaterialCommunityIcons name="play" size={16} color="#FFFFFF" />
                                      </View>
                                    </View>
                                  ) : (
                                    <MaterialCommunityIcons name="play-circle-outline" size={22} color="#8A5CF6" />
                                  )}
                                  <View style={styles.episodeTextWrap}>
                                    <Text numberOfLines={1} style={styles.episodeText}>
                                      {formatEpisodeLabel(
                                        seasonNum,
                                        episodeNum,
                                        cinemetaEp?.name || cinemetaEp?.title || displayTitle,
                                        `Episode ${idx + 1}`
                                      )}
                                    </Text>
                                    {!!episodeReleaseDate && (
                                      <Text numberOfLines={1} style={styles.episodeReleaseText}>
                                        {episodeReleaseDate}
                                      </Text>
                                    )}
                                    {!!episodeOverview && (
                                      <Text numberOfLines={2} style={styles.episodeOverviewText}>
                                        {episodeOverview}
                                      </Text>
                                    )}
                                  </View>
                                  {!!sizeLabel && (
                                    <View style={styles.sizeBadge}>
                                      <Text style={styles.sizeBadgeText}>{sizeLabel}</Text>
                                    </View>
                                  )}
                                  {isResumeTarget && resumeHint?.position ? (
                                    <Text style={styles.resumeBadge}>
                                      Resume {Math.floor(resumeHint.position / 60)}:
                                      {String(Math.floor(resumeHint.position % 60)).padStart(2, '0')}
                                    </Text>
                                  ) : null}
                                </View>
                              )}
                            </TVFocusablePressable>
                          );
                        })}
                      </View>
                    </View>
                  ) : (
                    <Text style={styles.emptySubtitle}>No episodes found for this season.</Text>
                  )
                ) : usableDirectItems.length > 1 ? (
                  <View style={styles.subBlock}>
                    <Text style={styles.subHeader}>Play</Text>
                    <View style={styles.chipsRow}>
                      {usableDirectItems.map((d, idx) => (
                        <TVFocusablePressable
                          key={keyFor(`results:direct:${idx}`)}
                          ref={(el) => setItemRef(`results:direct:${idx}`, el)}
                          {...chain.propsFor(`results:direct:${idx}`)}
                          hasTVPreferredFocus={shouldPreferResultsFocus(`results:direct:${idx}`, false)}
                          onFocus={() => {
                            noteResultsFocus(`results:direct:${idx}`);
                          }}
                          scaleFocused={1.04}
                          focusedBorderColor="#FFFFFF"
                          borderRadius={8}
                          onPress={() =>
                            handleResolveAndPlay(
                              d.link,
                              activeSourcePost?.title || resultsTarget?.title || d.title,
                              d.type || (isSeries ? 'series' : 'movie'),
                              idx,
                              isSeries && usableDirectItems.length > 0
                                ? usableDirectItems.map((item, i) => ({
                                    title: item.title || `Episode ${i + 1}`,
                                    link: item.link,
                                    image: item.image,
                                    description: item.description,
                                    skip: item.skip,
                                  }))
                                : undefined,
                              activeSourcePost?.link,
                            )
                          }
                          style={styles.qualityChip}
                        >
                          {() => (
                            <View style={styles.chipInner}>
                              <MaterialCommunityIcons name="quality-high" size={16} color="#8A5CF6" />
                              <Text style={styles.chipText}>{d.title || `Source ${idx + 1}`}</Text>
                            </View>
                          )}
                        </TVFocusablePressable>
                      ))}
                    </View>
                  </View>
                ) : (
                  (() => {
                    // A movie CW entry has no episodeKey/episodeLink to
                    // disambiguate (see ContinueWatchingItem) -- their
                    // absence alongside a saved position is exactly what
                    // marks this resumeHint as belonging to this single
                    // movie stream, same as TVDetailsScreen's "Resume
                    // Movie / Stream" button label.
                    const isMovieResume =
                      !!resumeHint &&
                      !resumeHint.episodeKey &&
                      !resumeHint.episodeLink &&
                      !!resumeHint.position;
                    // A single direct link (one server/quality) is still
                    // the real target to play -- fall back to the source
                    // post's own link only when the provider gave no
                    // direct link at all.
                    const singleDirect = usableDirectItems[0];
                    const playLink = singleDirect?.link || activeSourcePost?.link;
                    const playType = singleDirect?.type || 'movie';
                    return (
                      <TVFocusablePressable
                        key={keyFor('results:direct-stream-btn')}
                        ref={(el) => setItemRef('results:direct-stream-btn', el)}
                        {...chain.propsFor('results:direct-stream-btn')}
                        hasTVPreferredFocus={
                          resumeHint
                            ? shouldPreferResultsFocus('results:direct-stream-btn', isMovieResume)
                            : shouldPreferResultsFocus('results:direct-stream-btn', false)
                        }
                        onFocus={() => {
                          noteResultsFocus('results:direct-stream-btn');
                        }}
                        scaleFocused={1.06}
                        focusedBorderColor="#FFFFFF"
                        borderRadius={14}
                        onPress={() =>
                          playLink &&
                          handleResolveAndPlay(
                            playLink,
                            activeSourcePost?.title || resultsTarget?.title || singleDirect?.title,
                            playType,
                            0,
                            undefined,
                            activeSourcePost?.link,
                          )
                        }
                        style={styles.directStreamBtn}
                      >
                        {() => (
                          <View style={styles.directBtnInner}>
                            <MaterialCommunityIcons name="play" size={26} color="#FFFFFF" />
                            <Text style={styles.directBtnText}>
                              {isMovieResume
                                ? `Resume ${Math.floor((resumeHint!.position || 0) / 60)}:${String(
                                    Math.floor((resumeHint!.position || 0) % 60),
                                  ).padStart(2, '0')}`
                                : 'Play Movie / Stream'}
                            </Text>
                          </View>
                        )}
                      </TVFocusablePressable>
                    );
                  })()
                )}
              </View>
            )}
          </View>
        )}
      </ScrollView>

      <Modal
        visible={seasonPickerVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setSeasonPickerVisible(false)}
      >
        <View style={styles.pickerOverlay}>
          {/* Shrink-wraps its content (so a short list gets a compact card,
              a long label a wider one) up to 70% of the screen; beyond
              that labels wrap, and a long list scrolls inside the card. */}
          <View
            style={[
              styles.pickerBox,
              {
                maxWidth: Math.min(SCREEN_WIDTH * 0.7, 900),
                maxHeight: SCREEN_HEIGHT * 0.8,
              },
            ]}
          >
            <View style={styles.pickerHeader}>
              <MaterialCommunityIcons name="playlist-play" size={22} color="#A78BFA" />
              <View style={styles.pickerHeaderText}>
                <Text style={styles.pickerTitle}>Select Season / Quality</Text>
                <Text style={styles.pickerSubtitle}>
                  {usableLinkList.length} options • choose which source to load episodes from
                </Text>
              </View>
            </View>
            <View style={styles.pickerDivider} />
            <ScrollView
              style={styles.pickerList}
              contentContainerStyle={styles.pickerListContent}
              showsVerticalScrollIndicator={false}
            >
              {usableLinkList.map((l, idx) => {
                const isActive = idx === activeLinkIndex;
                return (
                  <TVFocusablePressable
                    key={`results-season-opt-${l.title}-${idx}`}
                    hasTVPreferredFocus={isActive}
                    scaleFocused={1.02}
                    focusedBorderColor="#8A5CF6"
                    borderRadius={10}
                    onPress={() => {
                      onSelectLink(idx);
                      setSeasonPickerVisible(false);
                    }}
                    style={[styles.seasonPickerOption, isActive && styles.seasonPickerOptionActive]}
                  >
                    {() => (
                      <View style={styles.seasonPickerOptionInner}>
                        {/* Full label, wrapped -- never truncated. */}
                        <Text
                          style={[
                            styles.seasonPickerOptionText,
                            isActive && styles.seasonPickerOptionTextActive,
                          ]}
                        >
                          {l.title}
                          {l.quality ? ` • ${l.quality}` : ''}
                        </Text>
                        {isActive && (
                          <MaterialCommunityIcons
                            name="check-circle"
                            size={20}
                            color="#A78BFA"
                            style={styles.seasonPickerCheck}
                          />
                        )}
                      </View>
                    )}
                  </TVFocusablePressable>
                );
              })}
            </ScrollView>
            <TVFocusablePressable
              scaleFocused={1.05}
              focusedBorderColor="#FFFFFF"
              borderRadius={8}
              onPress={() => setSeasonPickerVisible(false)}
              style={styles.pickerCancelBtn}
            >
              {() => <Text style={styles.pickerCancelText}>Cancel</Text>}
            </TVFocusablePressable>
          </View>
        </View>
      </Modal>
    </View>
  );
};

export default TVDiscoverResultsView;
