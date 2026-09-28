import {useCallback, useEffect, useState} from 'react';
import {Platform} from 'react-native';
import {torrentManager} from '../torrentManager';
import type {TorrentFile} from '../torrentManager';

/**
 * Turns a torrent (magnet) stream link into something ExoPlayer can open.
 *
 * ExoPlayer cannot play `magnet:` URIs. The native TorrentModule (libtorrent4j)
 * downloads the torrent and TorrentStreamServer serves one file of it over
 * http://127.0.0.1:<port>/stream/<hash>/<fileIndex>/<name>. This hook drives
 * that flow:
 *
 *   addTorrentForStream -> pick the right video file -> prepareVideoFile
 *   (wait for the first pieces) -> getStreamUrl
 *
 * and removes the torrent (and its cached files) when the source changes or the
 * player unmounts.
 */

const VIDEO_EXT = /\.(mkv|mp4|m4v|avi|mov|webm|ts|m2ts|wmv|flv|mpg|mpeg)$/i;
// Native addTorrent already gives up on metadata after 45s; this bounds the
// "wait for first video pieces" step (native side would wait up to 5 min).
const PREPARE_TIMEOUT_MS = 90_000;

export type TorrentPhase = 'idle' | 'connecting' | 'buffering' | 'ready' | 'error';

export interface TorrentPlayback {
  /** True when the link is a torrent and must be resolved before playback. */
  isTorrent: boolean;
  /** http://127.0.0.1 URL to give the player. Null until the torrent is ready. */
  playableUrl: string | null;
  phase: TorrentPhase;
  /** Human readable progress, e.g. "Finding peers... 12 peers". */
  statusText: string;
  error: string | null;
  /** Re-open the same local URL (same torrent) -- used after a player IO error. */
  reloadPlayer: () => void;
  /** Tear down and start resolving the torrent again (after an error). */
  retry: () => void;
}

export const isTorrentLink = (
  link?: string | null,
  sourceType?: string | null,
): boolean => {
  if (!link) {
    return false;
  }
  return /^magnet:/i.test(link) || sourceType === 'torrent';
};

export interface ParsedMagnet {
  /** 40 char lowercase hex info hash, or null if the link has none we can use. */
  infoHash: string | null;
  /** Value of a single-index `so=` (BEP 53 "select only") parameter, if present. */
  fileIndex: number | null;
}

export const parseMagnet = (link: string): ParsedMagnet => {
  const btih = link.match(/btih:([a-z0-9]+)/i)?.[1] ?? '';
  const infoHash = /^[a-f0-9]{40}$/i.test(btih) ? btih.toLowerCase() : null;
  const so = link.match(/[?&]so=(\d+)(?=&|$)/i)?.[1];
  return {infoHash, fileIndex: so != null ? Number(so) : null};
};

const episodePattern = (season: number, episode: number) =>
  new RegExp(
    `(?:^|[^a-z0-9])(?:s0*${season}[ ._-]*e0*${episode}|0*${season}x0*${episode})(?![0-9])`,
    'i',
  );

/**
 * Chooses which file of the torrent to play.
 *  - series episode: prefer a file whose name carries that SxxEyy / 1x02 tag
 *    (season packs contain many episodes); the provider's `so` index wins when
 *    it agrees with that.
 *  - otherwise: the provider's `so` index if it is a video, else the largest
 *    video file. "sample" clips are ignored.
 */
export const pickVideoFile = (
  files: TorrentFile[],
  hints: {fileIndex?: number | null; season?: number; episode?: number},
): TorrentFile | null => {
  const videos = files.filter(
    f => VIDEO_EXT.test(f.name) && !/(^|[^a-z])sample([^a-z]|$)/i.test(f.name),
  );
  if (videos.length === 0) {
    return null;
  }
  const largest = (list: TorrentFile[]) =>
    list.reduce((a, b) => (b.size > a.size ? b : a));
  const hinted =
    hints.fileIndex != null
      ? videos.find(f => f.index === hints.fileIndex)
      : undefined;

  if (hints.season != null && hints.episode != null) {
    const re = episodePattern(hints.season, hints.episode);
    const matches = videos.filter(f => re.test(f.path) || re.test(f.name));
    if (matches.length > 0) {
      return hinted && matches.includes(hinted) ? hinted : largest(matches);
    }
  }
  return hinted ?? largest(videos);
};

const withTimeout = <T,>(p: Promise<T>, ms: number, message: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      v => {
        clearTimeout(t);
        resolve(v);
      },
      e => {
        clearTimeout(t);
        reject(e);
      },
    );
  });

