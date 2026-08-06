import type {
  CompanionAvailabilitySnapshot,
  CompanionAvailabilityState,
  SubstrateMessage,
} from '../../shared/contracts/runtime.js';
import type { EventBus } from '../../shared/event-bus.js';

export type { CompanionAvailabilitySnapshot, CompanionAvailabilityState } from '../../shared/contracts/runtime.js';
export type CompanionAvailabilityProjectionResult = 'applied' | 'unsupported';

export interface QueuedCompanionMessage {
  sequence: number;
  enqueuedAtMs: number;
  message: SubstrateMessage;
}

export interface CompanionAvailabilityStorePort {
  readState(): Promise<CompanionAvailabilitySnapshot>;
  writeState(snapshot: CompanionAvailabilitySnapshot): Promise<void>;
  enqueue(
    message: SubstrateMessage,
    enqueuedAtMs: number,
  ): Promise<'enqueued' | 'duplicate'>;
  hasPending(): Promise<boolean>;
  listPending(limit: number): Promise<QueuedCompanionMessage[]>;
  acknowledge(sequence: number): Promise<boolean>;
}

export interface CompanionAvailabilityLease {
  release(): Promise<void>;
}

export interface CompanionProtectedMessageQueuePort {
  enqueueIfUnavailable(message: SubstrateMessage): Promise<boolean>;
  setDeliverer(deliverer: (message: QueuedCompanionMessage) => Promise<void>): void;
  waitForDrain(): Promise<void>;
}

export interface CompanionAvailabilityRuntimeOptions {
  store: CompanionAvailabilityStorePort;
  project(
    snapshot: CompanionAvailabilitySnapshot,
  ): Promise<CompanionAvailabilityProjectionResult>;
  queueReadBatchSize: number;
  /** Owner-backed fixed delay between durable delivery attempts. */
  drainRetryDelayMs: number;
  returnContextMaxChars?: number;
  now?: () => number;
  onProjectionDegraded?: (snapshot: CompanionAvailabilitySnapshot) => void;
  onProjectionError?: (error: unknown, snapshot: CompanionAvailabilitySnapshot) => void;
  onDrainError?: (error: unknown, message: QueuedCompanionMessage) => void;
  onDrainRuntimeError?: (error: unknown) => void;
}

function availabilityPriority(state: Exclude<CompanionAvailabilityState, 'available'>): number {
  return state === 'do_not_disturb' ? 2 : 1;
}

/**
 * Companion-local availability authority shared by scheduler lanes and channel
 * ingress. The durable state is deliberately coarse: no activity name, prompt,
 * or private reason crosses this boundary.
 */
export class CompanionAvailabilityRuntime implements CompanionProtectedMessageQueuePort {
  private current: CompanionAvailabilitySnapshot = {
    state: 'available',
    sinceMs: 0,
    revision: 0,
  };
  private readonly activities = new Map<symbol, Exclude<CompanionAvailabilityState, 'available'>>();
  private transitionTail: Promise<void> = Promise.resolve();
  private deliverer?: (message: QueuedCompanionMessage) => Promise<void>;
  private drainPromise: Promise<void> = Promise.resolve();
  private drainRetryTimer: NodeJS.Timeout | null = null;
  private initialized = false;
  private stopping = false;
  private lastUnavailableSinceMs = 0;

  constructor(private readonly options: CompanionAvailabilityRuntimeOptions) {
    if (!Number.isInteger(options.queueReadBatchSize) || options.queueReadBatchSize < 1) {
      throw new Error('Companion availability queueReadBatchSize must be a positive integer');
    }
    if (!Number.isInteger(options.drainRetryDelayMs) || options.drainRetryDelayMs < 1) {
      throw new Error('Companion availability drainRetryDelayMs must be a positive integer');
    }
    if (options.returnContextMaxChars !== undefined
      && (!Number.isInteger(options.returnContextMaxChars) || options.returnContextMaxChars < 1)) {
      throw new Error('Companion availability returnContextMaxChars must be a positive integer');
    }
  }

