import { createHash } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import type { InferredPostTurnAction } from '../../../shared/contracts/runtime.js';
import type { EventBus } from '../../../shared/event-bus.js';
import type { Scheduler } from '../../../core/scheduler/scheduler.js';
import {
  normalizePersistedPostTurnActionPayload,
  PERSISTED_POST_TURN_ACTION_PAYLOAD_VERSION,
} from './post-turn-action-persistence-migration.js';
import {
  POST_TURN_SUBAGENT_SPAWN_ACTION_KIND,
} from '../../../core/agent/post-turn-action-runtime.js';
import {
  buildCompletionHandoffDedupeKey,
  emitCompletionHandoff as emitCompletionHandoffRecord,
  extractOriginIds,
  safeEmitCompletionHandoffError,
  type CompletionHandoffInput,
  type CompletionHandoffStatus,
} from '../../../core/agent/completion-handoff.js';
import type {
  PostTurnActionAgent,
  PostTurnActionCapability,
  PostTurnActionCoalescingMode,
  PostTurnActionHandlerResult,
  PostTurnActionExecutionMode,
  PostTurnActionEnqueueResult,
  PostTurnActionFailureReason,
  PostTurnActionHandler,
  PostTurnActionHandlerOptions,
  PostTurnActionQueueCompletionRecord,
  PostTurnActionQueueCoalescingRecord,
  PostTurnActionQueueDropRecord,
  PostTurnActionQueueFailureRecord,
  PostTurnActionQueuePersistenceLoadState,
  PostTurnActionQueuePersistenceStatus,
  PostTurnActionQueueStatus,
  PostTurnActionQueueTerminalRecord,
  PostTurnActionRuntime,
  PostTurnActionStatusRecord,
  PostTurnActionTerminalReason,
  QuarantinedPersistedQueueEntry,
} from '../../../core/agent/post-turn-action-runtime.js';
import { classifyPostTurnActionContention } from '../../../core/agent/post-turn-action-contention.js';
import {
  POST_TURN_APPRAISAL_RUNTIME_CLASS,
  compareRuntimeLanePriority,
  isRuntimeLaneClass,
  resolveRuntimeLaneBudgetProfile,
  resolveRuntimeLaneClassForPostTurnActionKind,
} from '../../../core/agent/worker-lanes.js';
import {
  RUNTIME_LANE_CLASSES,
  type RuntimeLaneClass,
} from '../../../shared/contracts/runtime-lanes.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { writeJsonAtomic } from '../../../shared/utils/fs.js';
import { isRecord } from '../../../shared/utils/types.js';
import { emitTurnPerformance } from '../../../shared/telemetry/turn-performance.js';
import type {
  EligibilityDecision,
  EligibilityGate,
} from '../../../system/capabilities/eligibility.js';
import {
  advanceDeferredPostTurnQueueEntry,
  buildPostTurnActionQueueStatus,
  coalesceDeferredPostTurnQueueEntry,
  createDeferredPostTurnQueueEntry,
  normalizeDeferredPostTurnQueueProgressState,
  resolveAdmittedPostTurnActionDedupeKeys,
  toPostTurnActionQueuedEntryStatus,
  type DeferredPostTurnQueueEntry as DeferredQueueEntry,
} from './post-turn-action-queue-state.js';

const log = createComponentLogger('PostTurnActions');

export type {
  PostTurnActionAgent,
  PostTurnActionCapability,
  PostTurnActionExecutionMode,
  PostTurnActionEnqueueResult,
  PostTurnActionFailureReason,
  PostTurnActionHandler,
  PostTurnActionHandlerOptions,
  PostTurnActionHandlerResult,
  PostTurnActionQueueCompletionRecord,
  PostTurnActionQueueDropRecord,
  PostTurnActionQueueEntryState,
  PostTurnActionQueueFailureRecord,
  PostTurnActionQueueLaneStatus,
  PostTurnActionQueuePersistenceLoadState,
  PostTurnActionQueuePersistenceStatus,
  PostTurnActionQueueStatus,
  PostTurnActionQueueTerminalRecord,
  PostTurnActionQueuedEntryStatus,
  PostTurnActionRuntime,
  PostTurnActionStatusRecord,
  PostTurnSubagentSpawnPayload,
  PostTurnSubagentSpawnPolicy,
  PostTurnSubagentSpawnQueuedStatus,
  PostTurnSubagentSpawnResultStatus,
  PostTurnActionTerminalReason,
  QuarantinedPersistedQueueEntry,
} from '../../../core/agent/post-turn-action-runtime.js';
export {
  POST_TURN_SUBAGENT_SPAWN_ACTION_KIND,
} from '../../../core/agent/post-turn-action-runtime.js';
interface RegisteredPostTurnActionHandler {
  callback: PostTurnActionHandler;
  executionMode: PostTurnActionExecutionMode;
  runtimeClass: RuntimeLaneClass;
  coalescing?: PostTurnActionCoalescingMode;
}

export interface WirePostTurnActionRuntimeOptions {
  eventBus: EventBus;
  scheduler: Scheduler;
  agentLoop: PostTurnActionAgent;
  eligibilityGate?: EligibilityGate;
  onEligibilityDecision?: (decision: EligibilityDecision) => void;
  taskId?: string;
  intervalMs?: number;
  defaultMaxRetries?: number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  persistencePath?: string;
}

const DEFAULT_TASK_ID = 'post-turn-action-executor';
const PERSISTED_QUEUE_VERSION = 2;
const LEGACY_PERSISTED_QUEUE_VERSION = 1;
const MAX_STATUS_HISTORY = 25;
interface PersistedQueueFile {
  version: number;
  entries: unknown[];
}

