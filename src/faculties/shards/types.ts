import type { SessionEntry } from '../../core/session/types.js';
import type { ShardCreationMode as RoutingShardCreationMode } from '../../shared/routing/envelope.js';
import type { ShardResultLineageEnvelope, ShardSourceContext } from './lineage-contracts.js';
import type { ArtifactReturnBatch } from './artifact-return-port.js';

// ── Shard types ──
// Ephemeral sub-agent instances for parallel task execution.

export type ShardLifecycleState = 'registering' | 'ready' | 'degraded' | 'offline';
export type ShardHealthState = 'healthy' | 'stale' | 'failed';
export type ShardCreationMode = RoutingShardCreationMode;

export type { ShardSourceContext } from './lineage-contracts.js';

export interface ShardContextPackEntry {
  role: SessionEntry['role'];
  content: string;
  authorName?: string;
  timestamp: number;
}

export interface ShardContextPack {
  purpose: 'shard_context';
  task: string;
  source: ShardSourceContext;
  sessionEntries: ShardContextPackEntry[];
  memoryBlock?: string;
}

export interface ShardParentContextSnapshot {
  inheritedFrom: string;
  source: ShardSourceContext;
  task: string;
  transcript: {
    entries: ShardContextPackEntry[];
  };
  memory?: {
    content: string;
  };
}

export interface ShardPromptDiscipline {
  stablePrefix: string;
  remit: string;
  guardrails: readonly string[];
}

export type ShardTaggedOutputSource = 'memory_write' | 'memory_import_batch';
export type ShardTaggedOutputKind = 'l0_output' | 'l2_memory';
export type ShardTaggedOutputReviewState = 'pending' | 'approved' | 'blocked' | 'rejected';

export interface ShardTaggedOutputProvenance {
  coreCompanionId: string;
  shardCompanionId: string;
  shardId: string;
  channelId: string;
  task: string;
  source: ShardTaggedOutputSource;
  sourceToolName?: string;
  toolCallId?: string;
  lineage: ShardResultLineageEnvelope;
  tags: string[];
}

export interface ShardTaggedOutput {
  outputId: string;
  kind: ShardTaggedOutputKind;
  label: string;
  content: string;
  preview: string;
  createdAt: number;
  reviewRequired: true;
  reviewState: ShardTaggedOutputReviewState;
  blockedCorePromotion: boolean;
  blockedCorePromotionReason?: string;
  provenance: ShardTaggedOutputProvenance;
}

export interface ShardWorkLogEntry {
  timestamp: number;
  message: string;
  details: string[];
}

export interface ShardMergeReview {
  required: boolean;
  status: 'none' | 'pending' | 'approved' | 'blocked';
  validationPath: string;
  lastUpdatedAt: number;
  pendingTaggedOutputCount: number;
  blockingReasons: string[];
}

export interface ShardRuntimeRecord {
  channelId: string;
  task: string;
  lineage: ShardResultLineageEnvelope;
  taggedOutputs: ShardTaggedOutput[];
  mergeReview: ShardMergeReview;
}

export interface ShardConfig {
  name: string;                    // Human-readable label
  task: string;                    // The prompt to send to the shard
  systemPrompt?: string;           // Override parent's system prompt (default: inherit)
  maxTurns?: number;               // Max conversation turns (default: 1)
  sourceContext?: ShardSourceContext;
  contextPack?: ShardContextPack;
  capabilities?: string[];         // Declared capability tokens for routing diagnostics
  requiredCapabilities?: string[]; // Required capability tokens to route this workload
  heartbeatStaleAfterMs?: number;  // Optional override for stale heartbeat threshold
  heartbeatDisconnectAfterMs?: number; // Optional override for stale-eviction timeout
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
  lifecycleState: ShardLifecycleState;
  health: ShardHealthState;
  stateReason: string;
  failureReason?: string;
  capabilities: string[];
  requiredCapabilities: string[];
  lineage: ShardResultLineageEnvelope;
  artifactReturn?: ArtifactReturnBatch;
}

export type ShardStatus = 'running' | 'completed' | 'failed';
