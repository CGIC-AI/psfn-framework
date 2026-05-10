import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import type { InferredPostTurnAction } from '../../../shared/contracts/runtime.js';
import type { EventBus } from '../../../shared/event-bus.js';
import type { Scheduler } from '../../../core/scheduler/scheduler.js';
import {
  RUNTIME_LANE_CLASSES,
  compareRuntimeLanePriority,
  isRuntimeLaneClass,
  resolveRuntimeLaneBudgetProfile,
  resolveRuntimeLaneClassForPostTurnActionKind,
  type RuntimeLaneBudgetProfile,
  type RuntimeLaneClass,
} from '../../../core/agent/worker-lanes.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { writeJsonAtomic } from '../../../shared/utils/fs.js';
import { isRecord } from '../../../shared/utils/types.js';
import type {
  EligibilityDecision,
  EligibilityGate,
} from '../../../system/capabilities/eligibility.js';

const log = createComponentLogger('PostTurnActions');

export interface PostTurnActionAgent {
  waitForIdle?(): Promise<void>;
}

export type PostTurnActionHandler = (action: InferredPostTurnAction) => Promise<void> | void;
export type PostTurnActionExecutionMode = 'foreground' | 'background';

export interface PostTurnActionHandlerOptions {
  executionMode?: PostTurnActionExecutionMode;
  runtimeClass?: RuntimeLaneClass;
}

export type PostTurnActionQueueEntryState = 'ready' | 'scheduled' | 'retry_scheduled' | 'running';
export type PostTurnActionQueuePersistenceLoadState =
  | 'not_configured'
  | 'not_found'
  | 'loaded'
  | 'invalid_payload'
  | 'read_failed';
export type PostTurnActionFailureReason =
  | 'missing_handler'
  | 'eligibility_denied'
  | 'retries_exhausted';

export interface PostTurnActionQueuedEntryStatus {
  actionId: string;
  actionKind: string;
  dedupeKey: string;
  runtimeClass: RuntimeLaneClass;
  state: PostTurnActionQueueEntryState;
  attempt: number;
  maxAttempts: number;
  inferredAt: number;
  nextRunAt: number;
  queuedForMs: number;
  runAfterMs: number;
}

export interface PostTurnActionQueueDropRecord {
  actionId: string;
  actionKind: string;
  dedupeKey: string;
  runtimeClass: RuntimeLaneClass;
  reason: string;
  droppedAt: number;
  queueDepth: number;
  maxQueuedActions: number;
  backPressureMode: RuntimeLaneBudgetProfile['degradationMode'];
}

export interface PostTurnActionQueueFailureRecord {
  actionId: string;
  actionKind: string;
  dedupeKey: string;
  runtimeClass: RuntimeLaneClass;
  reason: PostTurnActionFailureReason;
  failedAt: number;
  attempt: number;
  maxAttempts: number;
  error: string;
}

export interface PostTurnActionQueueLaneStatus {
  runtimeClass: RuntimeLaneClass;
  chargeLane: RuntimeLaneBudgetProfile['chargeLane'];
  queueDepth: number;
  maxQueuedActions: number;
  availableSlots: number;
  saturated: boolean;
  backPressureMode: RuntimeLaneBudgetProfile['degradationMode'];
  maxRunsPerSchedulerTick: number;
  readyCount: number;
  scheduledCount: number;
  retryScheduledCount: number;
  runningCount: number;
  droppedCount: number;
  nextRunAt?: number;
  oldestInferredAt?: number;
  oldestQueuedForMs?: number;
  lastDrop?: PostTurnActionQueueDropRecord;
}

export interface PostTurnActionQueuePersistenceStatus {
  enabled: boolean;
  path?: string;
  quarantinePath?: string;
  loadState: PostTurnActionQueuePersistenceLoadState;
  loadedEntries: number;
  quarantinedEntries: number;
  quarantinePersisted: boolean;
  lastLoadedAt?: number;
  lastLoadError?: string;
  lastPersistedAt?: number;
  lastPersistError?: string;
}

export interface PostTurnActionQueueQuarantineStatus {
  count: number;
  persisted: boolean;
  entries: QuarantinedPersistedQueueEntry[];
}

