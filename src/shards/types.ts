import type { EmbodimentPresenceMetadata } from '../agent/presence-metadata.js';
import type { SessionEntry } from '../session/types.js';
import type { ShardResultLineageEnvelope } from './result-lineage.js';
import type { ShardReturnedArtifact } from './artifact-policy.js';

// ── Shard types ──
// Ephemeral sub-agent instances for parallel task execution.

export type ShardLifecycleState = 'registering' | 'ready' | 'degraded' | 'offline';
export type ShardHealthState = 'healthy' | 'stale' | 'failed';

export interface ShardSourceContext {
  channelId: string;
  requestId?: string;
  turnId?: string;
  embodimentContext?: EmbodimentPresenceMetadata;
}

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
  artifacts?: ShardReturnedArtifact[];
}

export type ShardStatus = 'running' | 'completed' | 'failed';