  snapshot(): CompanionAvailabilitySnapshot {
    return { ...this.current };
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const persisted = await this.options.store.readState();
    if (persisted.state !== 'available') this.lastUnavailableSinceMs = persisted.sinceMs;
    const recovered: CompanionAvailabilitySnapshot = persisted.state === 'available'
      ? persisted
      : {
          state: 'available',
          sinceMs: this.now(),
          revision: persisted.revision + 1,
        };
    this.current = recovered;
    if (persisted.state !== 'available') {
      await this.options.store.writeState(recovered);
    }
    await this.project(recovered);
    this.initialized = true;
    this.scheduleDrain();
  }

  async begin(
    state: Exclude<CompanionAvailabilityState, 'available'>,
  ): Promise<CompanionAvailabilityLease> {
    this.assertInitialized();
    const token = Symbol(state);
    await this.serializeTransition(async () => {
      this.activities.set(token, state);
      try {
        await this.publishDerivedState();
      } catch (error) {
        this.activities.delete(token);
        throw error;
      }
    });
    let released = false;
    return {
      release: async () => {
        if (released) return;
        await this.serializeTransition(async () => {
          this.activities.delete(token);
          try {
            await this.publishDerivedState();
            released = true;
          } catch (error) {
            this.activities.set(token, state);
            throw error;
          }
        });
      },
    };
  }

  async run<T>(
    state: Exclude<CompanionAvailabilityState, 'available'>,
    handler: () => Promise<T> | T,
  ): Promise<T> {
    const lease = await this.begin(state);
    try {
      return await handler();
    } finally {
      await lease.release();
    }
  }

  async enqueueIfUnavailable(message: SubstrateMessage): Promise<boolean> {
    this.assertInitialized();
    let queued = false;
    await this.serializeTransition(async () => {
      if (this.current.state === 'available' && !(await this.options.store.hasPending())) return;
      await this.options.store.enqueue(message, this.now());
      queued = true;
    });
    return queued;
  }

  setDeliverer(deliverer: (message: QueuedCompanionMessage) => Promise<void>): void {
    this.deliverer = deliverer;
    if (this.initialized && this.current.state === 'available') this.scheduleDrain();
  }

