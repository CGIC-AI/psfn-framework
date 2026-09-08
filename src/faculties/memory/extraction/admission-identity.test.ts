import { describe, expect, it } from 'vitest';
import type { SessionEntry } from '../../../core/session/types.js';
import type { IntakeEnvelopeSnapshot } from '../../../shared/contracts/intake-envelope.js';
import {
  buildAdmissionProvenanceRefs,
  buildExtractionAdmissionIndex,
  resolveAdmissionEnvelopesForSource,
} from './admission-identity.js';

const ENVELOPE_A = 'env_01JZ00000000000000000000AA';
const ENVELOPE_B = 'env_01JZ00000000000000000000BB';
const RECEIPT_A = 'rcpt_01JZ00000000000000000000AA';

function snapshot(overrides: Partial<IntakeEnvelopeSnapshot> & { envelopeId: string }) {
  return {
    sourceClass: 'public_contact',
    sourceRiskTier: 'untrusted',
    state: 'released',
    riskLabels: [],
    subject: { kind: 'body' },
    ...overrides,
  };
}

function entry(id: number, envelopes: unknown[] | 'malformed' | 'none'): SessionEntry {
  const base: SessionEntry = {
    id,
    channelId: 'room',
    role: 'user',
    content: `payload ${id}`,
    timestamp: id,
  };
  if (envelopes === 'none') return base;
  return {
    ...base,
    metadata: envelopes === 'malformed'
      ? '{"intakeScreening":{"schemaVersion":99}}'
      : JSON.stringify({
        intakeScreening: {
          schemaVersion: 1,
          mode: 'enforce',
          withheld: false,
          envelopes,
        },
      }),
  };
}

describe('extraction admission identity', () => {
  it('indexes envelopes per entry and tracks malformed screening state separately', () => {
    const index = buildExtractionAdmissionIndex([
      entry(1, [snapshot({ envelopeId: ENVELOPE_A, receiptId: RECEIPT_A })]),
      entry(2, 'malformed'),
      entry(3, 'none'),
    ], 'room');
    expect([...index.envelopesByEntryId.keys()]).toEqual([1]);
    expect([...index.malformedEntryIds]).toEqual([2]);
    expect(index.allEnvelopes).toHaveLength(1);
  });

  it('scopes envelopes to the attributed source entries', () => {
    const index = buildExtractionAdmissionIndex([
      entry(1, [snapshot({ envelopeId: ENVELOPE_A })]),
      entry(2, [snapshot({ envelopeId: ENVELOPE_B })]),
    ], 'room');
    expect(resolveAdmissionEnvelopesForSource(index, [2]).envelopes)
      .toEqual([expect.objectContaining({ envelopeId: ENVELOPE_B })]);
  });

  it('inherits every envelope in the window for an unattributed fact (fail closed)', () => {
    const index = buildExtractionAdmissionIndex([
      entry(1, [snapshot({ envelopeId: ENVELOPE_A })]),
      entry(2, [snapshot({ envelopeId: ENVELOPE_B })]),
    ], 'room');
    const resolved = resolveAdmissionEnvelopesForSource(index, undefined);
    expect(resolved.envelopes.map(item => item.envelopeId)).toEqual([ENVELOPE_A, ENVELOPE_B]);
  });

  it('reports a malformed source entry as covered so the sink gate can fail closed', () => {
    const index = buildExtractionAdmissionIndex([entry(1, 'malformed')], 'room');
    expect(resolveAdmissionEnvelopesForSource(index, [1]).coversMalformedEntry).toBe(true);
    expect(resolveAdmissionEnvelopesForSource(index, undefined).coversMalformedEntry).toBe(true);
  });

  it('projects envelopes onto content-free refs, keeping a quarantined envelope', () => {
    expect(buildAdmissionProvenanceRefs([
      snapshot({ envelopeId: ENVELOPE_A, state: 'quarantined' }) as IntakeEnvelopeSnapshot,
    ])).toEqual([{
      kind: 'intake_envelope',
      refId: ENVELOPE_A,
      envelopeId: ENVELOPE_A,
    }]);
  });

  it('prefers the snapshot that carries a receipt when one envelope has several subjects', () => {
    expect(buildAdmissionProvenanceRefs([
      snapshot({ envelopeId: ENVELOPE_A }) as IntakeEnvelopeSnapshot,
      snapshot({
        envelopeId: ENVELOPE_A,
        receiptId: RECEIPT_A,
        subject: { kind: 'attachment', index: 0 },
      }) as IntakeEnvelopeSnapshot,
    ])).toEqual([{
      kind: 'intake_envelope',
      refId: ENVELOPE_A,
      envelopeId: ENVELOPE_A,
      receiptId: RECEIPT_A,
    }]);
  });
});
