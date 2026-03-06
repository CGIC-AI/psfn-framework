import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendJsonLine,
  appendShardSessionMemorySyncAudit,
} from './jsonl.js';

describe('jsonl append helpers', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots) {
      rmSync(root, { recursive: true, force: true });
    }
    tempRoots.length = 0;
  });

  it('appends generic jsonl entries', () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-jsonl-'));
    tempRoots.push(root);
    const path = join(root, 'events', 'generic.jsonl');

    appendJsonLine(path, { event: 'alpha' });
    appendJsonLine(path, { event: 'beta' });

    const lines = readFileSync(path, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ event: 'alpha' });
    expect(JSON.parse(lines[1])).toEqual({ event: 'beta' });
  });

  it('appends shard session/memory sync audit records', () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-shard-sync-jsonl-'));
    tempRoots.push(root);
    const path = join(root, 'audit', 'shard-session-memory-sync-audit.jsonl');

    appendShardSessionMemorySyncAudit(path, {
      timestamp: 1_706_000_000_000,
      shardId: 'shard-123',
      syncClass: 'derived_memory',
      direction: 'shard_to_prime',
      authority: 'shard',
      operation: 'memory_write',
      sourceId: 'shard:shard-123',
      targetId: 'memory:index',
      idempotencyKey: 'tool-call-1',
      decision: 'ALLOW',
      reason: 'allowed_shard_memory_write',
    });

    const parsed = JSON.parse(readFileSync(path, 'utf-8').trim()) as Record<string, unknown>;
    expect(parsed.shardId).toBe('shard-123');
    expect(parsed.operation).toBe('memory_write');
    expect(parsed.decision).toBe('ALLOW');
    expect(parsed.reason).toBe('allowed_shard_memory_write');
  });
});
