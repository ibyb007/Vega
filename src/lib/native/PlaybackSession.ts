import { NativeModules, NativeEventEmitter, EmitterSubscription } from 'react-native';

const { PlaybackSessionModule } = NativeModules as {
  PlaybackSessionModule?: {
    start(
      title: string,
      subtitle: string | null,
      artworkUrl: string | null,
      durationMs: number,
      hasNext: boolean,
      hasPrevious: boolean
    ): void;
    update(
      state: string,
      positionMs: number,
      durationMs: number,
      hasNext: boolean,
      hasPrevious: boolean
    ): void;
    stop(): void;
    addListener(eventName: string): void;
    removeListeners(count: number): void;
  };
};

const emitter = PlaybackSessionModule ? new NativeEventEmitter(PlaybackSessionModule as any) : null;

export type PlaybackSessionState = 'playing' | 'paused' | 'buffering';

export type PlaybackSessionCommand =
  | { action: 'play' | 'pause' | 'fastForward' | 'rewind' | 'next' | 'previous' }
  | { action: 'seekTo'; positionMs: number };

/**
 * JS face of the native MediaSession (native-src/android/com/vega/
 * PlaybackSessionModule.kt). Lets remote controllers such as atvTools,
 * the Google TV remote app or `adb shell input keyevent` show "Now playing"
 * and control the player. Every call is a safe no-op when the module isn't
 * linked.
 */
export const PlaybackSession = {
  available: !!PlaybackSessionModule,

  start(opts: {
    title: string;
    subtitle?: string;
    artworkUrl?: string;
    durationSec?: number;
    hasNext: boolean;
    hasPrevious: boolean;
  }) {
    PlaybackSessionModule?.start(
      opts.title,
      opts.subtitle || null,
      opts.artworkUrl || null,
      Math.max(0, Math.round((opts.durationSec || 0) * 1000)),
      opts.hasNext,
      opts.hasPrevious
    );
  },

  update(opts: {
    state: PlaybackSessionState;
    positionSec: number;
    durationSec: number;
    hasNext: boolean;
    hasPrevious: boolean;
  }) {
    PlaybackSessionModule?.update(
      opts.state,
      Math.max(0, Math.round((opts.positionSec || 0) * 1000)),
      Math.max(0, Math.round((opts.durationSec || 0) * 1000)),
      opts.hasNext,
      opts.hasPrevious
    );
  },

  stop() {
    PlaybackSessionModule?.stop();
  },

  onCommand(cb: (cmd: PlaybackSessionCommand) => void): EmitterSubscription | undefined {
    return emitter?.addListener(
      'PlaybackSession:onCommand',
      (e: { action: string; positionMs?: number }) => {
        if (e.action === 'seekTo') {
          cb({ action: 'seekTo', positionMs: e.positionMs ?? 0 });
        } else {
          cb({ action: e.action } as PlaybackSessionCommand);
        }
      }
    );
  },

  /** The activity is fully hidden (Home / other app / screen off). */
  onActivityStopped(cb: () => void): EmitterSubscription | undefined {
    return emitter?.addListener('PlaybackSession:onActivityStopped', cb);
  },
};
