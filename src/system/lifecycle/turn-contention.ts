import type { EventBus } from '../../shared/event-bus.js';

export type TurnContentionPolicy = 'drop' | 'defer-latest' | 'queue' | 'steer';
export type TurnContentionPhase = 'acquired' | 'contended' | 'coalesced' | 'released';

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

function isAgentProcessingPromptMessage(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return normalized === 'agent is already processing'
    || normalized === 'agent is already processing.'
    || normalized === 'agent is already processing a prompt'
    || normalized.startsWith('agent is already processing a prompt.')
    || normalized === 'agent is already processing another prompt'
    || normalized.startsWith('agent is already processing another prompt.');
}

/** Matches the prompt runtime's active-run rejection without classifying unrelated busy failures. */
export function isAgentProcessingPromptError(error: unknown): boolean {
  const visited = new Set<Error>();
  let current = error;
  while (current instanceof Error && !visited.has(current)) {
    if (isAgentProcessingPromptMessage(current.message)) {
      return true;
    }
    visited.add(current);
    current = current.cause;
  }
  return typeof current === 'string'
    && isAgentProcessingPromptMessage(current);
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

export interface FifoChannelAcquisition {
  lease: Promise<FifoChannelLease>;
  contended: boolean;
  queueDepth: number;
  /** Removes this waiter when it has not acquired the channel yet. */
  cancel: () => boolean;
}

interface FifoChannelWaiter {
  queuedAhead: number;
  enqueuedAt: number;
  state: 'queued' | 'active' | 'released' | 'cancelled';
  resolve: (lease: FifoChannelLease) => void;
}

export class FifoChannelLock {
  private readonly queues = new Map<string, FifoChannelWaiter[]>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  acquire(channelId: string): FifoChannelAcquisition {
    const queue = this.queues.get(channelId) ?? [];
    const queuedAhead = queue.length;
    let resolveLease: (lease: FifoChannelLease) => void = () => {};
    const lease = new Promise<FifoChannelLease>((resolve) => {
      resolveLease = resolve;
    });
    const waiter: FifoChannelWaiter = {
      queuedAhead,
      enqueuedAt: this.now(),
      state: 'queued',
      resolve: resolveLease,
    };
    queue.push(waiter);
    this.queues.set(channelId, queue);
    if (queue.length === 1) {
      this.grant(channelId, waiter);
    }

    return {
      lease,
      contended: queuedAhead > 0,
      queueDepth: queuedAhead,
      cancel: () => this.cancel(channelId, waiter),
    };
  }

  pending(channelId: string): number {
    return this.queues.get(channelId)?.length ?? 0;
  }

  private grant(channelId: string, waiter: FifoChannelWaiter): void {
    if (waiter.state !== 'queued') return;
    waiter.state = 'active';
    waiter.resolve({
      queuedAhead: waiter.queuedAhead,
      waitMs: Math.max(0, this.now() - waiter.enqueuedAt),
      release: () => this.release(channelId, waiter),
    });
  }

  private cancel(channelId: string, waiter: FifoChannelWaiter): boolean {
    if (waiter.state !== 'queued') return false;
    const queue = this.queues.get(channelId);
    if (!queue) return false;
    const index = queue.indexOf(waiter);
    if (index < 0) return false;
    waiter.state = 'cancelled';
    queue.splice(index, 1);
    if (queue.length === 0) {
      this.queues.delete(channelId);
    }
    return true;
  }

  private release(channelId: string, waiter: FifoChannelWaiter): void {
    if (waiter.state !== 'active') return;
    waiter.state = 'released';
    const queue = this.queues.get(channelId);
    if (!queue) return;
    const index = queue.indexOf(waiter);
    if (index >= 0) queue.splice(index, 1);
    const next = queue.at(0);
    if (next === undefined) {
      this.queues.delete(channelId);
      return;
    }
    this.grant(channelId, next);
  }
}