export interface PostTurnActionQueueStatus {
  timestamp: number;
  processing: boolean;
  queueDepth: number;
  maxQueueDepth: number;
  availableSlots: number;
  saturated: boolean;
  readyCount: number;
  scheduledCount: number;
  retryScheduledCount: number;
  runningCount: number;
  nextRunAt?: number;
  lanes: PostTurnActionQueueLaneStatus[];
  queued: PostTurnActionQueuedEntryStatus[];
  backPressure: {
    droppedCount: number;
    recentDrops: PostTurnActionQueueDropRecord[];
  };
  failures: {
    failedCount: number;
    recentFailures: PostTurnActionQueueFailureRecord[];
  };
  quarantine: PostTurnActionQueueQuarantineStatus;
  persistence: PostTurnActionQueuePersistenceStatus;
}

export interface PostTurnActionRuntime {
  registerHandler(
    kind: string,
    handler: PostTurnActionHandler,
    options?: PostTurnActionHandlerOptions,
  ): () => void;
  listQueued(): Array<{
    actionId: string;
    actionKind: string;
    dedupeKey: string;
    runtimeClass: RuntimeLaneClass;
    attempt: number;
    maxAttempts: number;
    nextRunAt: number;
  }>;
  getStatus(): PostTurnActionQueueStatus;
}

interface DeferredQueueEntry {
  action: InferredPostTurnAction;
  runtimeClass: RuntimeLaneClass;
  attempt: number;
  nextRunAt: number;
  maxRetries: number;
}

interface RegisteredPostTurnActionHandler {
  callback: PostTurnActionHandler;
  executionMode: PostTurnActionExecutionMode;
  runtimeClass: RuntimeLaneClass;
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
const PERSISTED_QUEUE_VERSION = 1;
const MAX_STATUS_HISTORY = 25;
const RUNTIME_CLASS_ORDER: RuntimeLaneClass[] = [
  RUNTIME_LANE_CLASSES.foregroundChat,
  RUNTIME_LANE_CLASSES.postTurnAppraisal,
  RUNTIME_LANE_CLASSES.backgroundContinuation,
  RUNTIME_LANE_CLASSES.maintenanceReflection,
];

interface PersistedQueueFile {
  version: number;
  entries: unknown[];
}

export interface QuarantinedPersistedQueueEntry {
  entryNumber: number;
  error: string;
  raw: unknown;
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
  const recentDrops: PostTurnActionQueueDropRecord[] = [];
  const recentFailures: PostTurnActionQueueFailureRecord[] = [];
  const droppedCountsByRuntimeClass = new Map<RuntimeLaneClass, number>();
  let processing = false;
  let droppedCount = 0;
  let failedCount = 0;
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

  const resolveRuntimeClassForKind = (kind: string): RuntimeLaneClass => (
    resolveRuntimeLaneClassForPostTurnActionKind(kind)
  );

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

