import type { InferredPostTurnAction } from '../../shared/contracts/runtime.js';
import type {
  RuntimeLaneBudgetProfile,
  RuntimeLaneClass,
} from './worker-lanes.js';

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
  | 'retries_exhausted'
  | 'malformed_action';
export type PostTurnActionTerminalReason = 'cancelled' | 'acknowledged';

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

export interface PostTurnActionQueueTerminalRecord {
  actionId: string;
  actionKind: string;
  dedupeKey: string;
  runtimeClass: RuntimeLaneClass;
  reason: PostTurnActionTerminalReason;
  recordedAt: number;
  attempt: number;
  maxAttempts: number;
  detail: string;
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

export interface QuarantinedPersistedQueueEntry {
  entryNumber: number;
  error: string;
  raw: unknown;
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
  terminal: {
    cancelledCount: number;
    acknowledgedCount: number;
    recentTerminals: PostTurnActionQueueTerminalRecord[];
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
  cancel(actionRef: string, reason?: string): boolean;
  acknowledge(actionRef: string, detail?: string): boolean;
  getStatus(): PostTurnActionQueueStatus;
}
