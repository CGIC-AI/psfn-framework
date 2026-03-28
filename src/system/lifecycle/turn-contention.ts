import type { EventBus } from '../../shared/event-bus.js';

export type TurnContentionPolicy = 'drop' | 'defer-latest' | 'queue' | 'steer';
export type TurnContentionPhase = 'acquired' | 'contended' | 'released';

export interface TurnContentionTelemetry {
  channelId: string;
  phase: TurnContentionPhase;
  policy: TurnContentionPolicy;
  source: string;
  queueDepth: number;
  waitMs: number;
  processingChannels: number;
  timestamp: number;
  reason?: string;
  superseded?: boolean;
}

type TelemetryBus = Pick<EventBus, 'emit'>;

export function emitTurnContentionTelemetry(
  eventBus: TelemetryBus,
  telemetry: Omit<TurnContentionTelemetry, 'timestamp'>,
): void {
  const payload: TurnContentionTelemetry = {
    ...telemetry,
    timestamp: Date.now(),
  };
  eventBus.emit('channel.queue.telemetry', payload).catch(() => undefined);
}

export function isBusyTurnError(error: unknown): boolean {
  const text = String(error ?? '').toLowerCase();
  return text.includes('already processing')
    || text.includes('agent_busy')
    || text.includes('channel_busy');
}

export class DeferredLatestByChannel<T> {
  private readonly pending = new Map<string, T>();

  set(channelId: string, value: T): { replaced: boolean; queueDepth: number } {
    const replaced = this.pending.has(channelId);
    this.pending.set(channelId, value);
    return { replaced, queueDepth: 1 };
  }

  take(channelId: string): T | undefined {
    const value = this.pending.get(channelId);
    if (value !== undefined) {
      this.pending.delete(channelId);
    }
    return value;
  }

  depth(channelId: string): number {
    return this.pending.has(channelId) ? 1 : 0;
  }
}

export interface FifoChannelLease {
  queuedAhead: number;
  waitMs: number;
  release: () => void;
}

export class FifoChannelLock {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly depthByChannel = new Map<string, number>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  acquire(channelId: string): {
    lease: Promise<FifoChannelLease>;
    contended: boolean;
    queueDepth: number;
  } {
    const queuedAhead = this.depthByChannel.get(channelId) ?? 0;
    this.depthByChannel.set(channelId, queuedAhead + 1);

    const previousTail = this.tails.get(channelId) ?? Promise.resolve();
    let releaseTail: (() => void) | null = null;
    const tailSignal = new Promise<void>((resolve) => {
      releaseTail = resolve;
    });
    const chainedTail = previousTail.then(() => tailSignal);
    this.tails.set(channelId, chainedTail);

    const enqueuedAt = this.now();
    const lease = previousTail.then(() => {
      const waitMs = Math.max(0, this.now() - enqueuedAt);
      let released = false;
      return {
        queuedAhead,
        waitMs,
        release: () => {
          if (released) return;
          released = true;
          releaseTail?.();

          const nextDepth = (this.depthByChannel.get(channelId) ?? 1) - 1;
          if (nextDepth <= 0) {
            this.depthByChannel.delete(channelId);
          } else {
            this.depthByChannel.set(channelId, nextDepth);
          }

          if (this.tails.get(channelId) === chainedTail) {
            this.tails.delete(channelId);
          }
        },
      };
    });

    return {
      lease,
      contended: queuedAhead > 0,
      queueDepth: queuedAhead,
    };
  }

  pending(channelId: string): number {
    return this.depthByChannel.get(channelId) ?? 0;
  }
}
