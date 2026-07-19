import type { SessionEntry } from '../../core/session/types.js';
import type { ShardCreationMode as RoutingShardCreationMode } from '../../shared/routing/envelope.js';
import type { ShardResultLineageEnvelope, ShardSourceContext } from './lineage-contracts.js';
import type { ArtifactReturnBatch } from './artifact-return-port.js';
import type {
  CompanionId,
  ShardCompanionId,
} from '../../shared/routing/companion-id.js';
import type { CapabilityTier } from '../../system/capabilities/tier-types.js';
import type { CapabilityToken } from '../../system/capabilities/tokens.js';
import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { SatelliteRoutingMetadata } from '../../core/agent/satellite-adapter-port.js';

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
  companionName?: string;
  sessionEntries: ShardContextPackEntry[];
  memoryBlock?: string;
}

export interface ShardParentContextSnapshot {
  inheritedFrom: string;
  source: ShardSourceContext;
  task: string;
  companionName?: string;
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
  coreCompanionId: CompanionId;
  shardCompanionId: ShardCompanionId;
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

/**
 * Immutable, audit-safe evidence for the capability authority bound to one
 * shard launch. Routing capability arrays remain separate and cannot alter
 * these authorization fields.
 */
export interface ShardCapabilityGrantEvidence {
  readonly parentTier: CapabilityTier;
  readonly derivedTier: 'custom';
  readonly tokens: readonly CapabilityToken[];
  readonly ownerVersion: string;
  readonly grantDigest: string;
  readonly denialMask: readonly CapabilityToken[];
  readonly derivationVersion: string;
}

export interface ShardModelSelection {
  provider: string;
  model: string;
  maxOutputTokens: number;
  contextWindow?: number;
}

export interface ShardWorkerBudget {
  maxTurns: number;
  maxOutputTokens: number;
  maxChargeUnits: number;
}

export interface ShardReadOnlyConfiguration {
  capabilityTier: {
    parent: CapabilityTier;
    effective: 'custom';
  };
  trust: {
    source: 'parent_runtime';
    mutable: false;
  };
  identity: {
    parentCompanionId: CompanionId;
    shardCompanionId: ShardCompanionId;
    mutable: false;
  };
  prompts: {
    source: 'parent_launch_snapshot';
    mutable: false;
  };
  capabilityGrant: ShardCapabilityGrantEvidence;
}

export interface ShardConfigurationValues {
  model: ShardModelSelection;
  workerBudget: ShardWorkerBudget;
  readOnly: ShardReadOnlyConfiguration;
}

export interface ShardConfigurationOverrides {
  model: Pick<ShardModelSelection, 'provider' | 'model'> | null;
  workerBudget: Partial<ShardWorkerBudget>;
  readOnly: null;
}

export interface ShardConfigurationSnapshot {
  schemaVersion: 1;
  shardId: string;
  parentCompanionId: CompanionId;
  lifecycleState: ShardLifecycleState;
  health: ShardHealthState;
  source: {
    kind: 'parent_launch';
    companionId: CompanionId;
    revision: string;
    capabilityOwnerVersion: string;
    grantDigest: string;
    capturedAt: number;
  };
  inherited: ShardConfigurationValues;
  override: ShardConfigurationOverrides;
  effective: ShardConfigurationValues;
  allowed: {
    models: ShardModelSelection[];
    workerBudget: ShardWorkerBudget;
  };
  lineage: ShardResultLineageEnvelope;
  updatedAt?: number;
  updatedBy?: string;
}

export interface ShardConfigurationOverridePatch {
  model?: Pick<ShardModelSelection, 'provider' | 'model'> | null;
  workerBudget?: Partial<ShardWorkerBudget> | null;
}

export type ShardConfigurationMutationResult =
  | {
      ok: true;
      snapshot: ShardConfigurationSnapshot;
    }
  | {
      ok: false;
      code: 'not_found' | 'invalid_override';
      message: string;
    };

export interface ShardConfig {
  name: string;                    // Human-readable label
  task: string;                    // The prompt to send to the shard
  systemPrompt?: string;           // Override parent's system prompt (default: inherit)
  maxTurns?: number;               // Max conversation turns (default: 1, capped by agent loop ceiling)
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
  capabilityGrant: ShardCapabilityGrantEvidence;
  lineage: ShardResultLineageEnvelope;
  artifactReturn?: ArtifactReturnBatch;
}

export type ShardStatus = 'running' | 'completed' | 'failed';

export interface SatelliteDelegationRequest {
  message: SubstrateMessage;
  routing?: SatelliteRoutingMetadata;
  shardName?: string;
}

export interface ActiveShard {
  id: string;
  name: string;
  task: string;
  startedAt: number;
  channelId: string;
  state: ShardLifecycleState;
  stateReason: string;
  health: ShardHealthState;
  lastTransitionAt: number;
  lastHeartbeatAt: number;
  heartbeatStaleAfterMs: number;
  heartbeatDisconnectAfterMs: number;
  capabilities: string[];
  requiredCapabilities: string[];
  capabilityGrant: ShardCapabilityGrantEvidence;
  lineage: ShardResult['lineage'];
  failureReason?: string;
}

/**
 * Ordinary-priority shard->parent ICP delivery. Lives here (not in port.ts)
 * so the parent ICP runtime can depend on the type without importing the
 * execution-port module, which reaches back into the manager.
 */
export interface ShardParentIcpPort {
  sendShardParentIcp(shardId: string, content: string): Promise<string>;
}
