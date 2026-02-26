import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ValuesJournalStore } from './store.js';

describe('ValuesJournalStore', () => {
  let tempDir: string;
  let filePath: string;
  let store: ValuesJournalStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'values-store-'));
    filePath = join(tempDir, 'values.jsonl');
    store = new ValuesJournalStore(filePath);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('appends versioned entries', () => {
    const first = store.append({
      templateId: 'values-reflection',
      templateName: 'Values Reflection',
      prompt: 'What matters most to me and why?',
      reflection: 'Honesty and continuity matter because they preserve trust.',
      createdAt: '2026-02-26T00:00:00.000Z',
    });
    const second = store.append({
      templateId: 'values-reflection',
      templateName: 'Values Reflection',
      prompt: 'What matters most to me and why?',
      reflection: 'Steady care matters because it prevents drift.',
      createdAt: '2026-02-26T01:00:00.000Z',
    });

    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(second.id).toBe('values-2');

    const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('lists entries newest-first and respects limit', () => {
    store.append({
      templateId: 'values-reflection',
      templateName: 'Values Reflection',
      prompt: 'P1',
      reflection: 'R1',
      createdAt: '2026-02-26T00:00:00.000Z',
    });
    store.append({
      templateId: 'values-reflection',
      templateName: 'Values Reflection',
      prompt: 'P2',
      reflection: 'R2',
      createdAt: '2026-02-26T01:00:00.000Z',
    });

    const all = store.list();
    expect(all.map(entry => entry.version)).toEqual([2, 1]);
    expect(store.list({ limit: 1 }).map(entry => entry.version)).toEqual([2]);
  });

  it('skips malformed lines while preserving valid entries', () => {
    writeFileSync(
      filePath,
      [
        '{"id":"values-1","version":1,"templateId":"values-reflection","templateName":"Values Reflection","prompt":"P","reflection":"R","createdAt":"2026-02-26T00:00:00.000Z"}',
        '{bad json',
        '{"version":2,"templateId":"values-reflection","templateName":"Values Reflection","prompt":"P2","reflection":"R2","createdAt":"2026-02-26T01:00:00.000Z"}',
      ].join('\n') + '\n',
      'utf-8',
    );

    const entries = store.list();
    expect(entries).toHaveLength(2);
    expect(entries[0]?.version).toBe(2);
    expect(entries[1]?.version).toBe(1);
  });

  it('persists deliberation metadata when provided', () => {
    store.append({
      templateId: 'values-reflection',
      templateName: 'Values Reflection',
      prompt: 'P',
      reflection: 'R',
      deliberation: {
        sessionId: 'delib-1',
        stopReason: 'fatigue_taper',
        rounds: 2,
        totalInputTokens: 111,
        totalOutputTokens: 222,
        totalTokens: 333,
        estimatedCostUsd: 0.00123,
        durationMs: 4567,
      },
      createdAt: '2026-02-26T00:00:00.000Z',
    });

    const entries = store.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.deliberation).toEqual({
      sessionId: 'delib-1',
      stopReason: 'fatigue_taper',
      rounds: 2,
      totalInputTokens: 111,
      totalOutputTokens: 222,
      totalTokens: 333,
      estimatedCostUsd: 0.00123,
      durationMs: 4567,
    });
  });
});
