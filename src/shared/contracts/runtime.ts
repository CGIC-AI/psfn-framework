import type { ChannelType } from './channel-types.js';
import type { TurnID } from './turn-contracts.js';
import type { ChannelPrivacy } from './trust-contracts.js';
import type { IcpConversationCorrelation } from './icp-autonomy.js';
import type {
  ParentTurnContinuationStop,
  TurnRecordAuditPrivacy,
  TurnRecordBackgroundWorkHandoff,
  TurnRecordLocation,
  TurnRecordMessage,
  TurnRecordToolCall,
  TurnRecordVersionPointers,
} from './runtime-base.js';

export * from './runtime-base.js';
export * from './tool-call-outcome.js';

export interface TurnRecord {
  schemaVersion: 1;
  turnId: TurnID;
  requestId: string;
  /** Logical session that owned the turn; distinct from the exact source channel. */
  sessionId?: string;
  channelId: string;
  channelType: ChannelType;
  startedAt: number;
  completedAt: number;
  status: 'completed' | 'failed';
  /** Present when the parent-turn continuation fuse terminated this run. */
  continuationStop?: ParentTurnContinuationStop;
  /** Durable room/satellite place origin; absent on unbound turns. */
  location?: TurnRecordLocation;
  auditPrivacy?: TurnRecordAuditPrivacy;
  /** Gateway/session disclosure classification captured for this turn. */
  channelPrivacy?: ChannelPrivacy;
  userMessage: TurnRecordMessage;
  assistantMessage?: TurnRecordMessage;
  toolCalls: TurnRecordToolCall[];
  contextManifestRef?: string;
  internalStateSnapshotRef?: string;
  extractedMemoryIds: string[];
  concernDeltaRefs: string[];
  contactDeltaRefs: string[];
  roleEnvelopeRefs?: string[];
  observability?: import('../../core/turns/observability.js').TurnObservabilityRecord;
  versionPointers: TurnRecordVersionPointers;
  provenanceRefs: string[];
  /** Record-first, atomically enqueued post-turn work; safe to replay by turn ID. */
  backgroundWorkHandoff?: TurnRecordBackgroundWorkHandoff;
  /** Same-cluster autonomous-conversation lineage, when this is an ICP turn. */
  icpCorrelation?: IcpConversationCorrelation;
}
