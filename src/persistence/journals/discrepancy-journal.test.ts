import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DiscrepancyJournalStore } from './discrepancy-journal.js';
import type { EmotionDiscrepancy } from '../../shared/contracts/emotion-contracts.js';

function sampleDiscrepancy(): EmotionDiscrepancy {
  return {
    kind: 'valence_vs_discrete',
    magnitude: 0.65,
    sides: [
      {
        family: 'vad_valence',
        label: 'valence',
        value: -0.5,
        confidence: 0.82,
        provenance: [{
          source: 'classifier_inferred',
          observedAtMs: Date.parse('2026-07-20T12:00:00.000Z'),
          modality: 'text',
          classifier: 'test-classifier',
          model: 'test-model',
          provenanceRef: 'emotion:turn-1',
        }],
      },
      {
        family: 'discrete_affect',
        label: 'love',
        value: 0.8,
        confidence: 0.82,
        provenance: [{
          source: 'classifier_inferred',
          observedAtMs: Date.parse('2026-07-20T12:00:00.000Z'),
          modality: 'text',
        }],
      },
    ],
  };
}

describe('DiscrepancyJournalStore', () => {
  let tmpDir: string;
  let store: DiscrepancyJournalStore;
  let filePath: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `discrepancy-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(tmpDir, { recursive: true });
    filePath = join(tmpDir, 'discrepancies.jsonl');
    store = new DiscrepancyJournalStore(filePath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('round-trips a discrepancy entry with both sides’ provenance and confidence intact', () => {
    const appended = store.append({
      templateId: 'mixed-state-review',
      templateName: 'Mixed-State Reflection',
      channelId: 'heartbeat',
      internalStateSnapshotRef: 'snapshot-abc',
      discrepancies: [sampleDiscrepancy()],
      createdAt: '2026-07-20T12:00:05.000Z',
    });

    expect(appended.id).toMatch(/^discrepancy-/);

    const [entry] = store.listRecent();
    expect(entry).toBeDefined();
    expect(entry.templateId).toBe('mixed-state-review');
    expect(entry.internalStateSnapshotRef).toBe('snapshot-abc');
    expect(entry.discrepancies).toHaveLength(1);

    const [restored] = entry.discrepancies;
    expect(restored.kind).toBe('valence_vs_discrete');
    // Both sides survive verbatim — value, confidence, and full provenance.
    const valenceSide = restored.sides.find(s => s.family === 'vad_valence');
    const discreteSide = restored.sides.find(s => s.family === 'discrete_affect');
    expect(valenceSide?.value).toBe(-0.5);
    expect(valenceSide?.confidence).toBe(0.82);
    expect(valenceSide?.provenance[0]?.provenanceRef).toBe('emotion:turn-1');
    expect(valenceSide?.provenance[0]?.classifier).toBe('test-classifier');
    expect(discreteSide?.label).toBe('love');
    expect(discreteSide?.value).toBe(0.8);
    expect(discreteSide?.confidence).toBe(0.82);
    expect(discreteSide?.provenance[0]?.source).toBe('classifier_inferred');
  });

  it('fails closed on an empty discrepancy array', () => {
    expect(() => store.append({
      templateId: 'mixed-state-review',
      templateName: 'Mixed-State Reflection',
      channelId: 'heartbeat',
      internalStateSnapshotRef: 'snapshot-abc',
      discrepancies: [],
    })).toThrow(/must not be empty/);
  });

  it('fails closed when a side is missing its provenance', () => {
    const broken = sampleDiscrepancy();
    (broken.sides[0] as { provenance?: unknown }).provenance = undefined;
    expect(() => store.append({
      templateId: 'mixed-state-review',
      templateName: 'Mixed-State Reflection',
      channelId: 'heartbeat',
      internalStateSnapshotRef: 'snapshot-abc',
      discrepancies: [broken],
    })).toThrow(/provenance/);
  });

  it('fails closed when required metadata is blank', () => {
    expect(() => store.append({
      templateId: '   ',
      templateName: 'Mixed-State Reflection',
      channelId: 'heartbeat',
      internalStateSnapshotRef: 'snapshot-abc',
      discrepancies: [sampleDiscrepancy()],
    })).toThrow(/requires templateId/);
  });

  it('skips corrupt lines on read and returns the valid entries', () => {
    store.append({
      templateId: 'mixed-state-review',
      templateName: 'Mixed-State Reflection',
      channelId: 'heartbeat',
      internalStateSnapshotRef: 'snapshot-good',
      discrepancies: [sampleDiscrepancy()],
    });
    // A corrupt line (missing discrepancies) must not sink the whole log.
    appendFileSync(filePath, `${JSON.stringify({ id: 'x', templateId: 'y', templateName: 'z', channelId: 'c', internalStateSnapshotRef: 'r', createdAt: '2026-07-20T00:00:00.000Z' })}\n`, 'utf-8');
    appendFileSync(filePath, 'not-json\n', 'utf-8');

    const entries = store.listRecent();
    expect(entries).toHaveLength(1);
    expect(entries[0].internalStateSnapshotRef).toBe('snapshot-good');
  });
});
