import type { InferredPostTurnAction } from '../../shared/contracts/runtime.js';
import type {
  BoundedSubagentLaunchHealthState,
  BoundedSubagentLaunchLifecycleState,
  SubagentExecutionRequest,
} from './substrate-agent/bounded-subagent-contract.js';
import type {
  RuntimeLaneBudgetProfile,
  RuntimeLaneClass,
} from './worker-lanes.js';

export const POST_TURN_SUBAGENT_SPAWN_ACTION_KIND = 'subagent.spawn' as const;

export interface PostTurnActionAgent {
  waitForIdle?(): Promise<void>;
}

export type PostTurnActionCapability = 'generic' | 'subagent_spawn';
export interface PostTurnActionHandlerResult {
  detail?: string;
  rescheduleAt?: number;
  subagentSpawn?: PostTurnSubagentSpawnResultStatus;
}

export type PostTurnActionHandler = (
  action: InferredPostTurnAction,
) => Promise<PostTurnActionHandlerResult | void> | PostTurnActionHandlerResult | void;
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
export type PostTurnActionStatusState =
  | PostTurnActionQueueEntryState
  | 'failed'
  | PostTurnActionTerminalReason
  | 'succeeded';

export interface PostTurnSubagentSpawnBudget {
  maxTurns: number;
}

export interface PostTurnSubagentSpawnPolicy {
  mode: 'post_turn_action_pipe';
  allow: true;
  budget: PostTurnSubagentSpawnBudget;
}

export interface PostTurnSubagentSpawnPayload {
  request: Omit<SubagentExecutionRequest, 'maxTurns'> & { maxTurns?: number };
  policy: PostTurnSubagentSpawnPolicy;
}

export interface PostTurnSubagentSpawnResultStatus {
  subagentId: string;
  name: string;
  lifecycleState: BoundedSubagentLaunchLifecycleState;
  health: BoundedSubagentLaunchHealthState;
  stateReason: string;
  failureReason?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  turns: number;
}

export interface PostTurnSubagentSpawnQueuedStatus {
  requestName?: string;
  policyMode?: string;
  policyAllowed: boolean;
  budgetMaxTurns?: number;
  requestedMaxTurns?: number;
}

export interface PostTurnActionQueuedEntryStatus {
  actionId: string;
  actionKind: string;
  dedupeKey: string;
  capability: PostTurnActionCapability;
  runtimeClass: RuntimeLaneClass;
  state: PostTurnActionQueueEntryState;
  cancellable: boolean;
  attempt: number;
  maxAttempts: number;
  inferredAt: number;
  nextRunAt: number;
  queuedForMs: number;
  runAfterMs: number;
  subagentSpawn?: PostTurnSubagentSpawnQueuedStatus;
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
  capability: PostTurnActionCapability;
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
  capability: PostTurnActionCapability;
  runtimeClass: RuntimeLaneClass;
  reason: PostTurnActionTerminalReason;
  recordedAt: number;
  attempt: number;
  maxAttempts: number;
  detail: string;
}

export interface PostTurnActionQueueCompletionRecord {
  actionId: string;
  actionKind: string;
  dedupeKey: string;
  capability: PostTurnActionCapability;
  runtimeClass: RuntimeLaneClass;
  completedAt: number;
  attempt: number;
  maxAttempts: number;
  detail: string;
  subagentSpawn?: PostTurnSubagentSpawnResultStatus;
}

export interface PostTurnActionStatusRecord {
  actionId: string;
  actionKind: string;
  dedupeKey: string;
  capability: PostTurnActionCapability;
  runtimeClass: RuntimeLaneClass;
  state: PostTurnActionStatusState;
  cancellable: boolean;
  attempt: number;
  maxAttempts: number;
  updatedAt: number;
  detail?: string;
  nextRunAt?: number;
  queuedForMs?: number;
  runAfterMs?: number;
  queuedSubagentSpawn?: PostTurnSubagentSpawnQueuedStatus;
  subagentSpawn?: PostTurnSubagentSpawnResultStatus;
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
  completions: {
    completedCount: number;
    recentCompletions: PostTurnActionQueueCompletionRecord[];
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
    capability: PostTurnActionCapability;
    runtimeClass: RuntimeLaneClass;
    attempt: number;
    maxAttempts: number;
    nextRunAt: number;
  }>;
  cancel(actionRef: string, reason?: string): boolean;
  acknowledge(actionRef: string, detail?: string): boolean;
  getActionStatus(actionRef: string): PostTurnActionStatusRecord | undefined;
  getStatus(): PostTurnActionQueueStatus;
}
