import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ReflectionJournalStore } from './reflection-journal.js';
import { buildInternalStateSnapshotRef, cloneInternalState, InternalStateComputer } from '../../core/self-model/state.js';

function buildInternalStateSample() {
  const state = new InternalStateComputer().computeState({
    emotionState: {
      vad: { valence: 0.15, arousal: 0.4, dominance: 0.2 },
      mood: { valence: 0.1, arousal: 0.3, dominance: 0.1 },
      discrete: { calm: 0.5, curiosity: 0.6 },
      confidence: 0.8,
    },
    activeConcerns: [{
      id: 'concern-1',
      text: 'Track value continuity across reflections',
      priority: 'high',
      source: 'heartbeat',
      createdAt: '2026-03-01T00:00:00.000Z',
      expiresAt: '2026-03-02T00:00:00.000Z',
    }],
    trustLevel: 'trusted',
    contactId: 'contact-1',
    sessionMetrics: {
      userMessageText: 'How have I been processing today?',
      responseText: 'I have been steady with moments of uncertainty.',
      toolCallCount: 1,
      recentTurnCount: 5,
      lastSeenDeltaSeconds: 180,
    },
  });
  return {
    state,
    snapshotRef: buildInternalStateSnapshotRef(state),
  };
}

describe('ReflectionJournalStore', () => {
  let tempDir: string;
  let filePath: string;
  let store: ReflectionJournalStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'reflection-journal-'));
    filePath = join(tempDir, 'journal.jsonl');
    store = new ReflectionJournalStore(filePath);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('appends baseline reflection entries', () => {
    const entry = store.append({
      templateId: 'musing',
      templateName: 'Musing',
      prompt: 'Share a brief reflection.',
      reflection: 'I felt grounded today.',
      channelId: 'internal:reflection:musing',
      mode: 'agent',
      createdAt: '2026-03-02T00:00:00.000Z',
    });

    expect(entry.templateId).toBe('musing');
    expect(entry.templateName).toBe('Musing');
    const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
  });

  it('normalizes legacy whisper template ids to musing on append', () => {
    const entry = store.append({
      templateId: 'whisper',
      templateName: 'Whisper',
      prompt: 'Share a brief reflection.',
      reflection: 'I felt grounded today.',
      channelId: 'internal:reflection:whisper',
      mode: 'agent',
      createdAt: '2026-03-02T00:00:00.000Z',
    });

    expect(entry.templateId).toBe('musing');
    expect(entry.templateName).toBe('Musing');
    const raw = readFileSync(filePath, 'utf-8').trim();
    const persisted = JSON.parse(raw) as { templateId: string };
    expect(persisted.templateId).toBe('musing');
  });

  it('lists recent entries in descending createdAt order', () => {
    store.append({
      templateId: 'musing',
      templateName: 'Musing',
      prompt: 'Share a brief reflection.',
      reflection: 'Earlier reflection.',
      channelId: 'internal:reflection:musing',
      mode: 'agent',
      createdAt: '2026-03-02T00:00:00.000Z',
    });
    store.append({
      templateId: 'experiential-review',
      templateName: 'Experiential Review',
      prompt: 'Describe your recent experience.',
      reflection: 'Later reflection.',
      channelId: 'internal:reflection:experiential-review',
      mode: 'agent',
      createdAt: '2026-03-02T01:00:00.000Z',
    });

    const entries = store.listRecent({ limit: 1 });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.templateId).toBe('experiential-review');
    expect(entries[0]?.reflection).toBe('Later reflection.');
  });

  it('persists internal-state narrative context when provided', () => {
    const sample = buildInternalStateSample();
    store.append({
      templateId: 'experiential-review',
      templateName: 'Experiential Review',
      prompt: 'Describe your recent experience.',
      reflection: 'I noticed a focused but slightly uncertain processing pattern.',
      channelId: 'internal:reflection:experiential-review',
      mode: 'agent',
      telemetry: {
        narrativeContext: {
          internalStateSnapshotRef: sample.snapshotRef,
          internalState: sample.state,
          metacognitiveFlags: [{ flag: 'uncertainty', confidence: 0.58 }],
        },
      },
      createdAt: '2026-03-02T01:00:00.000Z',
    });

    const raw = readFileSync(filePath, 'utf-8').trim();
    const persisted = JSON.parse(raw) as {
      telemetry?: {
        narrativeContext?: {
          internalStateSnapshotRef?: string;
          internalState?: unknown;
          metacognitiveFlags?: Array<{ flag: string; confidence: number }>;
        };
      };
    };
    expect((persisted as Record<string, unknown>).internalStateSnapshotRef).toBeUndefined();
    expect((persisted as Record<string, unknown>).metacognitiveFlags).toBeUndefined();
    expect(persisted.telemetry?.narrativeContext?.internalStateSnapshotRef).toBe(sample.snapshotRef);
    expect(persisted.telemetry?.narrativeContext?.internalState).toEqual(cloneInternalState(sample.state));
    expect(persisted.telemetry?.narrativeContext?.metacognitiveFlags).toEqual([{ flag: 'uncertainty', confidence: 0.58 }]);
  });

  it('fails closed when internal-state context is partial', () => {
    expect(() => store.append({
      templateId: 'experiential-review',
      templateName: 'Experiential Review',
      prompt: 'Describe your recent experience.',
      reflection: 'I noticed a focused processing pattern.',
      channelId: 'internal:reflection:experiential-review',
      mode: 'agent',
      internalStateSnapshotRef: 'internal-state-v1:abc',
    })).toThrow('internalStateSnapshotRef and internalState');
  });

  it('preserves reflection-journal normalization error prefixes', () => {
    const sample = buildInternalStateSample();

    expect(() => store.append({
      templateId: 'experiential-review',
      templateName: 'Experiential Review',
      prompt: 'Describe your recent experience.',
      reflection: 'I noticed a focused processing pattern.',
      channelId: 'internal:reflection:experiential-review',
      mode: 'agent',
      telemetry: {
        narrativeContext: {
          internalStateSnapshotRef: '   ',
          internalState: sample.state,
        },
      },
    })).toThrow('Reflection journal internalStateSnapshotRef must be a non-empty string when provided');

    expect(() => store.append({
      templateId: 'experiential-review',
      templateName: 'Experiential Review',
      prompt: 'Describe your recent experience.',
      reflection: 'I noticed a focused processing pattern.',
      channelId: 'internal:reflection:experiential-review',
      mode: 'agent',
      telemetry: {
        narrativeContext: {
          internalStateSnapshotRef: sample.snapshotRef,
          internalState: sample.state,
          metacognitiveFlags: [{ flag: '', confidence: 0.5 }],
        },
      },
    })).toThrow('Reflection journal metacognitiveFlags[0].flag must be a non-empty string');
  });
});
