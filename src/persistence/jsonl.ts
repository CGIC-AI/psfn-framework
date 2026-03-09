import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function appendJsonLine(path: string, entry: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf-8');
}

export interface ShardSessionMemorySyncAuditJsonlEntry {
  timestamp: number;
  shardId: string;
  syncClass: 'transcript_fact' | 'derived_memory' | 'runtime_state';
  direction: 'prime_to_shard' | 'shard_to_prime';
  authority: 'prime' | 'shard' | 'runtime';
  operation: string;
  sourceId: string;
  targetId: string;
  idempotencyKey: string;
  decision: 'ALLOW' | 'DENY';
  reason: string;
}

export function appendShardSessionMemorySyncAudit(
  path: string,
  entry: ShardSessionMemorySyncAuditJsonlEntry,
): void {
  appendJsonLine(path, entry);
}
