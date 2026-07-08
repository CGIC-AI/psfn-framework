import { createComponentLogger } from '../../shared/logger.js';
import type { InferredPostTurnAction, PostTurnActionCandidate, SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { SessionManager } from '../../core/session/manager.js';
import type { NearTurnMemoryCadenceConfig } from '../../system/config/scheduler-config.js';
import type { MemoryStorePort } from './memory-store-port.js';
import { buildStaleMemoryReviewInput } from './maintenance-review.js';

const log = createComponentLogger('NearTurnMemoryLane');

export const NEAR_TURN_MEMORY_ACTION_KIND = 'memory.near-turn.run';

const ONE_HOUR_MS = 3_600_000;
const MAX_STALE_REVIEW_SCAN = 50;
const MAX_STALE_REVIEWS_PER_RUN = 3;

export type NearTurnMemoryScope = 'direct' | 'group';

/**
 * Port over the canonical group-memory topology classifier
 * (ObservedGroupMemoryScheduler.classifyChannelMemoryScope), which resolves
 * memoryMode direct/group/auto plus channel overrides and participant-window
 * auto-detection. The near-turn lane reuses that pipeline rather than growing
 * a parallel direct-vs-group detector.
 */
export interface NearTurnMemoryScopeClassifierPort {
  classifyChannelMemoryScope(
    message: Pick<SubstrateMessage, 'channelId' | 'channelType'>,
  ): Promise<NearTurnMemoryScope>;
}

/**
 * Fire-rate telemetry emitted each time a near-turn maintenance run is
 * inferred for a channel. `firesLastHour` is a rolling per-channel count so
 * Garden can render a fire-rate (runs/hour) without re-aggregating raw events.
 */
export interface NearTurnMemoryCadenceTelemetry {
  channelId: string;
  sessionId: string;
  scope: NearTurnMemoryScope;
  turnCount: number;
  newEntriesSinceLastRun: number;
  firedAtMs: number;
  firesLastHour: number;
}

interface GroupCadenceState {
  lastRunAtMs: number;
  turnCountAtLastRun: number;
}

type NearTurnSessionReader = Pick<SessionManager, 'resolveSessionChannelId'>
  & Partial<Pick<SessionManager, 'isSessionRetiredOrQuarantined'>>;
type NearTurnMaintenanceStore = Pick<
  MemoryStorePort,
  'upsertMemoryMaintenanceReview' | 'listActiveMemories'
>;

export interface NearTurnMemoryLaneOptions {
  sessionManager: NearTurnSessionReader;
  /**
   * JSON-owned cadence (scheduler.json `nearTurnMemory`). Required and
   * validated at construction — the lane fails closed instead of falling back
   * to hardcoded turn counts.
   */
  cadence: NearTurnMemoryCadenceConfig;
  /** Canonical direct-vs-group scope classification; absent => direct scope. */
  scopeClassifier?: NearTurnMemoryScopeClassifierPort | null;
  /** Fire-rate telemetry sink; wired to the runtime event bus by composition. */
  onCadenceTelemetry?: (event: NearTurnMemoryCadenceTelemetry) => void;
  /** Active-memory review refresh target (deterministic, no LLM). */
  memoryMaintenanceStore?: NearTurnMaintenanceStore | null;
}

function assertPositiveInteger(value: number, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`NearTurnMemoryLane cadence.${field} must be an integer >= 1`);
  }
  return value;
}

function validateCadence(cadence: NearTurnMemoryCadenceConfig): NearTurnMemoryCadenceConfig {
  return {
    direct: {
      cadenceTurns: assertPositiveInteger(cadence.direct.cadenceTurns, 'direct.cadenceTurns'),
    },
    group: {
      minIntervalMinutes: assertPositiveInteger(
        cadence.group.minIntervalMinutes,
        'group.minIntervalMinutes',
      ),
      minNewEntries: assertPositiveInteger(cadence.group.minNewEntries, 'group.minNewEntries'),
    },
  };
}

/**
 * Lightweight near-turn memory lane. This lane replaces the old turn-based
 * "sleeptime" cadence and keeps ONLY deterministic near-turn work:
 *
 * - extraction trigger evaluation stays with the extraction pipeline that is
 *   already wired per turn (per-turn extraction and the observed-group
 *   scheduler);
 * - active-memory refresh: queue stale-memory maintenance reviews so the
 *   review surface tracks the live active-memory set;
 * - concern-candidate derivation stays with the intention appraisal post-turn
 *   path.
 *
 * The lane holds no LLM provider — it structurally cannot spend tokens. Heavy
 * passes (sleep consolidation, arc weaving, dream meaning) are unreachable
 * from here; they run only from the rest-window scheduler lane
 * (SleeptimeMemoryAgent). Candidate-episode synthesis runs only through the
 * gated episode-synthesis lane.
 */
