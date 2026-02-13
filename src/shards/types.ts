// ── Shard types ──
// Ephemeral sub-agent instances for parallel task execution.

export interface ShardConfig {
  name: string;                    // Human-readable label
  task: string;                    // The prompt to send to the shard
  systemPrompt?: string;           // Override parent's system prompt (default: inherit)
  maxTurns?: number;               // Max conversation turns (default: 1)
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
