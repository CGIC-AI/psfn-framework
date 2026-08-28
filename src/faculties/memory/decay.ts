import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type { MemoryStorePort } from './memory-store-port.js';
import { createComponentLogger } from '../../shared/logger.js';
import {
  MEMORY_CONFIG,
  assertMemoryType,
  getMemoryDecayProfile,
  resolvePersistedMemoryType,
} from './types.js';
import type { PurrMemory } from './types.js';
import {
  resolveMemoryRetrievalPolicy,
  type MemoryRetrievalPolicy,
} from '../../system/config/memory-retrieval-policy.js';

export interface SalienceDecayInvalidMemoryTypeReport {
  memoryId: string;
  memoryType: string;
  reason: 'legacy_fact_category_is_semantic' | 'unsupported_memory_type';
}

interface SalienceDecayOptions {
  batchSize?: number;
  memoryRetrievalPolicy?: MemoryRetrievalPolicy | (() => MemoryRetrievalPolicy | undefined);
  onInvalidMemoryType?: (report: SalienceDecayInvalidMemoryTypeReport) => void;
}

const log = createComponentLogger('SalienceDecay');
const MEANINGFUL_SALIENCE_DELTA = 0.01;
const DAY_MS = 24 * 60 * 60 * 1_000;

interface TrackedDecayAnchor {
  baseSalience: number;
  sourceLastAccessed: number;
  sourceDecayAnchorAt: number;
  decayEpoch: number;
  lastPersistedSalience: number;
  halflife: number;
  salienceFloor: number;
}

export function calculateEffectiveMemorySalience(
  memory: PurrMemory,
  now: number = Date.now(),
  policyInput?: MemoryRetrievalPolicy,
): number {
  assertMemoryType(memory.type);
  const decayAnchorAt = Number.isFinite(memory.salienceDecayAnchorAt)
    ? memory.salienceDecayAnchorAt!
    : memory.lastAccessed;
  if (!Number.isFinite(decayAnchorAt) || !Number.isFinite(now)) {
    return memory.salience;
  }
  const policy = resolveMemoryRetrievalPolicy(policyInput);
  const profile = getMemoryDecayProfile(memory, policy);
  const halflife = policy.typePolicies[memory.type].halfLifeDays
    * DAY_MS
    * profile.halflifeMultiplier;
  if (!Number.isFinite(halflife) || halflife <= 0) return memory.salience;
  const dt = Math.max(0, now - decayAnchorAt);
  const decayFactor = Math.exp((-Math.LN2 * dt) / halflife);
  return Math.max(profile.salienceFloor, memory.salience * decayFactor);
}

function calculateDecayedSalience(
  anchor: Pick<TrackedDecayAnchor, 'baseSalience' | 'decayEpoch' | 'halflife' | 'salienceFloor'>,
  now: number,
): number {
  const dt = Math.max(0, now - anchor.decayEpoch);
  const decayFactor = Math.exp((-Math.LN2 * dt) / anchor.halflife);
  return Math.max(anchor.salienceFloor, anchor.baseSalience * decayFactor);
}

function nextMeaningfulDecayAt(anchor: TrackedDecayAnchor, now: number): number {
  const targetSalience = anchor.lastPersistedSalience - MEANINGFUL_SALIENCE_DELTA;
  if (
    anchor.baseSalience <= 0
    || targetSalience <= anchor.salienceFloor
    || targetSalience >= anchor.baseSalience
  ) {
    return Number.POSITIVE_INFINITY;
  }
  const crossingAt = anchor.decayEpoch
    + (-Math.log(targetSalience / anchor.baseSalience) * anchor.halflife) / Math.LN2;
  return Math.max(now + 1, Math.floor(crossingAt) + 1);
}

export class SalienceDecay {
  private memoryStore: MemoryStorePort;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly batchSize: number;
  private readonly memoryRetrievalPolicy:
    | MemoryRetrievalPolicy
    | (() => MemoryRetrievalPolicy | undefined)
    | undefined;
  private readonly onInvalidMemoryType:
    | ((report: SalienceDecayInvalidMemoryTypeReport) => void)
    | undefined;
  private readonly activeRuns = new Set<object>();
  private readonly trackedAnchors = new Map<string, TrackedDecayAnchor>();
  private lastProcessedRevision: number | null = null;
  private nextTrackedRunAt = 0;
  private lastPolicy: MemoryRetrievalPolicy | null = null;

