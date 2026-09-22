// Providers have no structured "file size" field -- when they expose one at
// all, it is baked into a title/description/quality label: "Episode 5
// [1.4GB]", "1080p x265 (850 MB)", "S01E03 - 2.1 GB", etc. These helpers
// pull that out so the details screen can show it as its own badge, and
// strip it from the label so it isn't shown twice.
//
// Only GB/MB/TB are recognised (binary GiB/MiB/TiB too) -- KB is never a
// meaningful episode size, and matching it would catch things like "128 KB"
// audio bitrates. A structured `size`/`fileSize` field is honoured too, in
// case a provider does set one (a bare number is read as bytes).

// Number then unit, with a word boundary after the unit so "10bit" / "4GBps"
// style tokens don't match. The leading group stops us matching the tail of
// a longer number or a dotted version ("v2.1GB").
const UNIT = 'TB|GB|MB|TiB|GiB|MiB';
const SIZE_REGEX = new RegExp(`(?:^|[^\\w.,])(\\d{1,4}(?:[.,]\\d{1,3})?)\\s?(${UNIT})\\b`, 'i');

// The same token, but in the shapes we strip from a display label.
const SIZE_TOKEN = `\\d{1,4}(?:[.,]\\d{1,3})?\\s?(?:${UNIT})\\b`;
const BRACKETED_SIZE = new RegExp(`\\s*[\\[({]\\s*${SIZE_TOKEN}\\s*[\\])}]`, 'gi');
const SEPARATED_SIZE = new RegExp(`\\s*[-–|•·/]\\s*${SIZE_TOKEN}`, 'gi');
const BARE_SIZE = new RegExp(`(^|\\s)${SIZE_TOKEN}`, 'gi');

const normalizeUnit = (unit: string): string => {
  const lower = unit.toLowerCase();
  switch (lower) {
    case 'tb':
      return 'TB';
    case 'gb':
      return 'GB';
    case 'mb':
      return 'MB';
    case 'tib':
      return 'TiB';
    case 'gib':
      return 'GiB';
    case 'mib':
      return 'MiB';
    default:
      return unit;
  }
};

const normalizeNumber = (raw: string): string => {
  // "1,024" is a thousands separator, "1,4" is a decimal comma.
  const value = /^\d{1,3},\d{3}$/.test(raw) ? raw.replace(',', '') : raw.replace(',', '.');
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? String(parsed) : value;
};

/** Formats a byte count as "1.4 GB" / "850 MB". */
export const formatBytes = (bytes: number): string | undefined => {
  if (!Number.isFinite(bytes) || bytes <= 0) return undefined;
  const GB = 1024 ** 3;
  const MB = 1024 ** 2;
  if (bytes >= GB) return `${parseFloat((bytes / GB).toFixed(2))} GB`;
  if (bytes >= MB) return `${Math.round(bytes / MB)} MB`;
  return undefined;
};

/** First "<number> GB|MB|TB" found in `text`, normalised to e.g. "1.4 GB". */
export const parseFileSizeText = (text: string | undefined | null): string | undefined => {
  if (!text) return undefined;
  const match = text.match(SIZE_REGEX);
  if (!match) return undefined;
  return `${normalizeNumber(match[1])} ${normalizeUnit(match[2])}`;
};

/** Removes any size token from a label ("Ep 5 [1.4GB]" -> "Ep 5"). */
export const stripFileSize = (text: string | undefined | null): string => {
  if (!text) return '';
  return text
    .replace(BRACKETED_SIZE, '')
    .replace(SEPARATED_SIZE, '')
    .replace(BARE_SIZE, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s\-–|•·/]+$/, '')
    .trim();
};

const sizeFromStructuredField = (value: unknown): string | undefined => {
  if (typeof value === 'number') return formatBytes(value);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  // A bare digit string is bytes; anything with a unit goes through the text parser.
  if (/^\d{7,}$/.test(trimmed)) return formatBytes(parseInt(trimmed, 10));
  return parseFileSizeText(trimmed);
};

/**
 * Best-effort file size for an episode / direct-link entry. Prefers an
 * explicit `size`/`fileSize` field, then falls back to scanning the
 * title, quality and description text. Returns undefined when the provider
 * gave nothing in GB/MB -- callers should simply show no badge.
 */
export const getFileSizeLabel = (
  entry: { title?: string; description?: string; quality?: string; [key: string]: any } | null | undefined,
): string | undefined => {
  if (!entry) return undefined;
  return (
    sizeFromStructuredField(entry.fileSize) ||
    sizeFromStructuredField(entry.filesize) ||
    sizeFromStructuredField(entry.size) ||
    parseFileSizeText(entry.title) ||
    parseFileSizeText(entry.quality) ||
    parseFileSizeText(entry.description)
  );
};
