import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveSystemStateDir,
  resolveToolConformanceHistoryPath,
  resolveToolConformanceLatestPath,
} from '../../../persistence/layout.js';
import {
  readToolConformanceLatest,
  writeToolConformanceResult,
  TOOL_CONFORMANCE_HISTORY_LIMIT,
} from './store.js';
import type { ToolConformanceRunResult } from './types.js';

function makeResult(ranAt: number): ToolConformanceRunResult {
  return {
    schemaVersion: 1,
    ranAt,
    trigger: 'manual',
    results: [
      { toolName: 'memory', probeKind: 'read_only', action: 'census', ok: true, durationMs: 3 },
      { toolName: 'notify', probeKind: 'schema_only', ok: true, durationMs: 0 },
      { toolName: 'memory', probeKind: 'rejection_check', action: 'action', ok: true, durationMs: 1 },
    ],
  };
}

describe('tool conformance store', () => {
  let systemDataDir: string;

  beforeEach(() => {
    systemDataDir = mkdtempSync(join(tmpdir(), 'tool-conformance-'));
  });

  afterEach(() => {
    rmSync(systemDataDir, { recursive: true, force: true });
  });

  it('writes the latest result under <system-data>/state with the exact schema', () => {
    const result = makeResult(1_700_000_000_000);
    writeToolConformanceResult(systemDataDir, result);

    const latestPath = resolveToolConformanceLatestPath(systemDataDir);
    expect(latestPath).toBe(join(systemDataDir, 'state', 'tool-conformance-latest.json'));

    const parsed = JSON.parse(readFileSync(latestPath, 'utf-8')) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['ranAt', 'results', 'schemaVersion', 'trigger']);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.ranAt).toBe(1_700_000_000_000);
    expect(parsed.trigger).toBe('manual');
    const entry = (parsed.results as Array<Record<string, unknown>>)[0];
    expect(Object.keys(entry).sort()).toEqual(['action', 'durationMs', 'ok', 'probeKind', 'toolName']);
  });

  it('round-trips via readToolConformanceLatest', () => {
    const result = makeResult(42);
    writeToolConformanceResult(systemDataDir, result);
    expect(readToolConformanceLatest(systemDataDir)).toEqual(result);
  });

  it('returns null when no run has been recorded', () => {
    expect(readToolConformanceLatest(systemDataDir)).toBeNull();
  });

  it('leaves no temp files behind (atomic write)', () => {
    writeToolConformanceResult(systemDataDir, makeResult(1));
    const files = readdirSync(resolveSystemStateDir(systemDataDir));
    expect(files.some(f => f.endsWith('.tmp'))).toBe(false);
    expect(files.sort()).toEqual(['tool-conformance-history.jsonl', 'tool-conformance-latest.json']);
  });

  it('bounds history to the last N runs (JSONL, one run per line)', () => {
    const total = TOOL_CONFORMANCE_HISTORY_LIMIT + 5;
    for (let i = 0; i < total; i++) {
      writeToolConformanceResult(systemDataDir, makeResult(1_000 + i));
    }
    const lines = readFileSync(resolveToolConformanceHistoryPath(systemDataDir), 'utf-8')
      .split('\n').filter(Boolean);
    expect(lines).toHaveLength(TOOL_CONFORMANCE_HISTORY_LIMIT);
    const first = JSON.parse(lines[0]) as ToolConformanceRunResult;
    const last = JSON.parse(lines[lines.length - 1]) as ToolConformanceRunResult;
    // Oldest retained run is the (total - N)th; newest is the last written.
    expect(first.ranAt).toBe(1_000 + (total - TOOL_CONFORMANCE_HISTORY_LIMIT));
    expect(last.ranAt).toBe(1_000 + total - 1);
  });
});