  const normalizePersistedQueueEntry = (value: unknown): DeferredQueueEntry | null => {
    if (!isRecord(value)) {
      return null;
    }
    const action = normalizePersistedAction(value.action);
    if (!action) {
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

    return {
      action,
      runtimeClass,
      attempt,
      nextRunAt,
      maxRetries: resolvedMaxRetries,
    };
  };

  const persistQueue = (): void => {
    if (!persistencePath) {
      return;
    }

    const serialized = {
      version: PERSISTED_QUEUE_VERSION,
      entries: [...queue.values()].map((entry) => ({
        action: entry.action,
        runtimeClass: entry.runtimeClass,
        attempt: entry.attempt,
        nextRunAt: entry.nextRunAt,
        maxRetries: entry.maxRetries,
      })),
    } satisfies PersistedQueueFile;

    try {
      writeJsonAtomic(persistencePath, serialized);
      lastPersistedAt = Date.now();
      lastPersistError = undefined;
    } catch (error) {
      lastPersistError = String(error);
      log.error('Failed to persist deferred post-turn action queue', {
        persistencePath,
        error: lastPersistError,
      });
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

    if (!isRecord(parsed) || parsed.version !== PERSISTED_QUEUE_VERSION || !Array.isArray(parsed.entries)) {
      persistenceLoadState = 'invalid_payload';
      lastLoadedAt = Date.now();
      lastLoadError = 'Deferred post-turn action queue payload is invalid';
      log.error('Deferred post-turn action queue payload is invalid; starting empty', {
        persistencePath,
      });
      return;
    }

    let loaded = 0;
    const quarantinedEntries: QuarantinedPersistedQueueEntry[] = [];
    for (const [index, rawEntry] of parsed.entries.entries()) {
      const entry = normalizePersistedQueueEntry(rawEntry);
      if (!entry) {
        quarantinedEntries.push({
          entryNumber: index + 1,
          error: 'Invalid deferred post-turn action queue entry payload',
          raw: rawEntry,
        });
        continue;
      }
      if (queue.has(entry.action.dedupeKey)) {
        quarantinedEntries.push({
          entryNumber: index + 1,
          error: `Duplicate deferred post-turn action dedupe key "${entry.action.dedupeKey}"`,
          raw: rawEntry,
        });
        continue;
      }
      queue.set(entry.action.dedupeKey, entry);
      loaded += 1;
    }
    persistenceLoadState = 'loaded';
    loadedEntries = loaded;
    lastLoadedAt = Date.now();
    lastLoadError = undefined;

    if (loaded > 0) {
      log.info('Loaded deferred post-turn action queue from disk', {
        persistencePath,
        loaded,
      });
    }
    const quarantineWriteSucceeded = persistQuarantinedEntries(quarantinedEntries);
    if (quarantinedEntries.length > 0) {
      log.warn('Quarantined deferred post-turn action queue entries during load', {
        persistencePath,
        quarantined: quarantinedEntries.length,
        loaded,
      });
      if (quarantineWriteSucceeded) {
        persistQueue();
      }
    }
  };

  const emitTelemetry = (
    phase:
      | 'queued'
      | 'deduplicated'
      | 'started'
      | 'succeeded'
      | 'retry_scheduled'
      | 'failed'
      | 'dropped_budget',
    entry: DeferredQueueEntry,
    optionsOverride: { nextRetryAt?: number; delayMs?: number; error?: string } = {},
  ): void => {
    const maxAttempts = entry.maxRetries + 1;
    const runtimeProfile = resolveRuntimeLaneBudgetProfile(entry.runtimeClass);
    eventBus.emit('agent.post_turn.action.telemetry', {
      actionId: entry.action.id,
      actionKind: entry.action.kind,
      channelId: entry.action.channelId,
      sourceMessageId: entry.action.sourceMessageId,
      dedupeKey: entry.action.dedupeKey,
      runtimeClass: entry.runtimeClass,
      chargeLane: runtimeProfile.chargeLane,
      phase,
      attempt: entry.attempt,
      maxAttempts,
      queueDepth: queue.size,
      timestamp: Date.now(),
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
  };

  const recordDrop = (
    entry: DeferredQueueEntry,
    reason: string,
  ): void => {
    const runtimeProfile = resolveRuntimeLaneBudgetProfile(entry.runtimeClass);
    const droppedAt = Date.now();
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
  };

  const recordFailure = (
    entry: DeferredQueueEntry,
    reason: PostTurnActionFailureReason,
    error: string,
  ): void => {
    failedCount += 1;
    rememberRecent(recentFailures, {
      actionId: entry.action.id,
      actionKind: entry.action.kind,
      dedupeKey: entry.action.dedupeKey,
      runtimeClass: entry.runtimeClass,
      reason,
      failedAt: Date.now(),
      attempt: entry.attempt,
      maxAttempts: entry.maxRetries + 1,
      error,
    });
  };

  const queueAction = (action: InferredPostTurnAction): void => {
    const existing = queue.get(action.dedupeKey);
    if (existing) {
      emitTelemetry('deduplicated', existing);
      return;
    }

    const entry: DeferredQueueEntry = {
      action,
      runtimeClass: resolveRuntimeClassForKind(action.kind),
      attempt: 0,
      nextRunAt: resolveInitialNextRunAt(action),
      maxRetries: normalizeMaxRetries(action.maxRetries),
    };
    queue.set(action.dedupeKey, entry);
    const runtimeProfile = resolveRuntimeLaneBudgetProfile(entry.runtimeClass);
    const sameClassEntries = [...queue.values()]
      .filter((candidate) => candidate.runtimeClass === entry.runtimeClass)
      .sort((left, right) => left.action.inferredAt - right.action.inferredAt || left.nextRunAt - right.nextRunAt);
    const overflow = Math.max(0, sameClassEntries.length - runtimeProfile.maxQueuedActions);
    if (overflow > 0) {
      for (const droppedEntry of sameClassEntries.slice(0, overflow)) {
        queue.delete(droppedEntry.action.dedupeKey);
        const reason = `Runtime class queue budget exhausted for ${droppedEntry.runtimeClass}`;
        recordDrop(droppedEntry, reason);
        emitTelemetry('dropped_budget', droppedEntry, {
          error: reason,
        });
      }
    }
    persistQueue();
    if (queue.has(entry.action.dedupeKey)) {
      emitTelemetry('queued', entry);
    }
  };

  const runNextDueAction = async (
    classRunCounts: Partial<Record<RuntimeLaneClass, number>>,
  ): Promise<boolean> => {
    if (queue.size === 0) {
      return false;
    }

    const now = Date.now();
    const dueEntries = [...queue.values()]
      .filter((entry) => entry.nextRunAt <= now)
      .filter((entry) => {
        const classRuns = classRunCounts[entry.runtimeClass] ?? 0;
        return classRuns < resolveRuntimeLaneBudgetProfile(entry.runtimeClass).maxRunsPerSchedulerTick;
      })
      .sort((left, right) => (
        compareRuntimeLanePriority(left.runtimeClass, right.runtimeClass)
        || left.nextRunAt - right.nextRunAt
        || left.action.inferredAt - right.action.inferredAt
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
    persistQueue();
    emitTelemetry('started', entry);

    try {
      const registeredHandlers = [...registrations.values()];
      const requiresForegroundIdle = registeredHandlers.some(
        ({ executionMode }) => executionMode !== 'background',
      );
      if (requiresForegroundIdle) {
        await agentLoop.waitForIdle?.();
      }
      for (const { callback } of registeredHandlers) {
        await callback(entry.action);
      }
      queue.delete(entry.action.dedupeKey);
      persistQueue();
      emitTelemetry('succeeded', entry);
    } catch (error) {
      const errorText = String(error);
      if (entry.attempt > entry.maxRetries) {
        queue.delete(entry.action.dedupeKey);
        persistQueue();
        log.error('Deferred action exhausted retries', {
          actionId: entry.action.id,
          actionKind: entry.action.kind,
          attempt: entry.attempt,
          maxRetries: entry.maxRetries,
          error: errorText,
        });
        recordFailure(entry, 'retries_exhausted', errorText);
        emitTelemetry('failed', entry, { error: errorText });
        return true;
      }

      const delayMs = Math.min(maxRetryDelayMs, baseRetryDelayMs * Math.pow(2, Math.max(0, entry.attempt - 1)));
      entry.nextRunAt = Date.now() + delayMs;
      persistQueue();
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

  const resolveQueuedEntryState = (
    entry: DeferredQueueEntry,
    now: number,
  ): PostTurnActionQueueEntryState => {
    if (runningDedupeKeys.has(entry.action.dedupeKey)) {
      return 'running';
    }
    if (entry.nextRunAt > now) {
      return entry.attempt > 0 ? 'retry_scheduled' : 'scheduled';
    }
    return 'ready';
  };

  const toQueuedEntryStatus = (
    entry: DeferredQueueEntry,
    now: number,
  ): PostTurnActionQueuedEntryStatus => ({
    actionId: entry.action.id,
    actionKind: entry.action.kind,
    dedupeKey: entry.action.dedupeKey,
    runtimeClass: entry.runtimeClass,
    state: resolveQueuedEntryState(entry, now),
    attempt: entry.attempt,
    maxAttempts: entry.maxRetries + 1,
    inferredAt: entry.action.inferredAt,
    nextRunAt: entry.nextRunAt,
    queuedForMs: Math.max(0, now - entry.action.inferredAt),
    runAfterMs: Math.max(0, entry.nextRunAt - now),
  });

  const minimumNumber = (values: number[]): number | undefined => (
    values.length > 0 ? Math.min(...values) : undefined
  );

  const buildLaneStatus = (
    runtimeClass: RuntimeLaneClass,
    queued: PostTurnActionQueuedEntryStatus[],
    now: number,
  ): PostTurnActionQueueLaneStatus => {
    const runtimeProfile = resolveRuntimeLaneBudgetProfile(runtimeClass);
    const queueDepth = queued.length;
    const availableSlots = Math.max(0, runtimeProfile.maxQueuedActions - queueDepth);
    const nextRunAt = minimumNumber(queued.map((entry) => entry.nextRunAt));
    const oldestInferredAt = minimumNumber(queued.map((entry) => entry.inferredAt));
    const status: PostTurnActionQueueLaneStatus = {
      runtimeClass,
      chargeLane: runtimeProfile.chargeLane,
      queueDepth,
      maxQueuedActions: runtimeProfile.maxQueuedActions,
      availableSlots,
      saturated: runtimeProfile.maxQueuedActions > 0 && queueDepth >= runtimeProfile.maxQueuedActions,
      backPressureMode: runtimeProfile.degradationMode,
      maxRunsPerSchedulerTick: runtimeProfile.maxRunsPerSchedulerTick,
      readyCount: queued.filter((entry) => entry.state === 'ready').length,
      scheduledCount: queued.filter((entry) => entry.state === 'scheduled').length,
      retryScheduledCount: queued.filter((entry) => entry.state === 'retry_scheduled').length,
      runningCount: queued.filter((entry) => entry.state === 'running').length,
      droppedCount: droppedCountsByRuntimeClass.get(runtimeClass) ?? 0,
    };
    if (nextRunAt !== undefined) {
      status.nextRunAt = nextRunAt;
    }
    if (oldestInferredAt !== undefined) {
      status.oldestInferredAt = oldestInferredAt;
      status.oldestQueuedForMs = Math.max(0, now - oldestInferredAt);
    }
    const lastDrop = recentDrops.find((drop) => drop.runtimeClass === runtimeClass);
    if (lastDrop) {
      status.lastDrop = { ...lastDrop };
    }
    return status;
  };

  const getStatus = (): PostTurnActionQueueStatus => {
    const now = Date.now();
    const queued = [...queue.values()].map((entry) => toQueuedEntryStatus(entry, now));
    const queuedByRuntimeClass = new Map<RuntimeLaneClass, PostTurnActionQueuedEntryStatus[]>();
    for (const runtimeClass of RUNTIME_CLASS_ORDER) {
      queuedByRuntimeClass.set(runtimeClass, []);
    }
    for (const entry of queued) {
      const existing = queuedByRuntimeClass.get(entry.runtimeClass);
      if (existing) {
        existing.push(entry);
      }
    }
    const lanes = RUNTIME_CLASS_ORDER.map((runtimeClass) => buildLaneStatus(
      runtimeClass,
      queuedByRuntimeClass.get(runtimeClass) ?? [],
      now,
    ));
    const nextRunAt = minimumNumber(queued.map((entry) => entry.nextRunAt));
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

    const status: PostTurnActionQueueStatus = {
      timestamp: now,
      processing,
      queueDepth: queue.size,
      maxQueueDepth: lanes.reduce((sum, lane) => sum + lane.maxQueuedActions, 0),
      availableSlots: lanes.reduce((sum, lane) => sum + lane.availableSlots, 0),
      saturated: lanes.some((lane) => lane.saturated),
      readyCount: queued.filter((entry) => entry.state === 'ready').length,
      scheduledCount: queued.filter((entry) => entry.state === 'scheduled').length,
      retryScheduledCount: queued.filter((entry) => entry.state === 'retry_scheduled').length,
      runningCount: queued.filter((entry) => entry.state === 'running').length,
      lanes,
      queued,
      backPressure: {
        droppedCount,
        recentDrops: recentDrops.map((entry) => ({ ...entry })),
      },
      failures: {
        failedCount,
        recentFailures: recentFailures.map((entry) => ({ ...entry })),
      },
      quarantine: {
        count: quarantinedPersistedEntries.length,
        persisted: quarantinePersisted,
        entries: quarantinedPersistedEntries.map((entry) => ({ ...entry })),
      },
      persistence: persistenceStatus,
    };
    if (nextRunAt !== undefined) {
      status.nextRunAt = nextRunAt;
    }
    return status;
  };

  hydrateQueue();

  eventBus.on('agent.post_turn.actions.inferred', ({ actions }) => {
    for (const action of actions) {
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
      handlerSet.set(handler, {
        callback: handler,
        executionMode: options.executionMode === 'background' ? 'background' : 'foreground',
        runtimeClass: options.runtimeClass ?? resolveRuntimeClassForKind(normalizedKind),
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
        runtimeClass: entry.runtimeClass,
        attempt: entry.attempt,
        maxAttempts: entry.maxRetries + 1,
        nextRunAt: entry.nextRunAt,
      }));
    },
    getStatus,
  };
}
