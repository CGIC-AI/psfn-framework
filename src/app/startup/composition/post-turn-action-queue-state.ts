import type { InferredPostTurnAction } from '../../../shared/contracts/runtime.js';
import {
  RUNTIME_LANE_CLASSES,
  type RuntimeLaneClass,
} from '../../../shared/contracts/runtime-lanes.js';
import type {
  PostTurnActionCapability,
  PostTurnActionQueueCoalescingRecord,
  PostTurnActionQueueCompletionRecord,
  PostTurnActionQueueDropRecord,
  PostTurnActionQueueEntryState,
  PostTurnActionQueueLaneStatus,
  PostTurnActionQueueFailureRecord,
  PostTurnActionQueuePersistenceStatus,
  PostTurnActionQueueStatus,
  PostTurnActionQueueTerminalRecord,
  PostTurnActionQueuedEntryStatus,
  QuarantinedPersistedQueueEntry,
} from '../../../core/agent/post-turn-action-runtime.js';
import { resolvePostTurnSubagentSpawnQueuedStatus } from '../../../core/agent/post-turn-subagent-spawn.js';
import { resolveRuntimeLaneBudgetProfile } from '../../../core/agent/worker-lanes.js';

export interface DeferredPostTurnQueueEntry {
  action: InferredPostTurnAction;
  pendingAction?: InferredPostTurnAction;
  capability: PostTurnActionCapability;
  runtimeClass: RuntimeLaneClass;
  attempt: number;
  nextRunAt: number;
  maxRetries: number;
  demandStartedAt: number;
  coverageThroughInferredAt: number;
  coalescedCount: number;
  retryableFailureCount: number;
}

const POST_TURN_RUNTIME_CLASS_ORDER: readonly RuntimeLaneClass[] = [
  RUNTIME_LANE_CLASSES.foregroundChat,
  RUNTIME_LANE_CLASSES.postTurnAppraisal,
  RUNTIME_LANE_CLASSES.backgroundContinuation,
  RUNTIME_LANE_CLASSES.maintenanceReflection,
];

interface DerivedQueueEntryState {
  capability: PostTurnActionCapability;
  runtimeClass: RuntimeLaneClass;
  nextRunAt: number;
  maxRetries: number;
}

export function normalizeDeferredPostTurnQueueProgressState(input: {
  value: Record<string, unknown>;
  action: InferredPostTurnAction;
  pendingAction?: InferredPostTurnAction;
  normalizeNonNegativeInteger: (value: unknown) => number | undefined;
}): Pick<
  DeferredPostTurnQueueEntry,
  'demandStartedAt' | 'coverageThroughInferredAt' | 'coalescedCount' | 'retryableFailureCount'
> | null {
  const { value, action, pendingAction, normalizeNonNegativeInteger } = input;
  const demandStartedAt = normalizeNonNegativeInteger(value.demandStartedAt) ?? action.inferredAt;
  const coverageThroughInferredAt = normalizeNonNegativeInteger(value.coverageThroughInferredAt)
    ?? Math.max(action.inferredAt, pendingAction?.inferredAt ?? 0);
  if (
    demandStartedAt > action.inferredAt
    || coverageThroughInferredAt < action.inferredAt
    || (pendingAction && coverageThroughInferredAt < pendingAction.inferredAt)
  ) return null;
  return {
    demandStartedAt,
    coverageThroughInferredAt,
    coalescedCount: normalizeNonNegativeInteger(value.coalescedCount) ?? 0,
    retryableFailureCount: normalizeNonNegativeInteger(value.retryableFailureCount) ?? 0,
  };
}

export function createDeferredPostTurnQueueEntry(
  action: InferredPostTurnAction,
  derived: DerivedQueueEntryState,
): DeferredPostTurnQueueEntry {
  return {
    action,
    ...derived,
    attempt: 0,
    demandStartedAt: action.inferredAt,
    coverageThroughInferredAt: action.inferredAt,
    coalescedCount: 0,
    retryableFailureCount: 0,
  };
}

