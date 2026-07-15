import type { EmotionStateSnapshot } from '../../emotion/state.js';
import type {
  ChannelType,
  MessageRoutingMetadata,
  ObserverEvalSidecarAdapterSettings,
  ObserverEvalSidecarDeploymentTarget,
  ObserverEvalSidecarGardenExposureSettings,
  ObserverEvalSidecarLeverSettings,
  ObserverEvalSidecarMode,
  ObserverEvalSidecarOverflowPolicy,
  ObserverEvalSidecarPersistenceSettings,
  ObservabilityCallType,
  TurnID,
} from '../../../shared/contracts/runtime.js';
import type { SensitivityLevel, TrustLevel } from '../../../system/trust/types.js';
import type { ChannelPrivacy } from '../../../system/trust/context-envelope.js';

export type ObserverEvalReadonly<T> =
  T extends (...args: readonly unknown[]) => unknown
    ? T
    : T extends readonly (infer Item)[]
      ? readonly ObserverEvalReadonly<Item>[]
      : T extends object
        ? { readonly [Key in keyof T]: ObserverEvalReadonly<T[Key]> }
        : T;

export type ObserverEvalRoutingSource = NonNullable<MessageRoutingMetadata['source']> | 'unspecified';

export interface ObserverEvalTurnIdentity {
  turnId: TurnID;
  requestId: string;
  sourceMessageId: string;
  channelId: string;
  channelType: ChannelType;
  messageTimestampMs: number;
  taskKind?: string;
}

export interface ObserverEvalSourceMetadata {
  routingSource: ObserverEvalRoutingSource;
  isDirectMessage: boolean;
  channelPrivacy?: ChannelPrivacy;
}

export interface ObserverEvalEmotionSnapshot {
  snapshot: EmotionStateSnapshot | null;
  appraisalEntryCount: number;
}

export interface ObserverEvalTurnMetadata {
  trustLevel: TrustLevel;
  speakerRole: 'user' | 'system';
  contactResolved: boolean;
  contentLength: number;
  attachmentCount: number;
  hasVisionInput: boolean;
  /**
   * Explicit upstream privacy classification for this turn. Privacy consumers
   * must fail closed when this is absent or invalid; do not infer it from text.
   */
  sensitivity?: SensitivityLevel;
}

export interface ObserverEvalProvenance {
  seam: 'substrate-agent.pre-turn.emotion-observed';
  capturedAt: number;
  emotionSessionId: string;
  emotionSnapshotSource: 'observeEmotionState';
  correlation: {
    callType: ObservabilityCallType;
    purpose: string;
  };
}

export interface ObserverEvalInputPayload {
  schemaVersion: 1;
  turn: ObserverEvalTurnIdentity;
  source: ObserverEvalSourceMetadata;
  emotion: ObserverEvalEmotionSnapshot;
  metadata: ObserverEvalTurnMetadata;
  provenance: ObserverEvalProvenance;
}

export type ObserverEvalInput = ObserverEvalReadonly<ObserverEvalInputPayload>;

export type ObserverEvalLifecycleStatus = 'disabled' | 'enabled' | 'degraded' | 'unavailable';

export type { ObserverEvalSidecarOverflowPolicy } from '../../../shared/contracts/runtime.js';

export type ObserverEvalSidecarDropReason =
  | 'queue_full'
  | 'shutting_down'
  | 'shutdown_timeout';

export type ObserverEvalSidecarFailureReason =
  | 'observer_failed'
  | 'observer_timeout'
  | 'observer_unavailable';

export interface ObserverEvalLifecycleStatePayload {
  status: ObserverEvalLifecycleStatus;
  observedAt: number;
  sidecarId?: string;
  reason?: string;
  error?: {
    message: string;
    redacted?: boolean;
    redactionReason?: string;
    rawMessageLength?: number;
  };
  queue?: {
    acceptedCount: number;
    queuedCount: number;
    runningCount: number;
    maxQueuedTurns: number;
  };
  drop?: {
    reason: ObserverEvalSidecarDropReason;
    droppedCount: number;
  };
}

export type ObserverEvalLifecycleState = ObserverEvalReadonly<ObserverEvalLifecycleStatePayload>;

export interface ObserverEvalSidecarQueueConfig {
  maxQueuedTurns?: number;
  overflowPolicy?: ObserverEvalSidecarOverflowPolicy;
  observerTimeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  shutdownDrainTimeoutMs?: number;
}

export interface ObserverEvalSidecarShutdownOptions {
  drain?: boolean;
  timeoutMs?: number;
}

export interface ObserverEvalSidecarConfig {
  enabled?: boolean;
  sidecarId?: string;
  deploymentTarget?: ObserverEvalSidecarDeploymentTarget;
  mode?: ObserverEvalSidecarMode;
  queue?: ObserverEvalSidecarQueueConfig;
  adapter?: ObserverEvalSidecarAdapterSettings;
  persistence?: ObserverEvalSidecarPersistenceSettings;
  garden?: ObserverEvalSidecarGardenExposureSettings;
  /**
   * Shadow trigger levers (WOULD-ACT telemetry). Tracking only; readable
   * exclusively through the Garden admin surface.
   */
  levers?: ObserverEvalSidecarLeverSettings;
}

export interface ObserverEvalSidecarPort {
  observeTurn(input: ObserverEvalInput): void | Promise<void>;
}

export type ObserverEvalLifecycleHook = (
  state: ObserverEvalLifecycleState,
) => void | Promise<void>;

export interface ObserverEvalSidecarRuntime {
  config?: ObserverEvalSidecarConfig;
  observer?: ObserverEvalSidecarPort | null;
  onLifecycleState?: ObserverEvalLifecycleHook;
}

export interface ObserverEvalSidecarHealthSnapshotPayload {
  status: ObserverEvalLifecycleStatus;
  observedAt: number;
  sidecarId?: string;
  enabled: boolean;
  available: boolean;
  accepting: boolean;
  queue: {
    queuedCount: number;
    runningCount: number;
    maxQueuedTurns: number;
    overflowPolicy: ObserverEvalSidecarOverflowPolicy;
    shuttingDown: boolean;
  };
  counts: {
    accepted: number;
    completed: number;
    dropped: number;
    failed: number;
    timedOut: number;
    retried: number;
    lifecycleHookFailed: number;
    shutdownTimedOut: number;
  };
  dropCounts: Partial<Record<ObserverEvalSidecarDropReason, number>>;
  failureCounts: Partial<Record<ObserverEvalSidecarFailureReason, number>>;
  lastDrop?: {
    reason: ObserverEvalSidecarDropReason;
    turnId: TurnID;
    requestId: string;
    observedAt: number;
  };
  lastFailure?: {
    reason: ObserverEvalSidecarFailureReason;
    turnId: TurnID;
    requestId: string;
    message: string;
    attempt: number;
    observedAt: number;
  };
  lastLifecycleState?: ObserverEvalLifecycleState;
}

export type ObserverEvalSidecarHealthSnapshot =
  ObserverEvalReadonly<ObserverEvalSidecarHealthSnapshotPayload>;

export interface ObserverEvalSidecarLogger {
  debug(message: string, payload: Record<string, unknown>): void;
}
