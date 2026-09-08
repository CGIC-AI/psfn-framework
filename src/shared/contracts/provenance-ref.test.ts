import { describe, expect, it } from 'vitest';
import {
  hasVerifiedAdmissionIdentity,
  normalizeCogSecStructuredProvenanceRef,
  normalizeCogSecStructuredProvenanceRefs,
} from './provenance-ref.js';

const ENVELOPE_ID = 'env_01JZ0000000000000000000001';
const RECEIPT_ID = 'rcpt_01JZ0000000000000000000001';
const CONTENT_SHA = 'a'.repeat(64);

describe('normalizeCogSecStructuredProvenanceRef', () => {
  it('keeps every well-formed identity field', () => {
    expect(normalizeCogSecStructuredProvenanceRef({
      kind: 'intake_envelope',
      refId: ENVELOPE_ID,
      envelopeId: ENVELOPE_ID,
      receiptId: RECEIPT_ID,
      contentSha256: CONTENT_SHA,
    })).toEqual({
      kind: 'intake_envelope',
      refId: ENVELOPE_ID,
      envelopeId: ENVELOPE_ID,
      receiptId: RECEIPT_ID,
      contentSha256: CONTENT_SHA,
    });
  });

  it('rejects the whole ref when kind or refId is unusable', () => {
    expect(normalizeCogSecStructuredProvenanceRef({ kind: '', refId: ENVELOPE_ID })).toBeNull();
    expect(normalizeCogSecStructuredProvenanceRef({ kind: 'memory', refId: '  ' })).toBeNull();
    expect(normalizeCogSecStructuredProvenanceRef('memory:1')).toBeNull();
  });

  it('drops a malformed identity field while keeping the ref, degrading to unverified', () => {
    const ref = normalizeCogSecStructuredProvenanceRef({
      kind: 'memory',
      refId: 'memory-1',
      contentSha256: 'NOT-A-HASH',
      receiptId: 'has whitespace',
    });
    expect(ref).toEqual({ kind: 'memory', refId: 'memory-1' });
    expect(hasVerifiedAdmissionIdentity(ref!)).toBe(false);
  });

  it('refuses free text in an identity field so a ref can never carry content', () => {
    const ref = normalizeCogSecStructuredProvenanceRef({
      kind: 'memory',
      refId: 'memory-1',
      envelopeId: 'the partner said their password is hunter2',
    });
    expect(ref).toEqual({ kind: 'memory', refId: 'memory-1' });
  });

  it('deduplicates on full identity and preserves first-seen order', () => {
    expect(normalizeCogSecStructuredProvenanceRefs([
      { kind: 'intake_envelope', refId: ENVELOPE_ID, envelopeId: ENVELOPE_ID },
      { kind: 'intake_envelope', refId: ENVELOPE_ID, envelopeId: ENVELOPE_ID },
      { kind: 'memory', refId: 'memory-1' },
      'not a ref',
    ])).toEqual([
      { kind: 'intake_envelope', refId: ENVELOPE_ID, envelopeId: ENVELOPE_ID },
      { kind: 'memory', refId: 'memory-1' },
    ]);
  });

  it('treats a ref that gained an identity field as distinct from the bare ref', () => {
    expect(normalizeCogSecStructuredProvenanceRefs([
      { kind: 'intake_envelope', refId: ENVELOPE_ID },
      { kind: 'intake_envelope', refId: ENVELOPE_ID, receiptId: RECEIPT_ID },
    ])).toHaveLength(2);
  });

  it('returns an empty list for a non-array', () => {
    expect(normalizeCogSecStructuredProvenanceRefs(undefined)).toEqual([]);
    expect(normalizeCogSecStructuredProvenanceRefs({ kind: 'memory' })).toEqual([]);
  });
});
