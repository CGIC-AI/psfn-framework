import { describe, expect, it } from 'vitest';
import {
  requireHumanEscalationLedgerBounds,
  validateHumanEscalationRecord,
  type HumanEscalationRecord,
} from './contracts.js';

const RECORD: HumanEscalationRecord = {
  schemaVersion: 1,
  escalationId: '6f1c2b3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d',
  kind: 'runtime_incident',
  severity: 'critical',
  owner: { kind: 'system' },
  dedupeKey: 'incident-1',
  sourceRef: 'incident-1',
  labels: ['operator_alerting'],
  evidence: { configuredSinkCount: 0 },
  detailPath: '/incidents',
  state: 'open',
  resolution: null,
  raisedAtMs: 1_800_000_000_000,
  lastRaisedAtMs: 1_800_000_000_000,
  lastNotifiedAtMs: null,
  raiseCount: 1,
};

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...RECORD, ...overrides };
}

describe('validateHumanEscalationRecord', () => {
  it('accepts a well-formed open record unchanged', () => {
    expect(validateHumanEscalationRecord(record())).toEqual(RECORD);
  });

  it('rejects an unknown key rather than passing it through to an operator surface', () => {
    expect(() => validateHumanEscalationRecord(record({
      operatorNote: 'the customer said their card was declined',
    }))).toThrow(/must carry exactly/u);
  });

  it('rejects a record missing a declared key', () => {
    const value = record();
    delete value.lastNotifiedAtMs;

    expect(() => validateHumanEscalationRecord(value)).toThrow(/must carry exactly/u);
  });

  it('still rejects a malformed value inside an otherwise exact key set', () => {
    expect(() => validateHumanEscalationRecord(record({ raiseCount: 0 })))
      .toThrow(/raiseCount must be a positive safe integer/u);
  });
});

describe('requireHumanEscalationLedgerBounds', () => {
  const bounds = {
    resolvedRetentionMs: 604_800_000,
    maxResolvedRowsPerKind: 256,
    maxAttemptsPerEscalation: 64,
    maxOpenRowsPerKind: 128,
  };

  it('returns the declared bounds', () => {
    expect(requireHumanEscalationLedgerBounds(bounds)).toEqual(bounds);
  });

  it('refuses a missing block rather than defaulting a bound', () => {
    expect(() => requireHumanEscalationLedgerBounds(undefined as never))
      .toThrow(/requires the owner-file retention bounds/u);
  });

  it('refuses a non-positive bound', () => {
    expect(() => requireHumanEscalationLedgerBounds({ ...bounds, maxOpenRowsPerKind: -1 }))
      .toThrow(/positive owner-file maxOpenRowsPerKind/u);
  });
});
