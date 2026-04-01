import type { SessionEntry } from '../session/types.js';
import type {
  GatewayRoutingEnvelope,
  ShardCreationMode,
  ShardLineage,
} from '../routing/envelope.js';

// ── Shard types ──
// Ephemeral sub-agent instances for parallel task execution.

export type ShardLifecycleState = 'registering' | 'ready' | 'degraded' | 'offline';
export type ShardHealthState = 'healthy' | 'stale' | 'failed';
export type ShardRuntimeState =
  | 'preparing'
  | 'running'
  | 'detached'
  | 'awaiting_delivery'
  | 'completed'
  | 'failed';
export type ShardArtifactLifecycleState = 'pending' | 'available' | 'delivered' | 'none';
export type ShardResumeMode = 'none' | 'delivery';

export interface ShardSourceContext {
  channelId: string;
  requestId?: string;
  turnId?: string;
}

export interface ShardContextPackEntry {
  role: SessionEntry['role'];
  content: string;
  authorName?: string;
  timestamp: number;
}

export interface ShardTranscriptContextSnapshot {
  kind: 'session_entries';
  entries: ShardContextPackEntry[];
}

export interface ShardMemoryContextSnapshot {
  kind: 'memory_block';
  content: string;
}

export interface ShardParentContextSnapshot {
  purpose: 'shard_context';
  inheritedFrom: 'source_channel';
  task: string;
  source: ShardSourceContext;
  transcript: ShardTranscriptContextSnapshot;
  memory?: ShardMemoryContextSnapshot;
}

export interface ShardPromptDiscipline {
  stablePrefix: string;
  remit: string;
  guardrails: string[];
}

export interface ShardConfig {
  name: string;                       // Human-readable label
  task: string;                       // The task the shard should complete
  creationMode?: ShardCreationMode;   // Explicit shard creation mode (default: fresh)
  systemPrompt?: string;              // Optional shard remit/discipline supplement
  maxTurns?: number;                  // Max conversation turns (default: 1)
  sourceContext?: ShardSourceContext;
  parentContext?: ShardParentContextSnapshot;
  capabilities?: string[];            // Declared capability tokens for routing diagnostics
  requiredCapabilities?: string[]; // Required capability tokens to route this workload
  heartbeatStaleAfterMs?: number;  // Optional override for stale heartbeat threshold
  heartbeatDisconnectAfterMs?: number; // Optional override for stale-eviction timeout
  gatewayRouting?: GatewayRoutingEnvelope;
}

export interface ShardResult {
  shardId: string;
  name: string;
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  turns: number;
  creationMode: ShardCreationMode;
  lifecycleState: ShardLifecycleState;
  runtimeState: ShardRuntimeState;
  runtimeStateReason: string;
  health: ShardHealthState;
  stateReason: string;
  artifactLifecycleState: ShardArtifactLifecycleState;
  artifactAvailableAt?: number;
  deliveredAt?: number;
  failureReason?: string;
  capabilities: string[];
  requiredCapabilities: string[];
  lineage: ShardLineage;
  gatewayRouting: GatewayRoutingEnvelope;
}

export type ShardStatus = 'running' | 'completed' | 'failed';

export interface ShardRuntimeRecord {
  shardId: string;
  name: string;
  task: string;
  channelId: string;
  createdAt: number;
  startedAt: number;
  completedAt?: number;
  creationMode: ShardCreationMode;
  lifecycleState: ShardLifecycleState;
  runtimeState: ShardRuntimeState;
  runtimeStateReason: string;
  stateReason: string;
  health: ShardHealthState;
  lastTransitionAt: number;
  lastHeartbeatAt: number;
  heartbeatStaleAfterMs: number;
  heartbeatDisconnectAfterMs: number;
  artifactLifecycleState: ShardArtifactLifecycleState;
  artifactUpdatedAt: number;
  artifactAvailableAt?: number;
  deliveredAt?: number;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  turns: number;
  content?: string;
  failureReason?: string;
  capabilities: string[];
  requiredCapabilities: string[];
  lineage: ShardLineage;
  gatewayRouting: GatewayRoutingEnvelope;
}

export interface ShardRuntimeArtifactView {
  kind: 'final_output';
  lifecycleState: Exclude<ShardArtifactLifecycleState, 'pending' | 'none'>;
  content: string;
  timestamp: number;
  deliveredAt?: number;
}

export interface ShardRuntimeResumeView {
  channelId: string;
  lifecycleState: ShardLifecycleState;
  runtimeState: ShardRuntimeState;
  health: ShardHealthState;
  mode: ShardResumeMode;
  resumable: boolean;
  artifactLifecycleState: ShardArtifactLifecycleState;
  artifactAvailable: boolean;
  deliveryPending: boolean;
  transcriptAvailable: boolean;
  transcriptMessageCount: number;
  transcriptTruncated: boolean;
  lastActivityAt?: number;
  artifactAvailableAt?: number;
  deliveredAt?: number;
  lastMessageId?: number;
}

export interface ShardRuntimeTaskView {
  task: ShardRuntimeRecord;
  transcript: SessionEntry[];
  transcriptMessageCount: number;
  transcriptTruncated: boolean;
  artifacts: ShardRuntimeArtifactView[];
  resume: ShardRuntimeResumeView;
}

export interface ShardRuntimeSnapshot {
  generatedAt: number;
  activeCount: number;
  activeShards: ShardRuntimeTaskView[];
  recentShards: ShardRuntimeTaskView[];
}

export interface ShardRuntimeSnapshotOptions {
  shardLimit?: number;
  transcriptLimit?: number;
}

export interface ShardRuntimeSnapshotProvider {
  getRuntimeSnapshot(options?: ShardRuntimeSnapshotOptions): ShardRuntimeSnapshot;
}
