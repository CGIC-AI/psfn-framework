import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReflectionMetacognitionJournalStore } from './reflection-metacognition-journal.js';

describe('ReflectionMetacognitionJournalStore', () => {
  let tempDir: string;
  let filePath: string;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it('appends authoritative reflection-run entries and lists them newest first', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'reflection-metacognition-journal-'));
    filePath = join(tempDir, 'journal.jsonl');
    const store = new ReflectionMetacognitionJournalStore(filePath, {
      now: () => 1_700_000_000_000,
    });

    await store.append({
      kind: 'reflection_run',
      templateId: 'values-reflection',
      templateName: 'Values Reflection',
      occurredAt: '2026-04-02T10:00:00.000Z',
      executionSource: 'scheduled',
      initiatorSurface: 'scheduler:reflection_template',
      initiatedBy: 'scheduler',
      reason: 'Scheduled reflection run',
      channelId: 'internal:reflection:values-reflection',
      sendToDiscordEffective: false,
      mode: 'deliberation',
      prompt: 'Reflect on values.',
      reflection: 'Continuity and care remained durable values.',
      internalStateSnapshotRef: 'snapshot-1',
      metacognitiveFlags: [{ flag: 'continuity', confidence: 0.72 }],
      reflectionJournalEntryId: 'reflection-1',
      dailyJournalEntryId: 'daily-1',
      processId: 'process-1',
    });
    await store.append({
      kind: 'reflection_mutation',
      occurredAt: '2026-04-02T11:00:00.000Z',
      initiatorSurface: 'scheduler:reflection_template',
      initiatedBy: 'scheduler',
      reason: 'Reflection policy narrowed cadence after over-triggering',
      templateId: 'values-reflection',
      templateName: 'Values Reflection',
      mutationBefore: { intervalMinutes: 60 },
      mutationAfter: { intervalMinutes: 180 },
    });

    const raw = readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(raw).toHaveLength(2);

    const recent = store.listRecent();
    expect(recent.map(entry => entry.kind)).toEqual(['reflection_mutation', 'reflection_run']);
    expect(recent[1]?.metacognitiveFlags).toEqual([{ flag: 'continuity', confidence: 0.72 }]);
    expect(recent[0]?.mutationAfter).toEqual({ intervalMinutes: 180 });
  });

  it('rejects mutation entries that omit before/after snapshots', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'reflection-metacognition-journal-'));
    filePath = join(tempDir, 'journal.jsonl');
    const store = new ReflectionMetacognitionJournalStore(filePath);

    await expect(store.append({
      kind: 'reflection_mutation',
      occurredAt: '2026-04-02T11:00:00.000Z',
      initiatorSurface: 'scheduler:reflection_template',
      initiatedBy: 'scheduler',
      reason: 'Missing snapshots',
    })).rejects.toThrow('requires mutationBefore or mutationAfter');
  });
});