export class NearTurnMemoryLane {
  private readonly sessionManager: NearTurnSessionReader;
  private readonly cadence: NearTurnMemoryCadenceConfig;
  private readonly scopeClassifier: NearTurnMemoryScopeClassifierPort | null;
  private readonly onCadenceTelemetry?: (event: NearTurnMemoryCadenceTelemetry) => void;
  private readonly memoryMaintenanceStore: NearTurnMaintenanceStore | null;
  private readonly turnCountBySession = new Map<string, number>();
  private readonly groupStateBySession = new Map<string, GroupCadenceState>();
  private readonly fireTimestampsByChannel = new Map<string, number[]>();

  constructor(options: NearTurnMemoryLaneOptions) {
    this.sessionManager = options.sessionManager;
    this.cadence = validateCadence(options.cadence);
    this.scopeClassifier = options.scopeClassifier ?? null;
    this.onCadenceTelemetry = options.onCadenceTelemetry;
    this.memoryMaintenanceStore = options.memoryMaintenanceStore ?? null;
  }

  async inferPostTurnActions(input: {
    message: Pick<SubstrateMessage, 'id' | 'channelId'>
      & Partial<Pick<SubstrateMessage, 'channelType'>>
      & { timestamp?: Date };
  }): Promise<PostTurnActionCandidate[]> {
    const candidate = await this.inferPostTurnAction(input.message);
    return candidate ? [candidate] : [];
  }

  async inferPostTurnAction(
    message: Pick<SubstrateMessage, 'id' | 'channelId'>
      & Partial<Pick<SubstrateMessage, 'channelType'>>
      & { timestamp?: Date },
  ): Promise<PostTurnActionCandidate | null> {
    if (message.channelId.startsWith('internal:')) {
      return null;
    }

    const sessionId = this.sessionManager.resolveSessionChannelId(message.channelId);
    if (this.sessionManager.isSessionRetiredOrQuarantined?.(sessionId)) return null;
    const nextCount = (this.turnCountBySession.get(sessionId) ?? 0) + 1;
    this.turnCountBySession.set(sessionId, nextCount);
    const firedAtMs = message.timestamp instanceof Date
      ? message.timestamp.getTime()
      : Date.now();

    const scope = await this.resolveMemoryScope(message);
    const decision = scope === 'group'
      ? this.evaluateGroupCadence(sessionId, nextCount, firedAtMs)
      : this.evaluateDirectCadence(nextCount);
    if (!decision.fire) {
      return null;
    }

    this.emitCadenceTelemetry({
      channelId: message.channelId,
      sessionId,
      scope,
      turnCount: nextCount,
      newEntriesSinceLastRun: decision.newEntriesSinceLastRun,
      firedAtMs,
    });

    return {
      kind: NEAR_TURN_MEMORY_ACTION_KIND,
      payload: {
        sessionId,
        sourceChannelId: message.channelId,
        scope,
        cadenceTurn: nextCount,
      },
      dedupeKey: `${NEAR_TURN_MEMORY_ACTION_KIND}:${sessionId}`,
      maxRetries: 1,
    };
  }

  /**
   * Deterministic near-turn maintenance run: refresh the stale-memory review
   * queue over the active-memory set. Never performs LLM calls.
   */
  async execute(action: Pick<InferredPostTurnAction, 'id' | 'channelId' | 'payload'>): Promise<void> {
    const sessionId = this.resolveActionSessionId(action);
    if (this.sessionManager.isSessionRetiredOrQuarantined?.(sessionId)) {
      log.info('Skipping near-turn memory run for retired session', {
        sessionId,
        actionId: action.id,
      });
      return;
    }
    const reviewsQueued = await this.queueStaleMemoryReviews();
    log.debug('Near-turn memory run complete', {
      sessionId,
      actionId: action.id,
      staleReviewsQueued: reviewsQueued,
    });
  }