export function coalesceDeferredPostTurnQueueEntry(input: {
  existing: DeferredPostTurnQueueEntry;
  incomingAction: InferredPostTurnAction;
  currentRunMustFinish: boolean;
  incomingNextRunAt: number;
  incomingMaxRetries: number;
}): { entry: DeferredPostTurnQueueEntry; successorPending: boolean } {
  const {
    existing,
    incomingAction,
    currentRunMustFinish,
    incomingNextRunAt,
    incomingMaxRetries,
  } = input;
  const incomingIsLatest = incomingAction.inferredAt >= existing.coverageThroughInferredAt;
  const shouldReplacePending = existing.pendingAction === undefined
    || incomingAction.inferredAt >= existing.pendingAction.inferredAt;
  const pendingAction = currentRunMustFinish
    ? (shouldReplacePending ? incomingAction : existing.pendingAction)
    : undefined;
  const successorPending = pendingAction !== undefined;
  return {
    entry: {
      ...existing,
      action: !currentRunMustFinish && incomingIsLatest ? incomingAction : existing.action,
      ...(pendingAction ? { pendingAction } : {}),
      demandStartedAt: Math.min(existing.demandStartedAt, incomingAction.inferredAt),
      coverageThroughInferredAt: Math.max(
        existing.coverageThroughInferredAt,
        incomingAction.inferredAt,
      ),
      coalescedCount: existing.coalescedCount + 1,
      nextRunAt: currentRunMustFinish
        ? existing.nextRunAt
        : Math.min(existing.nextRunAt, incomingNextRunAt),
      maxRetries: Math.max(existing.maxRetries, incomingMaxRetries),
    },
    successorPending,
  };
}

export function advanceDeferredPostTurnQueueEntry(
  liveEntry: DeferredPostTurnQueueEntry,
  successor: InferredPostTurnAction,
  derived: DerivedQueueEntryState,
): DeferredPostTurnQueueEntry {
  const { pendingAction: _pendingAction, ...retained } = liveEntry;
  return {
    ...retained,
    action: successor,
    ...derived,
    attempt: 0,
    demandStartedAt: successor.inferredAt,
  };
}

export function resolveAdmittedPostTurnActionDedupeKeys(
  entries: Iterable<DeferredPostTurnQueueEntry>,
): Set<string> {
  const queued = [...entries];
  const admittedDedupeKeys = new Set<string>();
  for (const runtimeClass of POST_TURN_RUNTIME_CLASS_ORDER) {
    const runtimeProfile = resolveRuntimeLaneBudgetProfile(runtimeClass);
    const laneEntries = queued
      .filter((candidate) => candidate.runtimeClass === runtimeClass)
      .sort((left, right) => (
        left.nextRunAt - right.nextRunAt
        || left.demandStartedAt - right.demandStartedAt
      ));
    const admittedEntries = runtimeProfile.degradationMode === 'defer_until_idle'
      ? laneEntries.slice(0, runtimeProfile.maxQueuedActions)
      : laneEntries;
    for (const admittedEntry of admittedEntries) {
      admittedDedupeKeys.add(admittedEntry.action.dedupeKey);
    }
  }
  return admittedDedupeKeys;
}

function resolveQueuedEntryState(
  entry: DeferredPostTurnQueueEntry,
  now: number,
  admittedDedupeKeys: ReadonlySet<string>,
  runningDedupeKeys: ReadonlySet<string>,
): PostTurnActionQueueEntryState {
  if (runningDedupeKeys.has(entry.action.dedupeKey)) return 'running';
  if (!admittedDedupeKeys.has(entry.action.dedupeKey)) return 'deferred';
  if (entry.nextRunAt > now) return entry.attempt > 0 ? 'retry_scheduled' : 'scheduled';
  return 'ready';
}

export function toPostTurnActionQueuedEntryStatus(
  entry: DeferredPostTurnQueueEntry,
  now: number,
  admittedDedupeKeys: ReadonlySet<string>,
  runningDedupeKeys: ReadonlySet<string>,
): PostTurnActionQueuedEntryStatus {
  const state = resolveQueuedEntryState(entry, now, admittedDedupeKeys, runningDedupeKeys);
  const status: PostTurnActionQueuedEntryStatus = {
    actionId: entry.action.id,
    actionKind: entry.action.kind,
    dedupeKey: entry.action.dedupeKey,
    capability: entry.capability,
    runtimeClass: entry.runtimeClass,
    state,
    cancellable: state !== 'running',
    attempt: entry.attempt,
    maxAttempts: entry.maxRetries + 1,
    inferredAt: entry.demandStartedAt,
    nextRunAt: entry.nextRunAt,
    queuedForMs: Math.max(0, now - entry.demandStartedAt),
    runAfterMs: Math.max(0, entry.nextRunAt - now),
    coalescedCount: entry.coalescedCount,
    coverageThroughInferredAt: entry.coverageThroughInferredAt,
    latestSourceMessageId: entry.pendingAction?.sourceMessageId ?? entry.action.sourceMessageId,
    successorPending: Boolean(entry.pendingAction),
  };
  if (entry.capability === 'subagent_spawn') {
    const spawnStatus = resolvePostTurnSubagentSpawnQueuedStatus(entry.action.payload);
    if (spawnStatus) status.subagentSpawn = spawnStatus;
  }
  return status;
}