const describeError = (e: any): string => {
  const code = e?.code ? `${e.code}: ` : '';
  const msg = e?.message || String(e);
  if (e?.code === 'TIMEOUT' || /metadata/i.test(msg)) {
    return 'Could not find enough peers for this torrent. Try another source.';
  }
  return `${code}${msg}`;
};

const formatStats = (
  label: string,
  st: {numPeers?: number; downloadRate?: number},
): string => {
  const peers = st.numPeers ?? 0;
  const rate =
    (st.downloadRate ?? 0) > 0
      ? ` · ${((st.downloadRate as number) / 1048576).toFixed(1)} MB/s`
      : '';
  return `${label}... ${peers} ${peers === 1 ? 'peer' : 'peers'}${rate}`;
};

export function useTorrentPlayback(
  link: string | undefined | null,
  sourceType: string | undefined | null,
  episode?: {season?: number; episode?: number},
): TorrentPlayback {
  const isTorrent = isTorrentLink(link, sourceType);
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [phase, setPhase] = useState<TorrentPhase>('idle');
  const [statusText, setStatusText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [reloadNonce, setReloadNonce] = useState(0);

  const season = episode?.season;
  const episodeNumber = episode?.episode;

  useEffect(() => {
    setBaseUrl(null);
    setError(null);
    setReloadNonce(0);
    if (!isTorrent || !link) {
      setPhase('idle');
      setStatusText('');
      return;
    }

    let cancelled = false;
    let poll: ReturnType<typeof setInterval> | null = null;
    const parsed = parseMagnet(link);
    let hash: string | null = parsed.infoHash;
    // False when the torrent was already added by something else (e.g. an
    // in-progress download of the same torrent): we must not prioritise files
    // in it or delete it when playback ends.
    let owned = true;

    const stopPolling = () => {
      if (poll) {
        clearInterval(poll);
        poll = null;
      }
    };
    const startPolling = (label: string) => {
      stopPolling();
      poll = setInterval(async () => {
        if (!hash) {
          return;
        }
        try {
          const st = await torrentManager.getStats(hash);
          if (!cancelled) {
            setStatusText(formatStats(label, st));
          }
        } catch {
          // Torrent not added yet / already removed -- ignore.
        }
      }, 1000);
    };

    (async () => {
      try {
        if (Platform.OS !== 'android') {
          throw new Error('Torrent streaming is only supported on Android');
        }
        if (!parsed.infoHash) {
          throw new Error(
            'Unsupported torrent link (expected a magnet with a 40-character info hash)',
          );
        }

        setPhase('connecting');
        setStatusText('Connecting to peers...');
        startPolling('Finding peers');

        const added = await torrentManager.addTorrentForStream(link);
        if (cancelled) {
          return; // cleanup below removes the torrent
        }
        hash = added.infoHash || hash;
        owned = !added.foreign;

        const files = added.files?.length
          ? added.files
          : await torrentManager.getFiles(hash as string);
        if (cancelled) {
          return;
        }
        const file = pickVideoFile(files, {
          fileIndex: parsed.fileIndex,
          season,
          episode: episodeNumber,
        });
        if (!file) {
          throw new Error('No playable video file found in this torrent');
        }

        setPhase('buffering');
        setStatusText('Buffering...');
        startPolling('Buffering');
        if (owned) {
          await withTimeout(
            torrentManager.prepareVideoFile(hash as string, file.index),
            PREPARE_TIMEOUT_MS,
            'Timed out waiting for the first video data (no seeders or too slow). Try another source.',
          );
          if (cancelled) {
            return;
          }
        }

        const url = await torrentManager.getStreamUrl(hash as string, file.index);
        if (cancelled) {
          return;
        }
        stopPolling();
        setBaseUrl(url);
        setPhase('ready');
        setStatusText('');
      } catch (e: any) {
        if (cancelled) {
          return;
        }
        stopPolling();
        console.warn('[useTorrentPlayback] failed:', e);
        setError(describeError(e));
        setPhase('error');
        setStatusText('');
        if (hash && owned) {
          torrentManager.deleteTorrent(hash, true).catch(() => {});
        }
      }
    })();

    return () => {
      cancelled = true;
      stopPolling();
      if (hash && owned) {
        torrentManager.deleteTorrent(hash, true).catch(() => {});
      }
    };
  }, [link, isTorrent, attempt, season, episodeNumber]);

  const reloadPlayer = useCallback(() => setReloadNonce(n => n + 1), []);
  const retry = useCallback(() => setAttempt(n => n + 1), []);

  const playableUrl = baseUrl
    ? reloadNonce > 0
      ? `${baseUrl}?r=${reloadNonce}`
      : baseUrl
    : null;

  return {isTorrent, playableUrl, phase, statusText, error, reloadPlayer, retry};
}
