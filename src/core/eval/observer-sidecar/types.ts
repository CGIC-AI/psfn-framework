import type { EmotionStateSnapshot } from '../../emotion/state.js';
import type {
  ChannelType,
  MessageRoutingMetadata,
  ObservabilityCallType,
  TurnID,
} from '../../../shared/contracts/runtime.js';
import type { ChannelVisibility, SensitivityLevel, TrustLevel } from '../../../system/trust/types.js';

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
  channelPrivacy?: ChannelVisibility;
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
}

export type ObserverEvalLifecycleState = ObserverEvalReadonly<ObserverEvalLifecycleStatePayload>;

export interface ObserverEvalSidecarConfig {
  enabled?: boolean;
  sidecarId?: string;
  deployment?: 'live' | 'eval' | 'test';
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

export interface ObserverEvalSidecarLogger {
  debug(message: string, payload: Record<string, unknown>): void;
}