function minimumPostTurnQueueNumber(values: number[]): number | undefined {
  return values.length > 0 ? Math.min(...values) : undefined;
}

function buildPostTurnActionQueueLaneStatus(input: {
  runtimeClass: RuntimeLaneClass;
  queued: PostTurnActionQueuedEntryStatus[];
  now: number;
  droppedCount: number;
  lastDrop?: PostTurnActionQueueDropRecord;
}): PostTurnActionQueueLaneStatus {
  const { runtimeClass, queued, now, droppedCount, lastDrop } = input;
  const runtimeProfile = resolveRuntimeLaneBudgetProfile(runtimeClass);
  const queueDepth = queued.length;
  const nextRunAt = minimumPostTurnQueueNumber(queued.map((entry) => entry.nextRunAt));
  const oldestInferredAt = minimumPostTurnQueueNumber(queued.map((entry) => entry.inferredAt));
  const deferred = queued.filter((entry) => entry.state === 'deferred');
  const oldestDeferredAt = minimumPostTurnQueueNumber(deferred.map((entry) => entry.inferredAt));
  const status: PostTurnActionQueueLaneStatus = {
    runtimeClass,
    chargeLane: runtimeProfile.chargeLane,
    queueDepth,
    maxQueuedActions: runtimeProfile.maxQueuedActions,
    availableSlots: Math.max(0, runtimeProfile.maxQueuedActions - queueDepth),
    saturated: runtimeProfile.maxQueuedActions > 0 && queueDepth >= runtimeProfile.maxQueuedActions,
    backPressureMode: runtimeProfile.degradationMode,
    maxRunsPerSchedulerTick: runtimeProfile.maxRunsPerSchedulerTick,
    readyCount: queued.filter((entry) => entry.state === 'ready').length,
    scheduledCount: queued.filter((entry) => entry.state === 'scheduled').length,
    retryScheduledCount: queued.filter((entry) => entry.state === 'retry_scheduled').length,
    runningCount: queued.filter((entry) => entry.state === 'running').length,
    deferredCount: deferred.length,
    droppedCount,
    ...(nextRunAt !== undefined ? { nextRunAt } : {}),
    ...(oldestInferredAt !== undefined
      ? { oldestInferredAt, oldestQueuedForMs: Math.max(0, now - oldestInferredAt) }
      : {}),
    ...(oldestDeferredAt !== undefined
      ? { oldestDeferredAt, oldestDeferredForMs: Math.max(0, now - oldestDeferredAt) }
      : {}),
    ...(lastDrop ? { lastDrop: { ...lastDrop } } : {}),
  };
  return status;
}

