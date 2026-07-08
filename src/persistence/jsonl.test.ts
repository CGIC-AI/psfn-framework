import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendJsonLine,
  appendShardSessionMemorySyncAudit,
  readJsonLines,
  type ReadJsonLineErrorContext,
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

  it('reads jsonl entries with skipped and corrupt line counts', () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-jsonl-read-'));
    tempRoots.push(root);
    const path = join(root, 'events.jsonl');
    writeFileSync(
      path,
      [
        JSON.stringify({ value: 1 }),
        JSON.stringify({ ignored: true }),
        '{bad json',
        '',
        JSON.stringify({ value: 2 }),
      ].join('\n'),
      'utf-8',
    );

    const errors: ReadJsonLineErrorContext[] = [];
    const result = readJsonLines(path, (raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      const value = (raw as Record<string, unknown>).value;
      return typeof value === 'number' ? value : null;
    }, {
      onError: error => errors.push(error),
    });

    expect(result.entries).toEqual([1, 2]);
    expect(result.skipped).toBe(1);
    expect(result.corrupt).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.line).toBe(3);
  });

  it('returns empty read results for missing jsonl files', () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-jsonl-missing-'));
    tempRoots.push(root);

    expect(readJsonLines(join(root, 'missing.jsonl'), raw => raw)).toEqual({
      entries: [],
      skipped: 0,
      corrupt: 0,
    });
  });
});
