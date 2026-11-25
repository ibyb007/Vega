// Nuvio catalog fallback for the TV Home screen.
//
// Nuvio's catalog service speaks the Stremio addon protocol, so it is read
// with the same helpers the Discover tab uses (see stremioCatalog.ts). Home
// only shows these rows when the active source has no catalog of its own
// (see useNuvioFallbackRows). Pressing a poster opens it in Discover's
// source picker, because a Nuvio item is just a title (IMDb id), not a link
// that belongs to one of the installed provider addons.

import {
  CatalogMediaItem,
  DiscoverCatalog,
  fetchCatalogItems,
  loadDiscoverCatalogs,
} from './stremioCatalog';

import { NUVIO_CATALOG_MANIFEST_URL } from '../storage/StremioCatalogStorage';

export const NUVIO_MANIFEST_URL = NUVIO_CATALOG_MANIFEST_URL;

// Rows fetched for the fallback Home page, and how many posters each keeps.
const MAX_ROWS = 10;
const MAX_POSTS_PER_ROW = 30;

export interface NuvioHomeRow {
  title: string;
  filter: string;
  Posts: any[];
  isNuvioFallback: true;
  sourceLabel: string;
}

const TYPE_LABEL: Record<string, string> = {
  movie: 'Movies',
  series: 'Series',
};

// Catalogs that need an extra (search text, a genre pick...) can't be
// listed with a plain request, so they are skipped on Home.
const needsExtra = (cat: any): boolean => {
  if (Array.isArray(cat?.extraRequired) && cat.extraRequired.length > 0) {
    return true;
  }
  return (
    Array.isArray(cat?.extra) && cat.extra.some((e: any) => e?.isRequired)
  );
};

const toPost = (item: CatalogMediaItem) => ({
  title: item.title,
  // Unique, never handed to a provider (nuvioFallback posts skip provider
  // metadata lookups on Home).
  link: `nuvio::${item.type}::${item.id}`,
  image: item.poster || item.banner || '',
  poster: item.poster,
  background: item.banner,
  extra: item.overview,
  year: item.year,
  rating: item.rating,
  genres: item.genres,
  nuvioFallback: true,
  discoverSource: item,
});

const rowFromCatalog = async (
  cat: DiscoverCatalog,
): Promise<NuvioHomeRow | null> => {
  const items = await fetchCatalogItems(cat.baseEndpoint, cat.type, cat.id);
  if (items.length === 0) return null;
  const typeLabel = TYPE_LABEL[cat.type] || cat.type;
  const name = cat.name || cat.id;
  return {
    title: `${name} - ${typeLabel}`,
    filter: `nuvio::${cat.type}::${cat.id}`,
    Posts: items.slice(0, MAX_POSTS_PER_ROW).map(toPost),
    isNuvioFallback: true,
    sourceLabel: 'Nuvio',
  };
};

export const getNuvioHomeRows = async (): Promise<NuvioHomeRow[]> => {
  const catalogs = (
    await loadDiscoverCatalogs([{ url: NUVIO_MANIFEST_URL, name: 'Nuvio' }])
  )
    .filter(
      (c) => (c.type === 'movie' || c.type === 'series') && !needsExtra(c),
    )
    .slice(0, MAX_ROWS);

  const settled = await Promise.allSettled(catalogs.map(rowFromCatalog));
  const rows: NuvioHomeRow[] = [];
  settled.forEach((r) => {
    if (r.status === 'fulfilled' && r.value) rows.push(r.value);
  });
  if (rows.length === 0) {
    throw new Error('Nuvio catalog returned no items');
  }
  return rows;
};