export function buildPostTurnActionQueueStatus(input: {
  entries: Iterable<DeferredPostTurnQueueEntry>;
  runningDedupeKeys: ReadonlySet<string>;
  now: number;
  processing: boolean;
  droppedCountsByRuntimeClass: ReadonlyMap<RuntimeLaneClass, number>;
  droppedCount: number;
  recentDrops: readonly PostTurnActionQueueDropRecord[];
  failedCount: number;
  retryableFailureCount: number;
  recentFailures: readonly PostTurnActionQueueFailureRecord[];
  coalescedCount: number;
  recentCoalesces: readonly PostTurnActionQueueCoalescingRecord[];
  cancelledCount: number;
  acknowledgedCount: number;
  recentTerminals: readonly PostTurnActionQueueTerminalRecord[];
  completedCount: number;
  recentCompletions: readonly PostTurnActionQueueCompletionRecord[];
  lastProgressAt?: number;
  quarantinedEntries: readonly QuarantinedPersistedQueueEntry[];
  quarantinePersisted: boolean;
  persistence: PostTurnActionQueuePersistenceStatus;
}): PostTurnActionQueueStatus {
  const entries = [...input.entries];
  const admittedDedupeKeys = resolveAdmittedPostTurnActionDedupeKeys(entries);
  const queued = entries.map((entry) => toPostTurnActionQueuedEntryStatus(
    entry,
    input.now,
    admittedDedupeKeys,
    input.runningDedupeKeys,
  ));
  const queuedByRuntimeClass = new Map<RuntimeLaneClass, PostTurnActionQueuedEntryStatus[]>();
  for (const runtimeClass of POST_TURN_RUNTIME_CLASS_ORDER) queuedByRuntimeClass.set(runtimeClass, []);
  for (const entry of queued) queuedByRuntimeClass.get(entry.runtimeClass)?.push(entry);
  const lanes = POST_TURN_RUNTIME_CLASS_ORDER.map((runtimeClass) => buildPostTurnActionQueueLaneStatus({
    runtimeClass,
    queued: queuedByRuntimeClass.get(runtimeClass) ?? [],
    now: input.now,
    droppedCount: input.droppedCountsByRuntimeClass.get(runtimeClass) ?? 0,
    lastDrop: input.recentDrops.find((drop) => drop.runtimeClass === runtimeClass),
  }));
  const nextRunAt = minimumPostTurnQueueNumber(queued.map((entry) => entry.nextRunAt));
  const oldestDemandAt = minimumPostTurnQueueNumber(queued.map((entry) => entry.inferredAt));
  const noProgressSince = oldestDemandAt === undefined
    ? undefined
    : Math.max(oldestDemandAt, input.lastProgressAt ?? oldestDemandAt);
  return {
    timestamp: input.now,
    processing: input.processing,
    queueDepth: entries.length,
    maxQueueDepth: lanes.reduce((sum, lane) => sum + lane.maxQueuedActions, 0),
    availableSlots: lanes.reduce((sum, lane) => sum + lane.availableSlots, 0),
    saturated: lanes.some((lane) => lane.saturated),
    readyCount: queued.filter((entry) => entry.state === 'ready').length,
    scheduledCount: queued.filter((entry) => entry.state === 'scheduled').length,
    retryScheduledCount: queued.filter((entry) => entry.state === 'retry_scheduled').length,
    runningCount: queued.filter((entry) => entry.state === 'running').length,
    ...(nextRunAt !== undefined ? { nextRunAt } : {}),
    lanes,
    queued,
    coalescing: {
      coalescedCount: input.coalescedCount,
      activeCoalescedCount: queued.reduce((sum, entry) => sum + entry.coalescedCount, 0),
      recentCoalesces: input.recentCoalesces.map((entry) => ({ ...entry })),
    },
    backPressure: {
      droppedCount: input.droppedCount,
      recentDrops: input.recentDrops.map((entry) => ({ ...entry })),
    },
    failures: {
      failedCount: input.failedCount,
      retryableFailureCount: input.retryableFailureCount,
      permanentRejectCount: input.failedCount,
      recentFailures: input.recentFailures.map((entry) => ({ ...entry })),
    },
    progress: {
      ...(input.lastProgressAt !== undefined ? { lastProgressAt: input.lastProgressAt } : {}),
      ...(noProgressSince !== undefined ? { noProgressSince } : {}),
      noProgressForMs: noProgressSince === undefined ? 0 : Math.max(0, input.now - noProgressSince),
    },
    terminal: {
      cancelledCount: input.cancelledCount,
      acknowledgedCount: input.acknowledgedCount,
      recentTerminals: input.recentTerminals.map((entry) => ({ ...entry })),
    },
    completions: {
      completedCount: input.completedCount,
      recentCompletions: input.recentCompletions.map((entry) => ({
        ...entry,
        ...(entry.subagentSpawn ? { subagentSpawn: { ...entry.subagentSpawn } } : {}),
      })),
    },
    quarantine: {
      count: input.quarantinedEntries.length,
      persisted: input.quarantinePersisted,
      entries: input.quarantinedEntries.map((entry) => ({ ...entry })),
    },
    persistence: input.persistence,
  };
}
