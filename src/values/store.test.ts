import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ValuesJournalStore } from './store.js';
import { buildInternalStateSnapshotRef, cloneInternalState, InternalStateComputer } from '../self-model/state.js';

function buildInternalStateSample() {
  const state = new InternalStateComputer().computeState({
    emotionState: {
      vad: { valence: 0.2, arousal: 0.3, dominance: 0.1 },
      mood: { valence: 0.1, arousal: 0.2, dominance: 0.05 },
      discrete: { curiosity: 0.7, calm: 0.4 },
      confidence: 0.75,
    },
    activeConcerns: [{
      id: 'concern-1',
      text: 'Maintain coherent reflection continuity',
      priority: 'medium',
      source: 'heartbeat',
      createdAt: '2026-03-01T00:00:00.000Z',
      expiresAt: '2026-03-02T00:00:00.000Z',
    }],
    trustLevel: 'trusted',
    contactId: 'contact-1',
    sessionMetrics: {
      userMessageText: 'What did we learn from today?',
      responseText: 'We learned to anchor on lived continuity.',
      toolCallCount: 1,
      recentTurnCount: 4,
      lastSeenDeltaSeconds: 120,
    },
  });
  return {
    state,
    snapshotRef: buildInternalStateSnapshotRef(state),
  };
}

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

  it('persists internal-state narrative context when provided', () => {
    const sample = buildInternalStateSample();
    store.append({
      templateId: 'values-reflection',
      templateName: 'Values Reflection',
      prompt: 'P',
      reflection: 'R',
      internalStateSnapshotRef: sample.snapshotRef,
      internalState: sample.state,
      metacognitiveFlags: [
        { flag: 'uncertainty', confidence: 0.62, evidence: 'conflicting prior reflections' },
      ],
      createdAt: '2026-02-26T00:00:00.000Z',
    });

    const entries = store.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.internalStateSnapshotRef).toBe(sample.snapshotRef);
    expect(entries[0]?.internalState).toEqual(cloneInternalState(sample.state));
    expect(entries[0]?.metacognitiveFlags).toEqual([
      { flag: 'uncertainty', confidence: 0.62, evidence: 'conflicting prior reflections' },
    ]);
  });

  it('fails closed when internal-state context is partial', () => {
    expect(() => store.append({
      templateId: 'values-reflection',
      templateName: 'Values Reflection',
      prompt: 'P',
      reflection: 'R',
      internalStateSnapshotRef: 'internal-state-v1:abc',
    })).toThrow('internalStateSnapshotRef and internalState');
  });

  it('skips malformed internal-state narrative entries on read', () => {
    writeFileSync(
      filePath,
      [
        '{"id":"values-1","version":1,"templateId":"values-reflection","templateName":"Values Reflection","prompt":"P","reflection":"R","createdAt":"2026-02-26T00:00:00.000Z","internalStateSnapshotRef":"internal-state-v1:abc"}',
        '{"id":"values-2","version":2,"templateId":"values-reflection","templateName":"Values Reflection","prompt":"P2","reflection":"R2","createdAt":"2026-02-26T01:00:00.000Z"}',
      ].join('\n') + '\n',
      'utf-8',
    );

    const entries = store.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe('values-2');
  });

  it('migrates legacy values.jsonl into notes/values.jsonl on first access', () => {
    const legacyPath = join(tempDir, 'values.jsonl');
    const notesPath = join(tempDir, 'notes', 'values.jsonl');
    writeFileSync(
      legacyPath,
      '{"id":"values-1","version":1,"templateId":"values-reflection","templateName":"Values Reflection","prompt":"P","reflection":"R","createdAt":"2026-02-26T00:00:00.000Z"}\n',
      'utf-8',
    );

    const migrated = new ValuesJournalStore(notesPath, {
      legacyFilePaths: [legacyPath],
    });

    const entries = migrated.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe('values-1');
    expect(existsSync(notesPath)).toBe(true);
  });
});