export function wirePostTurnActionRuntime(
  options: WirePostTurnActionRuntimeOptions,
): PostTurnActionRuntime {
  const {
    eventBus,
    scheduler,
    agentLoop,
    eligibilityGate,
    onEligibilityDecision,
    taskId = DEFAULT_TASK_ID,
    intervalMs = 250,
    defaultMaxRetries = 2,
    baseRetryDelayMs = 750,
    maxRetryDelayMs = 30_000,
    persistencePath,
  } = options;

  const handlers = new Map<string, Map<PostTurnActionHandler, RegisteredPostTurnActionHandler>>();
  const queue = new Map<string, DeferredQueueEntry>();
  const runningDedupeKeys = new Set<string>();
  const waitingForForegroundIdleDedupeKeys = new Set<string>();
  const recentDrops: PostTurnActionQueueDropRecord[] = [];
  const recentFailures: PostTurnActionQueueFailureRecord[] = [];
  const recentTerminals: PostTurnActionQueueTerminalRecord[] = [];
  const recentCompletions: PostTurnActionQueueCompletionRecord[] = [];
  const recentCoalesces: PostTurnActionQueueCoalescingRecord[] = [];
  const droppedCountsByRuntimeClass = new Map<RuntimeLaneClass, number>();
  let processing = false;
  let droppedCount = 0;
  let failedCount = 0;
  let retryableFailureCount = 0;
  let coalescedCount = 0;
  let cancelledCount = 0;
  let acknowledgedCount = 0;
  let completedCount = 0;
  let lastProgressAt: number | undefined;
  let persistenceLoadState: PostTurnActionQueuePersistenceLoadState = persistencePath
    ? 'not_found'
    : 'not_configured';
  let loadedEntries = 0;
  let lastLoadedAt: number | undefined;
  let lastLoadError: string | undefined;
  let lastPersistedAt: number | undefined;
  let lastPersistError: string | undefined;
  let quarantinedPersistedEntries: QuarantinedPersistedQueueEntry[] = [];
  let quarantinePersisted = true;

  const rememberRecent = <T>(entries: T[], entry: T): void => {
    entries.unshift(entry);
    if (entries.length > MAX_STATUS_HISTORY) {
      entries.length = MAX_STATUS_HISTORY;
    }
  };

  const normalizePositiveInteger = (value: unknown): number | undefined => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return undefined;
    }
    return Math.floor(value);
  };

  const normalizeActionRunAt = (value: unknown): number | undefined => {
    const normalized = normalizePositiveInteger(value);
    if (normalized === undefined || normalized <= 0) {
      return undefined;
    }
    return normalized;
  };

  const normalizeMaxRetries = (value: number | undefined): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return Math.max(0, Math.floor(defaultMaxRetries));
    }
    return Math.max(0, Math.floor(value));
  };

  const resolveInitialNextRunAt = (action: InferredPostTurnAction): number => {
    const now = Date.now();
    const runAt = normalizeActionRunAt(action.runAt);
    if (runAt === undefined) {
      return now;
    }
    return Math.max(now, runAt);
  };

  const resolveActionCapability = (kind: string): PostTurnActionCapability => (
    kind.trim() === POST_TURN_SUBAGENT_SPAWN_ACTION_KIND ? 'subagent_spawn' : 'generic'
  );

  const resolveRuntimeClassForKind = (kind: string): RuntimeLaneClass => {
    if (resolveActionCapability(kind) === 'subagent_spawn') {
      return RUNTIME_LANE_CLASSES.backgroundContinuation;
    }
    return resolveRuntimeLaneClassForPostTurnActionKind(kind);
  };

  const normalizePersistedAction = (value: unknown): InferredPostTurnAction | null => {
    if (!isRecord(value)) {
      return null;
    }

    const id = typeof value.id === 'string' ? value.id.trim() : '';
    const kind = typeof value.kind === 'string' ? value.kind.trim() : '';
    const dedupeKey = typeof value.dedupeKey === 'string' ? value.dedupeKey.trim() : '';
    const channelId = typeof value.channelId === 'string' ? value.channelId.trim() : '';
    const sourceMessageId = typeof value.sourceMessageId === 'string' ? value.sourceMessageId.trim() : '';
    const inferredAt = normalizePositiveInteger(value.inferredAt);
    if (!id || !kind || !dedupeKey || !channelId || !sourceMessageId || inferredAt === undefined) {
      return null;
    }

    const payload = isRecord(value.payload) ? value.payload : {};
    const maxRetries = normalizePositiveInteger(value.maxRetries);
    const runAt = normalizeActionRunAt(value.runAt);

    return {
      id,
      kind,
      payload,
      dedupeKey,
      channelId,
      sourceMessageId,
      inferredAt,
      ...(maxRetries !== undefined ? { maxRetries } : {}),
      ...(runAt !== undefined ? { runAt } : {}),
    };
  };

  const stableStringify = (value: unknown): string => {
    if (value === null) return 'null';
    if (Array.isArray(value)) {
      return `[${value.map(stableStringify).join(',')}]`;
    }
    if (typeof value === 'object') {
      return `{${Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
        .join(',')}}`;
    }
    return JSON.stringify(value);
  };

  const hashRuntimePayload = (payload: Record<string, unknown>): string => (
    createHash('sha256').update(stableStringify(payload)).digest('hex').slice(0, 16)
  );

  const normalizeRuntimeAction = (
    value: unknown,
    event: Record<string, unknown>,
  ): InferredPostTurnAction | null => {
    const normalized = normalizePersistedAction(value);
    if (normalized) {
      return normalized;
    }
    if (!isRecord(value) || !isRecord(event.message)) {
      return null;
    }

    const kind = typeof value.kind === 'string' ? value.kind.trim() : '';
    const channelId = typeof event.message.channelId === 'string' ? event.message.channelId.trim() : '';
    const sourceMessageId = typeof event.message.id === 'string' ? event.message.id.trim() : '';
    if (!kind || !channelId || !sourceMessageId) {
      return null;
    }

    const explicitDedupeKey = Object.hasOwn(value, 'dedupeKey');
    const dedupeKey = typeof value.dedupeKey === 'string' ? value.dedupeKey.trim() : '';
    if (explicitDedupeKey && !dedupeKey) {
      return null;
    }

    const payload = isRecord(value.payload) ? value.payload : {};
    const resolvedDedupeKey = dedupeKey || `${kind}:${channelId}:${hashRuntimePayload(payload)}`;
    const id = typeof value.id === 'string' && value.id.trim()
      ? value.id.trim()
      : createHash('sha256')
        .update(`${sourceMessageId}:${kind}:${resolvedDedupeKey}`)
        .digest('hex')
        .slice(0, 24);
    const maxRetries = normalizePositiveInteger(value.maxRetries);
    const runAt = normalizeActionRunAt(value.runAt);

    return {
      id,
      kind,
      payload,
      dedupeKey: resolvedDedupeKey,
      channelId,
      sourceMessageId,
      inferredAt: Date.now(),
      ...(maxRetries !== undefined ? { maxRetries } : {}),
      ...(runAt !== undefined ? { runAt } : {}),
    };
  };

  const normalizePersistedQueueEntry = (
    value: unknown,
    queueFileVersion: number,
  ): { entry: DeferredQueueEntry; migrated: boolean; requiresRewrite: boolean } | null => {
    if (!isRecord(value)) {
      return null;
    }
    const hasActionPayloadVersion = Object.hasOwn(value, 'actionPayloadVersion');
    const persistedAction = normalizePersistedAction(value.action);
    if (!persistedAction) {
      return null;
    }
    const normalizedPayload = normalizePersistedPostTurnActionPayload({
      action: persistedAction,
      actionPayloadVersion: value.actionPayloadVersion,
      hasActionPayloadVersion,
    });
    if (!normalizedPayload) {
      return null;
    }
    const { action } = normalizedPayload;
    const hasPendingAction = Object.hasOwn(value, 'pendingAction');
    const pendingAction = hasPendingAction
      ? normalizePersistedAction(value.pendingAction)
      : undefined;
    if (hasPendingAction && !pendingAction) {
      return null;
    }

    const attempt = normalizePositiveInteger(value.attempt);
    const nextRunAt = normalizeActionRunAt(value.nextRunAt);
    const maxRetries = normalizePositiveInteger(value.maxRetries);
    if (attempt === undefined || nextRunAt === undefined) {
      return null;
    }

    const resolvedMaxRetries = maxRetries !== undefined
      ? maxRetries
      : normalizeMaxRetries(action.maxRetries);
    if (attempt > resolvedMaxRetries + 1) {
      return null;
    }
    const runtimeClass = typeof value.runtimeClass === 'string' && isRuntimeLaneClass(value.runtimeClass)
      ? value.runtimeClass
      : resolveRuntimeClassForKind(action.kind);
    const progressState = normalizeDeferredPostTurnQueueProgressState({
      value,
      action,
      ...(pendingAction ? { pendingAction } : {}),
      normalizeNonNegativeInteger: normalizePositiveInteger,
    });
    if (!progressState) return null;

    return {
      entry: {
        action,
        ...(pendingAction ? { pendingAction } : {}),
        capability: resolveActionCapability(action.kind),
        runtimeClass,
        attempt,
        nextRunAt,
        maxRetries: resolvedMaxRetries,
        ...progressState,
      },
      migrated: normalizedPayload.migrated,
      requiresRewrite:
        normalizedPayload.requiresRewrite
        || queueFileVersion === LEGACY_PERSISTED_QUEUE_VERSION,
    };
  };

  const persistQueueEntries = (entries: Iterable<DeferredQueueEntry>): void => {
    if (!persistencePath) {
      return;
    }

    const serialized = {
      version: PERSISTED_QUEUE_VERSION,
      entries: [...entries].map((entry) => ({
        actionPayloadVersion: PERSISTED_POST_TURN_ACTION_PAYLOAD_VERSION,
        action: entry.action,
        ...(entry.pendingAction ? { pendingAction: entry.pendingAction } : {}),
        capability: entry.capability,
        runtimeClass: entry.runtimeClass,
        attempt: entry.attempt,
        nextRunAt: entry.nextRunAt,
        maxRetries: entry.maxRetries,
        demandStartedAt: entry.demandStartedAt,
        coverageThroughInferredAt: entry.coverageThroughInferredAt,
        coalescedCount: entry.coalescedCount,
        retryableFailureCount: entry.retryableFailureCount,
      })),
    } satisfies PersistedQueueFile;

    writeJsonAtomic(persistencePath, serialized);
    lastPersistedAt = Date.now();
    lastPersistError = undefined;
  };

  const persistQueue = (): boolean => {
    try {
      persistQueueEntries(queue.values());
      return true;
    } catch (error) {
      lastPersistError = String(error);
      log.error('Failed to persist deferred post-turn action queue', {
        persistencePath,
        error: lastPersistError,
      });
      return false;
    }
  };

  const quarantineSidecarPath = (filePath: string): string => `${filePath}.quarantine`;

  const persistQuarantinedEntries = (
    quarantinedEntries: QuarantinedPersistedQueueEntry[],
  ): boolean => {
    quarantinedPersistedEntries = quarantinedEntries.map((entry) => ({ ...entry }));
    if (!persistencePath) {
      quarantinePersisted = true;
      return true;
    }

    const sidecarPath = quarantineSidecarPath(persistencePath);
    try {
      if (quarantinedEntries.length === 0) {
        if (existsSync(sidecarPath)) {
          unlinkSync(sidecarPath);
        }
        quarantinePersisted = true;
        return true;
      }

      const body = quarantinedEntries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
      writeFileSync(sidecarPath, body, 'utf-8');
      quarantinePersisted = true;
      return true;
    } catch (error) {
      quarantinePersisted = false;
      log.error('Failed to persist deferred post-turn action quarantine sidecar', {
        persistencePath,
        sidecarPath,
        quarantinedEntries: quarantinedEntries.length,
        error: String(error),
      });
      return false;
    }
  };

  const hydrateQueue = (): void => {
    if (!persistencePath || !existsSync(persistencePath)) {
      persistenceLoadState = persistencePath ? 'not_found' : 'not_configured';
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(persistencePath, 'utf-8'));
    } catch (error) {
      persistenceLoadState = 'read_failed';
      lastLoadedAt = Date.now();
      lastLoadError = String(error);
      log.error('Failed to load deferred post-turn action queue; starting empty', {
        persistencePath,
        error: lastLoadError,
      });
      return;
    }

    if (
      !isRecord(parsed)
      || (parsed.version !== PERSISTED_QUEUE_VERSION && parsed.version !== LEGACY_PERSISTED_QUEUE_VERSION)
      || !Array.isArray(parsed.entries)
    ) {
      persistenceLoadState = 'invalid_payload';
      lastLoadedAt = Date.now();
      lastLoadError = 'Deferred post-turn action queue payload is invalid';
      log.error('Deferred post-turn action queue payload is invalid; starting empty', {
        persistencePath,
      });
      return;
    }

    let loaded = 0;
    let migrated = 0;
    let requiresRewrite = false;
    const migratedDedupeKeys = new Set<string>();
    const quarantinedEntries: QuarantinedPersistedQueueEntry[] = [];
    for (const [index, rawEntry] of parsed.entries.entries()) {
      const normalizedEntry = normalizePersistedQueueEntry(rawEntry, parsed.version);
      if (!normalizedEntry) {
        quarantinedEntries.push({
          entryNumber: index + 1,
          error: 'Invalid deferred post-turn action queue entry payload',
          raw: rawEntry,
        });
        continue;
      }
      const { entry } = normalizedEntry;
      if (queue.has(entry.action.dedupeKey)) {
        quarantinedEntries.push({
          entryNumber: index + 1,
          error: `Duplicate deferred post-turn action dedupe key "${entry.action.dedupeKey}"`,
          raw: rawEntry,
        });
        continue;
      }
      queue.set(entry.action.dedupeKey, entry);
      coalescedCount += entry.coalescedCount;
      retryableFailureCount += entry.retryableFailureCount;
      loaded += 1;
      if (normalizedEntry.migrated) {
        migrated += 1;
        migratedDedupeKeys.add(entry.action.dedupeKey);
      }
      if (normalizedEntry.requiresRewrite) {
        requiresRewrite = true;
      }
    }
    persistenceLoadState = 'loaded';
    lastLoadedAt = Date.now();
    lastLoadError = undefined;
    const quarantineWriteSucceeded = persistQuarantinedEntries(quarantinedEntries);
    if (quarantinedEntries.length > 0) {
      log.warn('Quarantined deferred post-turn action queue entries during load', {
        persistencePath,
        quarantined: quarantinedEntries.length,
        loaded,
      });
    }
    const rewriteRequired = quarantinedEntries.length > 0 || requiresRewrite;
    const rewriteSucceeded = !rewriteRequired
      || (quarantineWriteSucceeded && persistQueue());
    if (!rewriteSucceeded && migratedDedupeKeys.size > 0) {
      for (const dedupeKey of migratedDedupeKeys) {
        queue.delete(dedupeKey);
      }
      loaded -= migratedDedupeKeys.size;
      lastLoadError = 'Failed to durably migrate legacy personal-project post-turn actions; left them on disk for retry';
      log.error('Deferred post-turn action migration was not exposed because its rewrite failed', {
        persistencePath,
        migrated,
        error: lastPersistError ?? 'quarantine sidecar persistence failed',
      });
    } else if (migrated > 0) {
      log.info('Migrated legacy personal-project post-turn actions during queue hydration', {
        persistencePath,
        migrated,
        fromVersion: 'unversioned',
        toVersion: PERSISTED_POST_TURN_ACTION_PAYLOAD_VERSION,
      });
    }
    loadedEntries = loaded;
    if (loaded > 0) {
      log.info('Loaded deferred post-turn action queue from disk', {
        persistencePath,
        loaded,
      });
    }
  };

  const emitTelemetry = (
    phase:
      | 'queued'
      | 'coalesced'
      | 'deduplicated'
      | 'started'
      | 'succeeded'
      | 'rescheduled'
      | 'retry_scheduled'
      | 'failed'
      | 'dropped_budget'
      | 'cancelled'
      | 'acknowledged'
      | 'malformed_dropped',
    entry: DeferredQueueEntry,
    optionsOverride: { nextRetryAt?: number; delayMs?: number; error?: string } = {},
  ): void => {
    const maxAttempts = entry.maxRetries + 1;
    const runtimeProfile = resolveRuntimeLaneBudgetProfile(entry.runtimeClass);
    const timestamp = Date.now();
    const backgroundJobAgeMs = Math.max(0, timestamp - entry.demandStartedAt);
    eventBus.emit('agent.post_turn.action.telemetry', {
      actionId: entry.action.id,
      actionKind: entry.action.kind,
      channelId: entry.action.channelId,
      sourceMessageId: entry.action.sourceMessageId,
      dedupeKey: entry.action.dedupeKey,
      capability: entry.capability,
      runtimeClass: entry.runtimeClass,
      chargeLane: runtimeProfile.chargeLane,
      phase,
      attempt: entry.attempt,
      maxAttempts,
      queueDepth: queue.size,
      timestamp,
      ...(optionsOverride.nextRetryAt !== undefined ? { nextRetryAt: optionsOverride.nextRetryAt } : {}),
      ...(optionsOverride.delayMs !== undefined ? { delayMs: optionsOverride.delayMs } : {}),
      ...(optionsOverride.error !== undefined ? { error: optionsOverride.error } : {}),
    }).catch((error) => {
      log.warn('Deferred action telemetry emit failed', {
        actionId: entry.action.id,
        phase,
        error: String(error),
      });
    });
    void emitTurnPerformance(eventBus, {
      traceId: entry.action.sourceMessageId || entry.action.id,
      ...(entry.action.sourceMessageId ? { requestId: entry.action.sourceMessageId } : {}),
      channelId: entry.action.channelId,
      stage: 'background_job_state',
      durationMs: backgroundJobAgeMs,
      backgroundJobAgeMs,
      queueDepth: queue.size,
      backgroundContention: queue.size > 0,
      deferReason: phase,
      timestampMs: timestamp,
    }).catch((error) => {
      log.warn('Deferred action performance telemetry emit failed', {
        actionId: entry.action.id,
        phase,
        error: String(error),
      });
    });
  };

  const emitCompletionHandoff = (
    entry: DeferredQueueEntry,
    status: CompletionHandoffStatus,
    input: {
      summary: string;
      validationPerformed: string[];
      recommendedNextAction: string;
      blocker?: { reason: string; error?: string };
      partialResult?: boolean;
      subagentSpawn?: PostTurnActionHandlerResult['subagentSpawn'];
      lifecycleSequence?: string;
    },
  ): void => {
    const originIds = extractOriginIds(entry.action.payload);
    const subagentId = input.subagentSpawn?.subagentId;
    const subagentOutputRefs: CompletionHandoffInput['outputRefs'] = subagentId
      ? [{
          kind: 'subagent_result',
          ref: subagentId,
          ...(input.subagentSpawn?.name ? { label: input.subagentSpawn.name } : {}),
        }]
      : [];
    const handoff: CompletionHandoffInput = {
      source: 'post_turn_action',
      taskId: entry.action.id,
      taskLabel: entry.action.kind,
      ...(subagentId ? { subagentId } : {}),
      status,
      resultSummary: input.summary,
      outputRefs: [
        { kind: 'post_turn_action', ref: entry.action.id, label: entry.action.kind },
        { kind: 'dedupe_key', ref: entry.action.dedupeKey },
        ...subagentOutputRefs,
      ],
      validationPerformed: input.validationPerformed,
      ...(input.blocker ? { blocker: input.blocker } : {}),
      partialResult: input.partialResult ?? false,
      recommendedNextAction: input.recommendedNextAction,
      origin: {
        ...originIds,
        sourceChannelId: entry.action.channelId,
        sourceMessageId: entry.action.sourceMessageId,
        requestId: entry.action.sourceMessageId,
      },
      dedupeKey: buildCompletionHandoffDedupeKey([
        'post_turn_action',
        entry.action.id,
        entry.action.dedupeKey,
        status,
        input.blocker?.reason,
        input.lifecycleSequence,
      ]),
    };
    // Telemetry/journal record only. Deferred post-turn actions are runtime
    // bookkeeping: they must never write into session transcripts and never
    // surface companion-facing notices (subagent/shard results arrive through
    // their own faculties).
    emitCompletionHandoffRecord({
      eventBus,
      targetChannelId: entry.action.channelId,
      handoff,
    }).catch((error) => {
      log.warn('Deferred action completion handoff failed', {
        actionId: entry.action.id,
        actionKind: entry.action.kind,
        error: safeEmitCompletionHandoffError(error),
      });
    });
  };

  const recordDrop = (
    entry: DeferredQueueEntry,
    reason: string,
  ): void => {
    const runtimeProfile = resolveRuntimeLaneBudgetProfile(entry.runtimeClass);
    const droppedAt = Date.now();
    lastProgressAt = droppedAt;
    droppedCount += 1;
    droppedCountsByRuntimeClass.set(
      entry.runtimeClass,
      (droppedCountsByRuntimeClass.get(entry.runtimeClass) ?? 0) + 1,
    );
    rememberRecent(recentDrops, {
      actionId: entry.action.id,
      actionKind: entry.action.kind,
      dedupeKey: entry.action.dedupeKey,
      runtimeClass: entry.runtimeClass,
      reason,
      droppedAt,
      queueDepth: queue.size,
      maxQueuedActions: runtimeProfile.maxQueuedActions,
      backPressureMode: runtimeProfile.degradationMode,
    });
    emitCompletionHandoff(entry, 'blocked', {
      summary: `Post-turn action "${entry.action.kind}" was dropped before running.`,
      validationPerformed: ['runtime_lane_budget', 'post_turn_action_not_executed'],
      blocker: { reason: 'dropped_budget', error: reason },
      recommendedNextAction: 'Decide whether to requeue a narrower action or ignore the stale work before notifying any partner.',
    });
  };

  const recordFailure = (
    entry: DeferredQueueEntry,
    reason: PostTurnActionFailureReason,
    error: string,
  ): void => {
    const failedAt = Date.now();
    lastProgressAt = failedAt;
    failedCount += 1;
    rememberRecent(recentFailures, {
      actionId: entry.action.id,
      actionKind: entry.action.kind,
      dedupeKey: entry.action.dedupeKey,
      capability: entry.capability,
      runtimeClass: entry.runtimeClass,
      reason,
      failedAt,
      attempt: entry.attempt,
      maxAttempts: entry.maxRetries + 1,
      error,
    });
    emitCompletionHandoff(entry, reason === 'eligibility_denied' ? 'blocked' : 'failed', {
      summary: `Post-turn action "${entry.action.kind}" did not complete.`,
      validationPerformed: ['post_turn_action_terminal_failure', reason],
      blocker: { reason, error },
      recommendedNextAction: 'Review the failure and decide whether to retry, narrow scope, or produce a companion-authored status.',
    });
  };

  const recordMalformedAction = (raw: unknown, error: string): void => {
    const failedAt = Date.now();
    failedCount += 1;
    rememberRecent(recentFailures, {
      actionId: 'malformed',
      actionKind: 'malformed',
      dedupeKey: `malformed:${failedAt}:${failedCount}`,
      capability: 'generic',
      runtimeClass: POST_TURN_APPRAISAL_RUNTIME_CLASS,
      reason: 'malformed_action',
      failedAt,
      attempt: 0,
      maxAttempts: 0,
      error,
    });
    eventBus.emit('agent.post_turn.action.telemetry', {
      actionId: 'malformed',
      actionKind: 'malformed',
      dedupeKey: `malformed:${failedAt}:${failedCount}`,
      capability: 'generic',
      runtimeClass: POST_TURN_APPRAISAL_RUNTIME_CLASS,
      chargeLane: resolveRuntimeLaneBudgetProfile(POST_TURN_APPRAISAL_RUNTIME_CLASS).chargeLane,
      phase: 'malformed_dropped',
      attempt: 0,
      maxAttempts: 0,
      queueDepth: queue.size,
      timestamp: failedAt,
      error,
      rawType: Array.isArray(raw) ? 'array' : typeof raw,
    }).catch((emitError) => {
      log.warn('Malformed deferred action telemetry emit failed', {
        error: String(emitError),
      });
    });
  };

  const recordTerminal = (
    entry: DeferredQueueEntry,
    reason: PostTurnActionTerminalReason,
    detail: string,
  ): void => {
    const recordedAt = Date.now();
    lastProgressAt = recordedAt;
    if (reason === 'cancelled') {
      cancelledCount += 1;
    } else {
      acknowledgedCount += 1;
    }
    rememberRecent(recentTerminals, {
      actionId: entry.action.id,
      actionKind: entry.action.kind,
      dedupeKey: entry.action.dedupeKey,
      capability: entry.capability,
      runtimeClass: entry.runtimeClass,
      reason,
      recordedAt,
      attempt: entry.attempt,
      maxAttempts: entry.maxRetries + 1,
      detail,
    });
    emitCompletionHandoff(entry, reason === 'cancelled' ? 'cancelled' : 'blocked', {
      summary: `Post-turn action "${entry.action.kind}" was ${reason}.`,
      validationPerformed: ['post_turn_action_terminal', reason],
      blocker: { reason, error: detail },
      recommendedNextAction: 'Decide whether any replacement action is needed; do not send raw action text as a partner update.',
    });
  };

  const recordCompletion = (
    entry: DeferredQueueEntry,
    result: PostTurnActionHandlerResult | undefined,
  ): void => {
    const completedAt = Date.now();
    lastProgressAt = completedAt;
    completedCount += 1;
    rememberRecent(recentCompletions, {
      actionId: entry.action.id,
      actionKind: entry.action.kind,
      dedupeKey: entry.action.dedupeKey,
      capability: entry.capability,
      runtimeClass: entry.runtimeClass,
      completedAt,
      attempt: entry.attempt,
      maxAttempts: entry.maxRetries + 1,
      detail: result?.detail?.trim() || 'succeeded',
      ...(result?.subagentSpawn ? { subagentSpawn: { ...result.subagentSpawn } } : {}),
    });
    emitCompletionHandoff(entry, 'completed', {
      summary: result?.detail?.trim() || `Post-turn action "${entry.action.kind}" succeeded.`,
      validationPerformed: [
        'post_turn_action_handler_completed',
        ...(result?.subagentSpawn ? ['subagent_spawn_result_recorded'] : []),
      ],
      subagentSpawn: result?.subagentSpawn,
      recommendedNextAction: 'Review the internal action result and decide the next companion-authored step.',
    });
  };

  const findQueuedEntry = (actionRef: string): DeferredQueueEntry | undefined => {
    const normalizedRef = actionRef.trim();
    if (!normalizedRef) {
      return undefined;
    }
    const byDedupeKey = queue.get(normalizedRef);
    if (byDedupeKey) {
      return byDedupeKey;
    }
    return [...queue.values()].find((entry) => entry.action.id === normalizedRef);
  };

  const resolveCoalescingMode = (kind: string): PostTurnActionCoalescingMode | undefined => {
    const registrations = handlers.get(kind);
    if (!registrations) return undefined;
    return [...registrations.values()].find((registration) => registration.coalescing)?.coalescing;
  };

  const recordCoalescing = (
    retainedEntry: DeferredQueueEntry,
    incomingAction: InferredPostTurnAction,
    retainedActionId: string,
    successorPending: boolean,
  ): void => {
    coalescedCount += 1;
    rememberRecent(recentCoalesces, {
      dedupeKey: retainedEntry.action.dedupeKey,
      actionKind: retainedEntry.action.kind,
      retainedActionId,
      coalescedActionId: incomingAction.id,
      coverageThroughInferredAt: retainedEntry.coverageThroughInferredAt,
      coalescedAt: Date.now(),
      successorPending,
    });
    emitTelemetry('coalesced', retainedEntry);
  };

  const coalesceQueueAction = (
    existing: DeferredQueueEntry,
    incomingAction: InferredPostTurnAction,
  ): PostTurnActionEnqueueResult => {
    if (
      incomingAction.id === existing.action.id
      || incomingAction.id === existing.pendingAction?.id
    ) {
      emitTelemetry('deduplicated', existing);
      return 'deduplicated';
    }

    const currentRunMustFinish = runningDedupeKeys.has(existing.action.dedupeKey)
      || Boolean(existing.pendingAction);
    const { entry: nextEntry, successorPending } = coalesceDeferredPostTurnQueueEntry({
      existing,
      incomingAction,
      currentRunMustFinish,
      incomingNextRunAt: resolveInitialNextRunAt(incomingAction),
      incomingMaxRetries: normalizeMaxRetries(incomingAction.maxRetries),
    });
    const candidateQueue = new Map(queue);
    candidateQueue.set(existing.action.dedupeKey, nextEntry);
    try {
      persistQueueEntries(candidateQueue.values());
    } catch (error) {
      lastPersistError = String(error);
      log.error('Failed to persist coalesced post-turn action demand', {
        actionId: incomingAction.id,
        dedupeKey: incomingAction.dedupeKey,
        error: lastPersistError,
      });
      throw error;
    }
    queue.set(existing.action.dedupeKey, nextEntry);
    recordCoalescing(nextEntry, incomingAction, existing.action.id, successorPending);
    return 'coalesced';
  };

  const completeQueuedActionWithoutRunning = (
    actionRef: string,
    reason: PostTurnActionTerminalReason,
    detail = reason,
  ): boolean => {
    const entry = findQueuedEntry(actionRef);
    if (!entry || runningDedupeKeys.has(entry.action.dedupeKey)) {
      return false;
    }
    queue.delete(entry.action.dedupeKey);
    persistQueue();
    recordTerminal(entry, reason, detail.trim() || reason);
    emitTelemetry(reason, entry, { error: detail.trim() || reason });
    return true;
  };

  const queueAction = (action: InferredPostTurnAction): PostTurnActionEnqueueResult => {
    const existing = queue.get(action.dedupeKey);
    if (existing) {
      if (existing.action.kind !== action.kind) {
        throw new Error(
          `Post-turn action dedupe key collision between "${existing.action.kind}" and "${action.kind}"`,
        );
      }
      if (resolveCoalescingMode(action.kind) === 'dedupe_key_with_durable_watermark') {
        return coalesceQueueAction(existing, action);
      }
      emitTelemetry('deduplicated', existing);
      return 'deduplicated';
    }

    const entry = createDeferredPostTurnQueueEntry(action, {
      capability: resolveActionCapability(action.kind),
      runtimeClass: resolveRuntimeClassForKind(action.kind),
      nextRunAt: resolveInitialNextRunAt(action),
      maxRetries: normalizeMaxRetries(action.maxRetries),
    });
    const candidateQueue = new Map(queue);
    candidateQueue.set(action.dedupeKey, entry);
    const runtimeProfile = resolveRuntimeLaneBudgetProfile(entry.runtimeClass);
    const sameClassEntries = [...candidateQueue.values()]
      .filter((candidate) => candidate.runtimeClass === entry.runtimeClass)
      .sort((left, right) => left.demandStartedAt - right.demandStartedAt || left.nextRunAt - right.nextRunAt);
    const overflow = Math.max(0, sameClassEntries.length - runtimeProfile.maxQueuedActions);
    // defer_until_idle is a durable-demand contract. Its capacity bounds the
    // runnable admission window below; it must never delete valid demand.
    const droppedEntries = overflow > 0 && runtimeProfile.degradationMode !== 'defer_until_idle'
      ? sameClassEntries.slice(-overflow)
      : [];
    if (overflow > 0) {
      for (const droppedEntry of droppedEntries) {
        candidateQueue.delete(droppedEntry.action.dedupeKey);
      }
    }
    try {
      // Persist the complete candidate state before making it observable in
      // memory. A direct producer can therefore retry or recover its durable
      // intent when this write fails.
      persistQueueEntries(candidateQueue.values());
    } catch (error) {
      lastPersistError = String(error);
      log.error('Failed to persist deferred post-turn action queue before enqueue', {
        persistencePath,
        actionId: action.id,
        error: lastPersistError,
      });
      throw error;
    }
    queue.clear();
    for (const [dedupeKey, candidate] of candidateQueue) {
      queue.set(dedupeKey, candidate);
    }
    for (const droppedEntry of droppedEntries) {
      const reason = `Runtime class queue budget exhausted for ${droppedEntry.runtimeClass}`;
      log.warn(`Post-turn action "${droppedEntry.action.id}" dropped by runtime lane queue budget`, {
        actionId: droppedEntry.action.id,
        actionKind: droppedEntry.action.kind,
        runtimeClass: droppedEntry.runtimeClass,
        error: reason,
      });
      recordDrop(droppedEntry, reason);
      emitTelemetry('dropped_budget', droppedEntry, {
        error: reason,
      });
    }
    if (queue.has(entry.action.dedupeKey)) {
      emitTelemetry('queued', entry);
      return 'queued';
    }
    return 'dropped_budget';
  };

  const persistRunningCheckpoint = (entry: DeferredQueueEntry): void => {
    const liveEntry = queue.get(entry.action.dedupeKey) ?? entry;
    queue.set(entry.action.dedupeKey, {
      ...liveEntry,
      action: entry.action,
      attempt: entry.attempt,
      nextRunAt: entry.nextRunAt,
      maxRetries: entry.maxRetries,
      retryableFailureCount: entry.retryableFailureCount,
    });
    persistQueue();
  };

  const advancePastFinishedAction = (entry: DeferredQueueEntry): boolean => {
    const liveEntry = queue.get(entry.action.dedupeKey);
    const successor = liveEntry?.pendingAction;
    if (!liveEntry || !successor) {
      queue.delete(entry.action.dedupeKey);
      persistQueue();
      return false;
    }
    queue.set(entry.action.dedupeKey, advanceDeferredPostTurnQueueEntry(liveEntry, successor, {
      capability: resolveActionCapability(successor.kind),
      runtimeClass: resolveRuntimeClassForKind(successor.kind),
      nextRunAt: resolveInitialNextRunAt(successor),
      maxRetries: normalizeMaxRetries(successor.maxRetries),
    }));
    persistQueue();
    return true;
  };

  const runNextDueAction = async (
    classRunCounts: Partial<Record<RuntimeLaneClass, number>>,
  ): Promise<boolean> => {
    if (queue.size === 0) {
      return false;
    }

    const now = Date.now();
    const admittedDedupeKeys = resolveAdmittedPostTurnActionDedupeKeys(queue.values());

    const dueEntries = [...queue.values()]
      .filter((entry) => admittedDedupeKeys.has(entry.action.dedupeKey))
      .filter((entry) => entry.nextRunAt <= now)
      .filter((entry) => {
        const classRuns = classRunCounts[entry.runtimeClass] ?? 0;
        return classRuns < resolveRuntimeLaneBudgetProfile(entry.runtimeClass).maxRunsPerSchedulerTick;
      })
      .sort((left, right) => (
        compareRuntimeLanePriority(left.runtimeClass, right.runtimeClass)
        || left.nextRunAt - right.nextRunAt
        || left.demandStartedAt - right.demandStartedAt
      ));
    const entry = dueEntries[0] as typeof dueEntries[number] | undefined;
    if (!entry) {
      return false;
    }
    classRunCounts[entry.runtimeClass] = (classRunCounts[entry.runtimeClass] ?? 0) + 1;

    const registrations = handlers.get(entry.action.kind);
    if (!registrations || registrations.size === 0) {
      queue.delete(entry.action.dedupeKey);
      persistQueue();
      const missingHandlerError = `No deferred-action handler registered for "${entry.action.kind}"`;
      log.warn(missingHandlerError, {
        actionId: entry.action.id,
        channelId: entry.action.channelId,
      });
      recordFailure(entry, 'missing_handler', missingHandlerError);
      emitTelemetry('failed', entry, { error: missingHandlerError });
      return true;
    }

    if (eligibilityGate) {
      const decision = eligibilityGate.evaluate(
        {
          kind: 'post_turn.action',
          actionKind: entry.action.kind,
          actionId: entry.action.id,
        },
        { requiredTokens: ['memory.write'] },
      );
      onEligibilityDecision?.(decision);
      if (!decision.allowed) {
        queue.delete(entry.action.dedupeKey);
        persistQueue();
        const denialError = `Eligibility denied (${decision.reasonCode})`;
        log.warn('Deferred action blocked by eligibility gate', {
          actionId: entry.action.id,
          actionKind: entry.action.kind,
          reasonCode: decision.reasonCode,
          tier: decision.tier,
          requiredTokens: decision.requiredTokens,
          missingTokens: decision.missingTokens,
        });
        recordFailure(entry, 'eligibility_denied', denialError);
        emitTelemetry('failed', entry, { error: denialError });
        return true;
      }
    }

    entry.attempt += 1;
    runningDedupeKeys.add(entry.action.dedupeKey);
    persistRunningCheckpoint(entry);
    emitTelemetry('started', entry);
    emitCompletionHandoff(entry, 'started', {
      summary: `Post-turn action "${entry.action.kind}" started.`,
      validationPerformed: ['post_turn_action_lifecycle_nonterminal', `attempt:${entry.attempt}`],
      recommendedNextAction: 'Keep the task visible without interrupting the foreground conversation.',
      lifecycleSequence: `attempt:${entry.attempt}`,
    });

    try {
      const registeredHandlers = [...registrations.values()];
      // Foreground-idle overlap is owned solely by the lane profile
      // (RuntimeLaneBudgetProfile.requiresForegroundIdle in worker-lanes.ts),
      // resolved from the queued action's runtime class. executionMode is a
      // handler self-declaration checked at registration time and must never
      // drive this decision (Law 12.4 single-home).
      const requiresForegroundIdle = resolveRuntimeLaneBudgetProfile(
        entry.runtimeClass,
      ).requiresForegroundIdle;
      if (requiresForegroundIdle && agentLoop.waitForIdle) {
        waitingForForegroundIdleDedupeKeys.add(entry.action.dedupeKey);
        try {
          await agentLoop.waitForIdle();
        } finally {
          waitingForForegroundIdleDedupeKeys.delete(entry.action.dedupeKey);
        }
      }
      let handlerResult: PostTurnActionHandlerResult | undefined;
      for (const { callback } of registeredHandlers) {
        const result = await callback(entry.action);
        if (result) {
          handlerResult = result;
        }
        if (typeof result?.rescheduleAt === 'number') {
          break;
        }
      }
      if (typeof handlerResult?.rescheduleAt === 'number') {
        const rescheduleAt = normalizeActionRunAt(handlerResult.rescheduleAt);
        if (rescheduleAt === undefined || rescheduleAt <= Date.now()) {
          throw new Error(`Deferred action handler returned invalid rescheduleAt for "${entry.action.kind}"`);
        }
        entry.attempt = Math.max(0, entry.attempt - 1);
        entry.nextRunAt = rescheduleAt;
        persistRunningCheckpoint(entry);
        const delayMs = Math.max(1, rescheduleAt - Date.now());
        log.info('Deferred action rescheduled by handler', {
          actionId: entry.action.id,
          actionKind: entry.action.kind,
          nextRunAt: entry.nextRunAt,
          delayMs,
          detail: handlerResult.detail,
        });
        emitTelemetry('rescheduled', entry, {
          delayMs,
          nextRetryAt: entry.nextRunAt,
          ...(handlerResult.detail ? { error: handlerResult.detail } : {}),
        });
        emitCompletionHandoff(entry, 'progress', {
          summary: `Post-turn action "${entry.action.kind}" is waiting to resume.`,
          validationPerformed: ['post_turn_action_lifecycle_nonterminal', 'handler_rescheduled'],
          recommendedNextAction: 'Keep the task visible while the policy-controlled delay elapses.',
          partialResult: true,
          lifecycleSequence: `rescheduled:${entry.attempt}:${entry.nextRunAt}`,
        });
        return true;
      }
      recordCompletion(entry, handlerResult);
      advancePastFinishedAction(entry);
      emitTelemetry('succeeded', entry);
    } catch (error) {
      const errorText = String(error);
      const contentionKind = classifyPostTurnActionContention(error);
      if (contentionKind) {
        entry.attempt = Math.max(0, entry.attempt - 1);
        const delayMs = Math.max(1, Math.min(maxRetryDelayMs, baseRetryDelayMs));
        entry.nextRunAt = Date.now() + delayMs;
        persistRunningCheckpoint(entry);
        log.info('Deferred action rescheduled after runtime contention', {
          actionId: entry.action.id,
          actionKind: entry.action.kind,
          contentionKind,
          nextRunAt: entry.nextRunAt,
          delayMs,
          error: errorText,
        });
        emitTelemetry('rescheduled', entry, {
          error: errorText,
          delayMs,
          nextRetryAt: entry.nextRunAt,
        });
        emitCompletionHandoff(entry, 'progress', {
          summary: `Post-turn action "${entry.action.kind}" met runtime contention and is waiting to resume.`,
          validationPerformed: ['post_turn_action_lifecycle_nonterminal', contentionKind],
          recommendedNextAction: 'Keep the task visible while higher-priority work completes.',
          partialResult: true,
          lifecycleSequence: `contended:${contentionKind}:${entry.attempt}:${entry.nextRunAt}`,
        });
        return true;
      }
      if (entry.attempt > entry.maxRetries) {
        log.error('Deferred action exhausted retries', {
          actionId: entry.action.id,
          actionKind: entry.action.kind,
          attempt: entry.attempt,
          maxRetries: entry.maxRetries,
          error: errorText,
        });
        recordFailure(entry, 'retries_exhausted', errorText);
        advancePastFinishedAction(entry);
        emitTelemetry('failed', entry, { error: errorText });
        return true;
      }

      const delayMs = Math.min(maxRetryDelayMs, baseRetryDelayMs * Math.pow(2, Math.max(0, entry.attempt - 1)));
      entry.nextRunAt = Date.now() + delayMs;
      entry.retryableFailureCount += 1;
      retryableFailureCount += 1;
      persistRunningCheckpoint(entry);
      log.warn('Deferred action retry scheduled', {
        actionId: entry.action.id,
        actionKind: entry.action.kind,
        attempt: entry.attempt,
        nextRunAt: entry.nextRunAt,
        delayMs,
        error: errorText,
      });
      emitTelemetry('retry_scheduled', entry, {
        error: errorText,
        delayMs,
        nextRetryAt: entry.nextRunAt,
      });
      emitCompletionHandoff(entry, 'progress', {
        summary: `Post-turn action "${entry.action.kind}" is scheduled for retry.`,
        validationPerformed: ['post_turn_action_lifecycle_nonterminal', 'retry_scheduled'],
        recommendedNextAction: 'Keep the task visible while the bounded retry delay elapses.',
        partialResult: true,
        lifecycleSequence: `retry:${entry.attempt}:${entry.nextRunAt}`,
      });
    } finally {
      runningDedupeKeys.delete(entry.action.dedupeKey);
    }

    return true;
  };

  const processQueue = async (): Promise<void> => {
    if (processing) return;
    processing = true;
    try {
      const classRunCounts: Partial<Record<RuntimeLaneClass, number>> = {};
      while (await runNextDueAction(classRunCounts)) {
        // Continue draining due actions in a single scheduler tick.
      }
    } finally {
      processing = false;
    }
  };

  const getStatus = (): PostTurnActionQueueStatus => {
    const now = Date.now();
    const persistenceStatus: PostTurnActionQueuePersistenceStatus = {
      enabled: Boolean(persistencePath),
      loadState: persistenceLoadState,
      loadedEntries,
      quarantinedEntries: quarantinedPersistedEntries.length,
      quarantinePersisted,
    };
    if (persistencePath) {
      persistenceStatus.path = persistencePath;
      persistenceStatus.quarantinePath = quarantineSidecarPath(persistencePath);
    }
    if (lastLoadedAt !== undefined) {
      persistenceStatus.lastLoadedAt = lastLoadedAt;
    }
    if (lastLoadError !== undefined) {
      persistenceStatus.lastLoadError = lastLoadError;
    }
    if (lastPersistedAt !== undefined) {
      persistenceStatus.lastPersistedAt = lastPersistedAt;
    }
    if (lastPersistError !== undefined) {
      persistenceStatus.lastPersistError = lastPersistError;
    }

    return buildPostTurnActionQueueStatus({
      entries: queue.values(),
      runningDedupeKeys,
      waitingForForegroundIdleDedupeKeys,
      expectedSchedulerRunIntervalMs: scheduler.getTask(taskId)?.intervalMs ?? intervalMs,
      now,
      processing,
      droppedCountsByRuntimeClass,
      droppedCount,
      recentDrops,
      failedCount,
      retryableFailureCount,
      recentFailures,
      coalescedCount,
      recentCoalesces,
      cancelledCount,
      acknowledgedCount,
      recentTerminals,
      completedCount,
      recentCompletions,
      ...(lastProgressAt !== undefined ? { lastProgressAt } : {}),
      quarantinedEntries: quarantinedPersistedEntries,
      quarantinePersisted,
      persistence: persistenceStatus,
    });
  };

  const matchesActionRef = (
    record: { actionId: string; dedupeKey: string },
    normalizedRef: string,
  ): boolean => (
    record.actionId === normalizedRef || record.dedupeKey === normalizedRef
  );

  const getActionStatus = (actionRef: string): PostTurnActionStatusRecord | undefined => {
    const normalizedRef = actionRef.trim();
    if (!normalizedRef) {
      return undefined;
    }

    const queuedEntry = findQueuedEntry(normalizedRef);
    if (queuedEntry) {
      const now = Date.now();
      const queued = toPostTurnActionQueuedEntryStatus(
        queuedEntry,
        now,
        resolveAdmittedPostTurnActionDedupeKeys(queue.values()),
        runningDedupeKeys,
      );
      const status: PostTurnActionStatusRecord = {
        actionId: queued.actionId,
        actionKind: queued.actionKind,
        dedupeKey: queued.dedupeKey,
        capability: queued.capability,
        runtimeClass: queued.runtimeClass,
        state: queued.state,
        cancellable: queued.cancellable,
        attempt: queued.attempt,
        maxAttempts: queued.maxAttempts,
        updatedAt: now,
        nextRunAt: queued.nextRunAt,
        queuedForMs: queued.queuedForMs,
        runAfterMs: queued.runAfterMs,
      };
      if (queued.subagentSpawn) {
        status.queuedSubagentSpawn = { ...queued.subagentSpawn };
      }
      return status;
    }

    const completion = recentCompletions.find((record) => matchesActionRef(record, normalizedRef));
    if (completion) {
      return {
        actionId: completion.actionId,
        actionKind: completion.actionKind,
        dedupeKey: completion.dedupeKey,
        capability: completion.capability,
        runtimeClass: completion.runtimeClass,
        state: 'succeeded',
        cancellable: false,
        attempt: completion.attempt,
        maxAttempts: completion.maxAttempts,
        updatedAt: completion.completedAt,
        detail: completion.detail,
        ...(completion.subagentSpawn ? { subagentSpawn: { ...completion.subagentSpawn } } : {}),
      };
    }

    const terminal = recentTerminals.find((record) => matchesActionRef(record, normalizedRef));
    if (terminal) {
      return {
        actionId: terminal.actionId,
        actionKind: terminal.actionKind,
        dedupeKey: terminal.dedupeKey,
        capability: terminal.capability,
        runtimeClass: terminal.runtimeClass,
        state: terminal.reason,
        cancellable: false,
        attempt: terminal.attempt,
        maxAttempts: terminal.maxAttempts,
        updatedAt: terminal.recordedAt,
        detail: terminal.detail,
      };
    }

    const failure = recentFailures.find((record) => matchesActionRef(record, normalizedRef));
    if (failure) {
      return {
        actionId: failure.actionId,
        actionKind: failure.actionKind,
        dedupeKey: failure.dedupeKey,
        capability: failure.capability,
        runtimeClass: failure.runtimeClass,
        state: 'failed',
        cancellable: false,
        attempt: failure.attempt,
        maxAttempts: failure.maxAttempts,
        updatedAt: failure.failedAt,
        detail: failure.error,
      };
    }

    return undefined;
  };

  hydrateQueue();

  eventBus.on('agent.post_turn.actions.inferred', (event) => {
    if (!isRecord(event) || !Array.isArray(event.actions)) {
      recordMalformedAction(event, 'Post-turn action inference event must include an actions array');
      return;
    }
    for (const rawAction of event.actions) {
      const action = normalizeRuntimeAction(rawAction, event);
      if (!action) {
        recordMalformedAction(rawAction, 'Invalid inferred post-turn action payload');
        continue;
      }
      queueAction(action);
    }
  });

  if (!scheduler.getTask(taskId)) {
    scheduler.register({
      id: taskId,
      name: 'Post-Turn Action Executor',
      type: 'every',
      intervalMs: Math.max(50, intervalMs),
      handler: async () => {
        await processQueue();
      },
      eligibility: { requiredTokens: ['memory.write'] },
      state: 'idle',
    });
  }

  return {
    enqueue(action: InferredPostTurnAction): PostTurnActionEnqueueResult {
      const normalized = normalizePersistedAction(action);
      if (!normalized) {
        throw new Error('Invalid inferred post-turn action payload');
      }
      return queueAction(normalized);
    },
    registerHandler(
      kind: string,
      handler: PostTurnActionHandler,
      options: PostTurnActionHandlerOptions = {},
    ): () => void {
      const normalizedKind = kind.trim();
      if (!normalizedKind) {
        throw new Error('Deferred action handler kind must be non-empty');
      }
      const handlerSet = handlers.get(normalizedKind) ?? new Map<PostTurnActionHandler, RegisteredPostTurnActionHandler>();
      // 'background' is the safe default: a handler makes no foreground-idle
      // claim unless it explicitly opts in. executionMode no longer drives the
      // runtime overlap decision (the lane profile does); it is retained for
      // other wiring and validated for consistency below.
      const executionMode: PostTurnActionExecutionMode =
        options.executionMode === 'foreground' ? 'foreground' : 'background';
      const runtimeClass = options.runtimeClass ?? resolveRuntimeClassForKind(normalizedKind);
      const coalescingOption: unknown = options.coalescing;
      if (
        coalescingOption !== undefined
        && coalescingOption !== 'dedupe_key_with_durable_watermark'
      ) {
        throw new Error(`Unknown post-turn action coalescing mode for "${normalizedKind}"`);
      }
      const coalescing = coalescingOption as PostTurnActionCoalescingMode | undefined;
      const existingCoalescing = handlerSet.size > 0
        ? [...handlerSet.values()][0]?.coalescing
        : coalescing;
      if (handlerSet.size > 0 && existingCoalescing !== coalescing) {
        throw new Error(
          `Post-turn action handlers for "${normalizedKind}" must declare one consistent coalescing mode`,
        );
      }
      // Consistency guard against silent re-drift: a handler that declares it
      // needs foreground idle must map to a lane whose profile actually
      // requires foreground idle. Fail closed at registration otherwise.
      if (
        executionMode === 'foreground'
        && !resolveRuntimeLaneBudgetProfile(runtimeClass).requiresForegroundIdle
      ) {
        throw new Error(
          `Post-turn action handler for "${normalizedKind}" declares executionMode 'foreground' but runtime `
          + `lane '${runtimeClass}' has requiresForegroundIdle=false. A foreground-idle handler must map to a `
          + `lane whose RuntimeLaneBudgetProfile.requiresForegroundIdle is true (worker-lanes.ts).`,
        );
      }
      handlerSet.set(handler, {
        callback: handler,
        executionMode,
        runtimeClass,
        ...(coalescing ? { coalescing } : {}),
      });
      handlers.set(normalizedKind, handlerSet);
      return () => {
        const current = handlers.get(normalizedKind);
        if (!current) return;
        current.delete(handler);
        if (current.size === 0) {
          handlers.delete(normalizedKind);
        }
      };
    },
    listQueued() {
      return [...queue.values()].map(entry => ({
        actionId: entry.action.id,
        actionKind: entry.action.kind,
        dedupeKey: entry.action.dedupeKey,
        capability: entry.capability,
        runtimeClass: entry.runtimeClass,
        attempt: entry.attempt,
        maxAttempts: entry.maxRetries + 1,
        nextRunAt: entry.nextRunAt,
      }));
    },
    cancel(actionRef: string, reason: PostTurnActionTerminalReason = 'cancelled'): boolean {
      return completeQueuedActionWithoutRunning(actionRef, 'cancelled', reason);
    },
    acknowledge(actionRef: string, detail: PostTurnActionTerminalReason = 'acknowledged'): boolean {
      return completeQueuedActionWithoutRunning(actionRef, 'acknowledged', detail);
    },
    getActionStatus,
    getStatus,
  };
}