  /**
   * Resolves direct-vs-group via the injected canonical group-memory
   * classifier (same memoryMode/topology pipeline as group extraction).
   * Without a classifier (or channelType), the historical direct posture
   * applies. If classification fails, the error is logged and the scope
   * degrades to 'group' — the fail-closed direction for background compute:
   * batching fires less.
   */
  private async resolveMemoryScope(
    message: Pick<SubstrateMessage, 'channelId'> & Partial<Pick<SubstrateMessage, 'channelType'>>,
  ): Promise<NearTurnMemoryScope> {
    if (!this.scopeClassifier || !message.channelType) {
      return 'direct';
    }
    try {
      return await this.scopeClassifier.classifyChannelMemoryScope({
        channelId: message.channelId,
        channelType: message.channelType,
      });
    } catch (error) {
      log.warn('Near-turn scope classification failed; batching as group scope', {
        channelId: message.channelId,
        channelType: message.channelType,
        error: String(error),
      });
      return 'group';
    }
  }

  /**
   * Direct (1:1/DM) scope keeps the historical per-N-turns posture: fire on
   * every `cadenceTurns`-th turn (scheduler.json nearTurnMemory.direct).
   */
  private evaluateDirectCadence(
    nextCount: number,
  ): { fire: boolean; newEntriesSinceLastRun: number } {
    if (nextCount % this.cadence.direct.cadenceTurns !== 0) {
      return { fire: false, newEntriesSinceLastRun: 0 };
    }
    return { fire: true, newEntriesSinceLastRun: this.cadence.direct.cadenceTurns };
  }

  /**
   * Group scope uses watermark/interval batching instead of per-N-turns: a
   * run is only eligible once at least `minNewEntries` new turns have
   * accumulated AND at least `minIntervalMinutes` of wall-clock time has
   * elapsed since the last run.
   */
  private evaluateGroupCadence(
    sessionId: string,
    nextCount: number,
    nowMs: number,
  ): { fire: boolean; newEntriesSinceLastRun: number } {
    const state = this.groupStateBySession.get(sessionId)
      ?? { lastRunAtMs: 0, turnCountAtLastRun: 0 };
    const newEntriesSinceLastRun = nextCount - state.turnCountAtLastRun;

    const enoughNewEntries = newEntriesSinceLastRun >= this.cadence.group.minNewEntries;
    const minIntervalMs = this.cadence.group.minIntervalMinutes * 60_000;
    const intervalElapsed = state.lastRunAtMs === 0
      || (nowMs - state.lastRunAtMs) >= minIntervalMs;

    if (!enoughNewEntries || !intervalElapsed) {
      return { fire: false, newEntriesSinceLastRun };
    }

    this.groupStateBySession.set(sessionId, {
      lastRunAtMs: nowMs,
      turnCountAtLastRun: nextCount,
    });
    return { fire: true, newEntriesSinceLastRun };
  }

  private emitCadenceTelemetry(input: Omit<NearTurnMemoryCadenceTelemetry, 'firesLastHour'>): void {
    const firesLastHour = this.recordFireRate(input.channelId, input.firedAtMs);
    if (!this.onCadenceTelemetry) {
      return;
    }
    this.onCadenceTelemetry({
      ...input,
      firesLastHour,
    });
  }

  private recordFireRate(channelId: string, nowMs: number): number {
    const retained = (this.fireTimestampsByChannel.get(channelId) ?? [])
      .filter(timestampMs => nowMs - timestampMs < ONE_HOUR_MS);
    retained.push(nowMs);
    this.fireTimestampsByChannel.set(channelId, retained);
    return retained.length;
  }

  private async queueStaleMemoryReviews(): Promise<number> {
    if (!this.memoryMaintenanceStore?.listActiveMemories || !this.memoryMaintenanceStore.upsertMemoryMaintenanceReview) {
      return 0;
    }
    const memories = await this.memoryMaintenanceStore.listActiveMemories({ limit: MAX_STALE_REVIEW_SCAN });
    let queued = 0;
    for (const memory of memories) {
      if (queued >= MAX_STALE_REVIEWS_PER_RUN) break;
      const review = buildStaleMemoryReviewInput(memory);
      if (!review) continue;
      await this.memoryMaintenanceStore.upsertMemoryMaintenanceReview(review);
      queued += 1;
    }
    return queued;
  }

  private resolveActionSessionId(action: Pick<InferredPostTurnAction, 'channelId' | 'payload'>): string {
    const payloadSession = action.payload['sessionId'];
    if (typeof payloadSession === 'string' && payloadSession.trim().length > 0) {
      return payloadSession.trim();
    }
    return this.sessionManager.resolveSessionChannelId(action.channelId);
  }
}
