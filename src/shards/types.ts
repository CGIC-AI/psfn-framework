// ── Shard types ──
// Ephemeral sub-agent instances for parallel task execution.

export interface ShardSourceContext {
  channelId: string;
  requestId?: string;
  turnId?: string;
}

export interface ShardContextPackEntry {
  role: 'user' | 'assistant' | 'system';
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
}

export type ShardStatus = 'running' | 'completed' | 'failed';