  async waitForDrain(): Promise<void> {
    await this.drainPromise;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.clearDrainRetry();
    await this.drainPromise;
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new Error('Companion availability runtime must initialize before use');
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private deriveState(): CompanionAvailabilityState {
    let resolved: Exclude<CompanionAvailabilityState, 'available'> | undefined;
    for (const state of this.activities.values()) {
      if (!resolved || availabilityPriority(state) > availabilityPriority(resolved)) {
        resolved = state;
      }
    }
    return resolved ?? 'available';
  }

  private async publishDerivedState(): Promise<void> {
    const state = this.deriveState();
    if (state === this.current.state) return;
    const transitionedAtMs = this.now();
    if (this.current.state === 'available' && state !== 'available') {
      this.lastUnavailableSinceMs = transitionedAtMs;
    }
    const next: CompanionAvailabilitySnapshot = {
      state,
      sinceMs: transitionedAtMs,
      revision: this.current.revision + 1,
    };
    await this.options.store.writeState(next);
    this.current = next;
    await this.project(next);
    if (state === 'available') this.scheduleDrain();
  }

  private async project(snapshot: CompanionAvailabilitySnapshot): Promise<void> {
    let result: CompanionAvailabilityProjectionResult;
    try {
      result = await this.options.project(snapshot);
    } catch (error) {
      this.options.onProjectionError?.(error, { ...snapshot });
      return;
    }
    if (result === 'unsupported') this.options.onProjectionDegraded?.({ ...snapshot });
  }

  private async serializeTransition(operation: () => Promise<void>): Promise<void> {
    const current = this.transitionTail.then(operation, operation);
    this.transitionTail = current.catch(() => undefined);
    await current;
  }

  private scheduleDrain(): void {
    if (!this.deliverer || this.stopping) return;
    this.clearDrainRetry();
    const previous = this.drainPromise;
    this.drainPromise = previous.then(() => this.drain()).catch(error => {
      this.options.onDrainRuntimeError?.(error);
      this.scheduleDrainRetry();
    });
  }

  private scheduleDrainRetry(): void {
    if (this.drainRetryTimer
      || this.stopping
      || this.current.state !== 'available') return;
    this.drainRetryTimer = setTimeout(() => {
      this.drainRetryTimer = null;
      this.scheduleDrain();
    }, this.options.drainRetryDelayMs);
    this.drainRetryTimer.unref();
  }

  private clearDrainRetry(): void {
    if (!this.drainRetryTimer) return;
    clearTimeout(this.drainRetryTimer);
    this.drainRetryTimer = null;
  }

  private async drain(): Promise<void> {
    if (!this.deliverer) return;
    const summarizedChannels = new Set<string>();
    while (this.current.state === 'available') {
      const pending = await this.options.store.listPending(this.options.queueReadBatchSize);
      if (pending.length === 0) return;
      for (const queued of pending) {
        if (this.snapshot().state !== 'available') return;
        const delivery = summarizedChannels.has(queued.message.channelId)
          ? queued
          : this.withReturnContext(queued, pending);
        summarizedChannels.add(queued.message.channelId);
        try {
          await this.deliverer(delivery);
        } catch (error) {
          this.options.onDrainError?.(error, queued);
          this.scheduleDrainRetry();
          return;
        }
        const acknowledged = await this.options.store.acknowledge(queued.sequence);
        if (!acknowledged) {
          throw new Error('Companion protected message acknowledgement failed');
        }
      }
    }
  }

  private withReturnContext(
    queued: QueuedCompanionMessage,
    pending: readonly QueuedCompanionMessage[],
  ): QueuedCompanionMessage {
    const maxChars = this.options.returnContextMaxChars;
    if (!maxChars) return queued;
    const channelMessages = pending.filter(
      entry => entry.message.channelId === queued.message.channelId,
    );
    let remainingChars = maxChars;
    const messages = channelMessages.flatMap(entry => {
      if (remainingChars < 1) return [];
      const normalized = entry.message.content.replace(/\s+/g, ' ').trim();
      if (!normalized) return [];
      const excerpt = normalized.slice(0, remainingChars);
      remainingChars -= excerpt.length;
      return [{
        authorName: entry.message.authorName,
        timestampMs: entry.message.timestamp.getTime(),
        excerpt,
      }];
    });
    return {
      ...queued,
      message: {
        ...queued.message,
        routing: {
          ...queued.message.routing,
          protectedTimeReturn: {
            schemaVersion: 1,
            queuedCount: channelMessages.length,
            unavailableSinceMs: this.lastUnavailableSinceMs,
            returnedAtMs: this.now(),
            messages,
          },
        },
      },
    };
  }
}

export function attachToolAvailability(input: {
  eventBus: EventBus;
  runtime: Pick<CompanionAvailabilityRuntime, 'begin'>;
  isLongRunningTool(toolName: string): boolean;
  onError?: (error: unknown) => void;
}): () => Promise<void> {
  const leases = new Map<string, CompanionAvailabilityLease>();
  const unregisterStart = input.eventBus.on('agent.tool.start', async ({ toolCallId, toolName }) => {
    if (!input.isLongRunningTool(toolName) || leases.has(toolCallId)) return;
    try {
      leases.set(toolCallId, await input.runtime.begin('idle'));
    } catch (error) {
      input.onError?.(error);
    }
  });
  const unregisterEnd = input.eventBus.on('agent.tool.end', async ({ toolCallId }) => {
    const lease = leases.get(toolCallId);
    if (!lease) return;
    try {
      await lease.release();
      leases.delete(toolCallId);
    } catch (error) {
      input.onError?.(error);
    }
  });
  return async () => {
    unregisterStart();
    unregisterEnd();
    const active = [...leases.values()];
    leases.clear();
    await Promise.all(active.map(lease => lease.release()));
  };
}
