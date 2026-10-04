import {useCallback, useEffect, useState} from 'react';
import {Platform} from 'react-native';
import {torrentManager} from '../torrentManager';
import type {TorrentFile} from '../torrentManager';

/**
 * Turns a torrent (magnet) stream link into something ExoPlayer can open.
 *
 * ExoPlayer cannot play `magnet:` URIs. The native TorrentModule (libtorrent4j)
 * downloads the torrent and TorrentStreamServer serves one file of it over
 * http://127.0.0.1:<port>/stream/<hash>/<fileIndex>/<name>. This is the same
 * flow the mobile app's Player.tsx uses, on the existing native module
 * unchanged:
 *
 *   addTorrent -> pick the video file -> prepareVideoFile (wait for the first
 *   piece) -> getStreamUrl
 *
 * The torrent (and its files) is removed when the source changes or the
 * player unmounts.
 */

const VIDEO_EXT = /\.(mkv|mp4|m4v|avi|mov|webm|ts|wmv|flv)$/i;
// Placeholder hashes some providers emit for "no real torrent" (same guard as
// the mobile player).
const DUMMY_HASHES = [
  'd41d0cfbf8baa3ce04a7074b0c486243dd5fbd00',
  'd41d8cd98f00b204e9800998ecf8427e',
];
// addTorrent gives up on metadata after 45s natively; this bounds the "wait
// for the first video piece" step (natively it would wait up to 5 minutes).
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

/** 40 char lowercase hex info hash of a magnet link, or null. */
export const parseInfoHash = (link: string): string | null => {
  const btih = link.match(/btih:([a-z0-9]+)/i)?.[1] ?? '';
  return /^[a-f0-9]{40}$/i.test(btih) ? btih.toLowerCase() : null;
};

const episodePattern = (season: number, episode: number) =>
  new RegExp(
    `(?:^|[^a-z0-9])(?:s0*${season}[ ._-]*e0*${episode}|0*${season}x0*${episode})(?![0-9])`,
    'i',
  );

/**
 * Chooses which file of the torrent to play: the largest video file (as the
 * mobile player does), except that for a series episode a file carrying that
 * episode's SxxEyy / 1x02 tag wins -- season packs hold many episodes and the
 * largest file is rarely the one asked for. "sample" clips are ignored.
 */
export const pickVideoFile = (
  files: TorrentFile[],
  hints: {season?: number; episode?: number} = {},
): TorrentFile | null => {
  const videos = files.filter(
    f => VIDEO_EXT.test(f.name) && !/(^|[^a-z])sample([^a-z]|$)/i.test(f.name),
  );
  if (videos.length === 0) {
    return null;
  }
  const largest = (list: TorrentFile[]) =>
    list.reduce((a, b) => (b.size > a.size ? b : a));

  if (hints.season != null && hints.episode != null) {
    const re = episodePattern(hints.season, hints.episode);
    const matches = videos.filter(f => re.test(f.path) || re.test(f.name));
    if (matches.length > 0) {
      return largest(matches);
    }
  }
  return largest(videos);
};

// Torrent removal is serialised so that starting the same torrent again right
// after leaving it can never race the previous removal.
let removalChain: Promise<void> = Promise.resolve();
const removeTorrentQueued = (hash: string): Promise<void> => {
  removalChain = removalChain.then(() =>
    torrentManager.deleteTorrent(hash, true).catch(() => {}),
  );
  return removalChain;
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
  const msg = e?.message || String(e);
  if (e?.code === 'TIMEOUT' || /metadata/i.test(msg)) {
    return 'Could not find enough peers for this torrent.';
  }
  return msg;
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
    const infoHash = parseInfoHash(link);
    let hash: string | null = infoHash;
    // False when the torrent was already in the engine before we started (e.g.
    // an in-progress download of the same torrent): we must not re-prioritise
    // its files or delete it when playback ends.
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
        if (!infoHash || DUMMY_HASHES.some(d => link.toLowerCase().includes(d))) {
          throw new Error(
            'This source is not a usable torrent (missing or placeholder info hash)',
          );
        }

        setPhase('connecting');
        setStatusText('Connecting to peers...');

        // Let any removal of a previous session finish first, then see whether
        // the engine already holds this torrent (=> not ours to delete).
        await removalChain;
        if (cancelled) {
          return;
        }
        owned = await torrentManager.getStats(infoHash).then(
          () => false,
          () => true,
        );
        if (cancelled) {
          return;
        }

        startPolling('Finding peers');
        const added = await torrentManager.addTorrent(link);
        if (cancelled) {
          return; // cleanup below removes it (if owned)
        }
        hash = added.infoHash || hash;

        const files = added.files?.length
          ? added.files
          : await torrentManager.getFiles(hash as string);
        if (cancelled) {
          return;
        }
        const file = pickVideoFile(files, {season, episode: episodeNumber});
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
            'Timed out waiting for the first video data (no seeders or too slow).',
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
          removeTorrentQueued(hash);
        }
      }
    })();

    return () => {
      cancelled = true;
      stopPolling();
      if (hash && owned) {
        removeTorrentQueued(hash);
      }
    };
  }, [link, isTorrent, season, episodeNumber]);

  const reloadPlayer = useCallback(() => setReloadNonce(n => n + 1), []);

  const playableUrl = baseUrl
    ? reloadNonce > 0
      ? `${baseUrl}?r=${reloadNonce}`
      : baseUrl
    : null;

  return {isTorrent, playableUrl, phase, statusText, error, reloadPlayer};
}
