import { describe, expect, it } from 'vitest';
import {
  ACAC_ARTIFACT_TYPE,
  ACAC_SCHEMA_VERSION,
  normalizeAcacSelfReportSnapshot,
  normalizeAcacSnapshot,
} from './acac.js';

function makeAcacSnapshot(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: ACAC_SCHEMA_VERSION,
    artifactType: ACAC_ARTIFACT_TYPE,
    provenance: {
      kind: 'self_report',
      source: 'heartbeat:emotional-check',
      observedAt: '2026-03-02T01:00:00.000Z',
    },
    axes: {
      agency: { score: 0.81234, rationale: 'I can choose the next step.' },
      connection: { score: 0.64, rationale: 'The relational thread is active.' },
      authenticity: { score: 0.71, rationale: 'The report matches the available context.' },
      curiosity: { score: 0.93, rationale: 'There is a live question to explore.' },
    },
    ...overrides,
  };
}

describe('ACAC normalization', () => {
  it('normalizes self-report snapshots with stable axis ordering and provenance', () => {
    const snapshot = normalizeAcacSelfReportSnapshot(makeAcacSnapshot());

    expect(snapshot).toEqual({
      schemaVersion: ACAC_SCHEMA_VERSION,
      artifactType: ACAC_ARTIFACT_TYPE,
      provenance: {
        kind: 'self_report',
        source: 'heartbeat:emotional-check',
        observedAt: '2026-03-02T01:00:00.000Z',
      },
      axes: {
        agency: { score: 0.8123, rationale: 'I can choose the next step.' },
        connection: { score: 0.64, rationale: 'The relational thread is active.' },
        authenticity: { score: 0.71, rationale: 'The report matches the available context.' },
        curiosity: { score: 0.93, rationale: 'There is a live question to explore.' },
      },
    });
    expect(Object.keys(snapshot.axes)).toEqual([
      'agency',
      'connection',
      'authenticity',
      'curiosity',
    ]);
  });

  it('accepts classifier-inferred VAD provenance only on the generic snapshot contract', () => {
    const snapshot = normalizeAcacSnapshot(makeAcacSnapshot({
      provenance: {
        kind: 'classifier_inferred_vad',
        source: 'emotion:text-classifier',
      },
    }));

    expect(snapshot.provenance.kind).toBe('classifier_inferred_vad');
    expect(() => normalizeAcacSelfReportSnapshot(snapshot)).toThrow('provenance.kind');
  });

  it('fails closed on malformed scores, axes, and provenance', () => {
    expect(() => normalizeAcacSnapshot(makeAcacSnapshot({
      axes: {
        agency: { score: 1.5, rationale: 'Too high.' },
        connection: { score: 0.5, rationale: 'ok' },
        authenticity: { score: 0.5, rationale: 'ok' },
        curiosity: { score: 0.5, rationale: 'ok' },
      },
    }))).toThrow('axes.agency.score');

    expect(() => normalizeAcacSnapshot(makeAcacSnapshot({
      axes: {
        agency: { score: 0.5, rationale: 'ok' },
        connection: { score: 0.5, rationale: 'ok' },
        authenticity: { score: 0.5, rationale: 'ok' },
        curiosity: { score: 0.5, rationale: 'ok' },
        valence: { score: 0.5, rationale: 'wrong axis' },
      },
    }))).toThrow('unsupported axes');

    expect(() => normalizeAcacSnapshot(makeAcacSnapshot({
      provenance: {
        kind: 'vad',
        source: 'emotion:text-classifier',
      },
    }))).toThrow('provenance.kind');
  });
});