  constructor(memoryStore: MemoryStorePort, options: SalienceDecayOptions = {}) {
    this.memoryStore = memoryStore;
    this.batchSize = Math.max(1, Math.floor(options.batchSize ?? 500));
    this.memoryRetrievalPolicy = options.memoryRetrievalPolicy;
    this.onInvalidMemoryType = options.onInvalidMemoryType;
  }

  start(intervalMs: number = MEMORY_CONFIG.maintenanceIntervalMs): void {
    this.stop();
    this.timer = setInterval(() => {
      void this.run().catch((error) => {
        log.warn('Salience decay run failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.activeRuns.clear();
  }

  async run(): Promise<void> {
    const policy = this.resolvePolicy();
    if (this.lastPolicy !== policy) {
      this.trackedAnchors.clear();
      this.lastProcessedRevision = null;
      this.nextTrackedRunAt = 0;
      this.lastPolicy = policy;
    }
    const getRevision = this.memoryStore.getSalienceMaintenanceRevision;
    if (!getRevision) {
      await this.runEager(policy);
      return;
    }

    const revisionBefore = getRevision.call(this.memoryStore);
    const now = Date.now();
    if (this.lastProcessedRevision === revisionBefore && now < this.nextTrackedRunAt) {
      return;
    }

    await this.runTracked(now, revisionBefore, getRevision, policy);
  }

  private resolvePolicy(): MemoryRetrievalPolicy {
    return resolveMemoryRetrievalPolicy(
      typeof this.memoryRetrievalPolicy === 'function'
        ? this.memoryRetrievalPolicy()
        : this.memoryRetrievalPolicy,
    );
  }

  private acceptsMemoryType(memory: PurrMemory): boolean {
    const resolution = resolvePersistedMemoryType(memory.type);
    if (resolution.disposition === 'valid') return true;
    const report: SalienceDecayInvalidMemoryTypeReport = {
      memoryId: memory.id,
      memoryType: resolution.originalType,
      reason: resolution.reason,
    };
    log.warn('Skipped unsupported memory type during salience decay', report);
    this.onInvalidMemoryType?.(report);
    return false;
  }

  private async runEager(policy: MemoryRetrievalPolicy): Promise<void> {
    const runState = {};
    this.activeRuns.add(runState);
    const now = Date.now();

    try {
      let offset = 0;
      for (;;) {
        if (!this.activeRuns.has(runState)) break;
        const memories = await this.memoryStore.listActiveMemories({
          limit: this.batchSize,
          offset,
        });
        if (memories.length === 0 || !this.activeRuns.has(runState)) break;

        const salienceUpdates: Array<{
          id: string;
          salience: number;
          salienceDecayAnchorAt: number;
        }> = [];
        for (const memory of memories) {
          if (!this.acceptsMemoryType(memory)) continue;
          const newSalience = calculateEffectiveMemorySalience(memory, now, policy);

          // Only update if meaningful change
          if (Math.abs(newSalience - memory.salience) > MEANINGFUL_SALIENCE_DELTA) {
            salienceUpdates.push({
              id: memory.id,
              salience: newSalience,
              salienceDecayAnchorAt: now,
            });
          }
        }

        if (salienceUpdates.length > 0) {
          await this.memoryStore.bulkUpdateSalience(salienceUpdates);
        }

        if (!this.activeRuns.has(runState) || memories.length < this.batchSize) break;
        offset += memories.length;
        await yieldToEventLoop();
      }
    } finally {
      this.activeRuns.delete(runState);
    }
  }

  private resolveTrackedAnchor(
    memory: PurrMemory,
    policy: MemoryRetrievalPolicy,
  ): TrackedDecayAnchor | null {
    const profile = getMemoryDecayProfile(memory, policy);
    const halflife = policy.typePolicies[memory.type].halfLifeDays
      * DAY_MS
      * profile.halflifeMultiplier;
    if (!halflife || halflife <= 0) return null;
    const sourceDecayAnchorAt = Number.isFinite(memory.salienceDecayAnchorAt)
      ? memory.salienceDecayAnchorAt!
      : memory.lastAccessed;

    const existing = this.trackedAnchors.get(memory.id);
    if (
      existing
      && existing.sourceLastAccessed === memory.lastAccessed
      && existing.sourceDecayAnchorAt === sourceDecayAnchorAt
      && existing.lastPersistedSalience === memory.salience
      && existing.halflife === halflife
      && existing.salienceFloor === profile.salienceFloor
    ) {
      return existing;
    }

    const created: TrackedDecayAnchor = {
      baseSalience: memory.salience,
      sourceLastAccessed: memory.lastAccessed,
      sourceDecayAnchorAt,
      decayEpoch: sourceDecayAnchorAt,
      lastPersistedSalience: memory.salience,
      halflife,
      salienceFloor: profile.salienceFloor,
    };
    this.trackedAnchors.set(memory.id, created);
    return created;
  }

  private async runTracked(
    now: number,
    revisionBefore: number,
    getRevision: () => number,
    policy: MemoryRetrievalPolicy,
  ): Promise<void> {
    const runState = {};
    this.activeRuns.add(runState);
    const seenIds = new Set<string>();
    let nextRunAt = Number.POSITIVE_INFINITY;
    let expectedOwnRevisionIncrements = 0;
    let completed = false;

    try {
      let offset = 0;
      for (;;) {
        if (!this.activeRuns.has(runState)) break;
        const memories = await this.memoryStore.listActiveMemories({
          limit: this.batchSize,
          offset,
        });
        if (memories.length === 0 || !this.activeRuns.has(runState)) {
          completed = this.activeRuns.has(runState);
          break;
        }

        const salienceUpdates: Array<{
          id: string;
          salience: number;
          salienceDecayAnchorAt: number;
        }> = [];
        const updatedAnchors: TrackedDecayAnchor[] = [];
        for (const memory of memories) {
          seenIds.add(memory.id);
          if (!this.acceptsMemoryType(memory)) continue;
          const anchor = this.resolveTrackedAnchor(memory, policy);
          if (!anchor) continue;
          const newSalience = calculateDecayedSalience(anchor, now);
          const shouldUpdate = Math.abs(newSalience - memory.salience) > MEANINGFUL_SALIENCE_DELTA;
          const persistedSalience = shouldUpdate ? newSalience : memory.salience;
          if (shouldUpdate) {
            salienceUpdates.push({
              id: memory.id,
              salience: newSalience,
              salienceDecayAnchorAt: now,
            });
            updatedAnchors.push(anchor);
          }
          nextRunAt = Math.min(nextRunAt, nextMeaningfulDecayAt({
            ...anchor,
            lastPersistedSalience: persistedSalience,
          }, now));
        }

        if (salienceUpdates.length > 0) {
          const updatedCount = await this.memoryStore.bulkUpdateSalience(salienceUpdates);
          if (updatedCount > 0) expectedOwnRevisionIncrements += 1;
          for (const [index, anchor] of updatedAnchors.entries()) {
            const update = salienceUpdates[index]!;
            anchor.baseSalience = update.salience;
            anchor.sourceDecayAnchorAt = update.salienceDecayAnchorAt;
            anchor.decayEpoch = update.salienceDecayAnchorAt;
            anchor.lastPersistedSalience = update.salience;
          }
        }

        if (!this.activeRuns.has(runState)) break;
        if (memories.length < this.batchSize) {
          completed = true;
          break;
        }
        offset += memories.length;
        await yieldToEventLoop();
      }

      if (!completed) return;
      for (const id of this.trackedAnchors.keys()) {
        if (!seenIds.has(id)) this.trackedAnchors.delete(id);
      }
      const revisionAfter = getRevision.call(this.memoryStore);
      if (revisionAfter !== revisionBefore + expectedOwnRevisionIncrements) {
        this.lastProcessedRevision = null;
        this.nextTrackedRunAt = 0;
        return;
      }
      this.lastProcessedRevision = revisionAfter;
      this.nextTrackedRunAt = nextRunAt;
    } finally {
      this.activeRuns.delete(runState);
    }
  }
}
