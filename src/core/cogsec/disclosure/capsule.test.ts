import { describe, expect, it } from 'vitest';

import {
  CAPSULE_AUTHORITY,
  SHARE_CAPSULE_SCHEMA_VERSION,
  approveShareCandidate,
  authorizeCapsuleUse,
  buildShareCandidate,
  evaluateCapsuleUse,
  hashShareContent,
  parseApprovedShareCapsule,
  parseCapsuleExpiry,
  parseCapsuleRevocation,
  parseShareCandidate,
  parseShareContent,
  revokeShareCapsule,
} from './capsule.js';
import type {
  ApprovedShareCapsule,
  CapsuleUseRequest,
  ShareCandidate,
} from './capsule.js';
import type { DisclosureDestination } from './contracts.js';

const CONTACT_DESTINATION: DisclosureDestination = { kind: 'contact_dm', contactId: 'contact-1' };
const PUBLICATION_DESTINATION: DisclosureDestination = { kind: 'publication' };

function candidate(overrides: Partial<Parameters<typeof buildShareCandidate>[0]> = {}): ShareCandidate {
  return buildShareCandidate({
    candidateId: 'cand-1',
    content: { body: 'An honest, exact sentence.', mediaRefs: ['media:a', 'media:b'] },
    proposedDestinations: [{ kind: 'contact_dm', contactIds: ['contact-1'] }],
    effectiveSensitivity: 'intimate',
    provenanceRefs: ['memory:1', 'session:x'],
    subjectContactIds: ['contact-1'],
    createdAt: '2026-07-19T00:00:00.000Z',
    ...overrides,
  });
}

function capsule(overrides: Partial<Parameters<typeof approveShareCandidate>[1]> = {}, cand: ShareCandidate = candidate()): ApprovedShareCapsule {
  return approveShareCandidate(cand, {
    capsuleId: 'cap-1',
    actor: 'operator:pierre',
    approvedAt: '2026-07-19T01:00:00.000Z',
    expiry: { expiresAt: '2026-07-26T00:00:00.000Z', maxUseCount: 3 },
    ...overrides,
  });
}

function useRequest(overrides: Partial<CapsuleUseRequest> = {}): CapsuleUseRequest {
  return {
    intent: 'exact_replay',
    content: { body: 'An honest, exact sentence.', mediaRefs: ['media:a', 'media:b'] },
    destination: CONTACT_DESTINATION,
    now: '2026-07-20T00:00:00.000Z',
    priorUseCount: 0,
    ...overrides,
  };
}

describe('hashShareContent — content-hash binding (property 1)', () => {
  it('is stable for identical content', () => {
    const content = { body: 'hello', mediaRefs: ['m:1'] };
    expect(hashShareContent(content)).toBe(hashShareContent({ body: 'hello', mediaRefs: ['m:1'] }));
  });

  it('changes on any body edit, including a single character or whitespace', () => {
    const base = hashShareContent({ body: 'hello world', mediaRefs: [] });
    expect(hashShareContent({ body: 'hello  world', mediaRefs: [] })).not.toBe(base);
    expect(hashShareContent({ body: 'Hello world', mediaRefs: [] })).not.toBe(base);
    expect(hashShareContent({ body: 'hello world ', mediaRefs: [] })).not.toBe(base);
  });

  it('changes when media refs change or are reordered', () => {
    const base = hashShareContent({ body: 'x', mediaRefs: ['a', 'b'] });
    expect(hashShareContent({ body: 'x', mediaRefs: ['b', 'a'] })).not.toBe(base);
    expect(hashShareContent({ body: 'x', mediaRefs: ['a'] })).not.toBe(base);
    expect(hashShareContent({ body: 'x', mediaRefs: ['a', 'b', 'c'] })).not.toBe(base);
  });
});

describe('approveShareCandidate — capsule binds to exact content', () => {
  it('binds contentHash to the candidate content and starts un-revoked with replay-only authority', () => {
    const cap = capsule();
    expect(cap.contentHash).toBe(hashShareContent(cap.content));
    expect(cap.authority).toBe(CAPSULE_AUTHORITY);
    expect(cap.revocation.revoked).toBe(false);
    expect(cap.candidateId).toBe('cand-1');
    expect(cap.permittedDestinations).toEqual([{ kind: 'contact_dm', contactIds: ['contact-1'] }]);
  });

  it('rejects a grant without any expiry bound (authority must be bounded)', () => {
    expect(() => capsule({ expiry: {} })).toThrow(/bounded expiry/);
  });

  it('rejects an empty actor or capsuleId', () => {
    expect(() => capsule({ actor: '  ' })).toThrow(/actor/);
    expect(() => capsule({ capsuleId: '' })).toThrow(/capsuleId/);
  });
});

describe('authorizeCapsuleUse — hash binding enforced at use (property 1)', () => {
  it('authorizes exact replay of the approved content to a permitted destination', () => {
    const decision = authorizeCapsuleUse(capsule(), useRequest());
    expect(decision.authorized).toBe(true);
  });

  it('denies when the requested content differs from the approved content by one character', () => {
    const decision = authorizeCapsuleUse(capsule(), useRequest({
      content: { body: 'An honest, exact sentence!', mediaRefs: ['media:a', 'media:b'] },
    }));
    expect(decision).toMatchObject({ authorized: false, code: 'content_hash_mismatch' });
  });

  it('denies when embedded media is reordered', () => {
    const decision = authorizeCapsuleUse(capsule(), useRequest({
      content: { body: 'An honest, exact sentence.', mediaRefs: ['media:b', 'media:a'] },
    }));
    expect(decision).toMatchObject({ authorized: false, code: 'content_hash_mismatch' });
  });

  it('denies a destination outside the permitted set', () => {
    const decision = authorizeCapsuleUse(capsule(), useRequest({ destination: PUBLICATION_DESTINATION }));
    expect(decision).toMatchObject({ authorized: false, code: 'destination_not_permitted' });
  });
});

describe('expiry (property 2)', () => {
  it('parseCapsuleExpiry rejects an unbounded expiry and accepts either bound', () => {
    expect(parseCapsuleExpiry({})).toBeNull();
    expect(parseCapsuleExpiry({ expiresAt: '2026-07-26T00:00:00.000Z' })).toEqual({ expiresAt: '2026-07-26T00:00:00.000Z' });
    expect(parseCapsuleExpiry({ maxUseCount: 2 })).toEqual({ maxUseCount: 2 });
    expect(parseCapsuleExpiry({ maxUseCount: 0 })).toBeNull();
    expect(parseCapsuleExpiry({ maxUseCount: 1.5 })).toBeNull();
    expect(parseCapsuleExpiry({ expiresAt: 'not-a-date' })).toBeNull();
  });

  it('denies at and after the expiry boundary, allows strictly before', () => {
    const cap = capsule({ expiry: { expiresAt: '2026-07-26T00:00:00.000Z' } });
    expect(evaluateCapsuleUse(cap, useRequest({ now: '2026-07-25T23:59:59.999Z' })).authorized).toBe(true);
    expect(evaluateCapsuleUse(cap, useRequest({ now: '2026-07-26T00:00:00.000Z' }))).toMatchObject({ authorized: false, code: 'expired' });
    expect(evaluateCapsuleUse(cap, useRequest({ now: '2026-07-26T00:00:00.001Z' }))).toMatchObject({ authorized: false, code: 'expired' });
  });

  it('exhausts once prior use-count reaches the cap', () => {
    const cap = capsule({ expiry: { maxUseCount: 2 } });
    expect(evaluateCapsuleUse(cap, useRequest({ priorUseCount: 0 })).authorized).toBe(true);
    expect(evaluateCapsuleUse(cap, useRequest({ priorUseCount: 1 })).authorized).toBe(true);
    expect(evaluateCapsuleUse(cap, useRequest({ priorUseCount: 2 }))).toMatchObject({ authorized: false, code: 'use_count_exhausted' });
    expect(evaluateCapsuleUse(cap, useRequest({ priorUseCount: 5 }))).toMatchObject({ authorized: false, code: 'use_count_exhausted' });
  });
});

describe('revocation (property 3) — revocation wins', () => {
  it('revokeShareCapsule marks the capsule revoked', () => {
    const cap = revokeShareCapsule(capsule(), { revokedAt: '2026-07-20T12:00:00.000Z', reason: 'subject withdrew consent' });
    expect(cap.revocation).toEqual({ revoked: true, revokedAt: '2026-07-20T12:00:00.000Z', reason: 'subject withdrew consent' });
  });

  it('denies with revoked even when content, destination, expiry and use-count would all pass', () => {
    const cap = revokeShareCapsule(capsule(), { revokedAt: '2026-07-20T12:00:00.000Z' });
    const decision = evaluateCapsuleUse(cap, useRequest());
    expect(decision).toMatchObject({ authorized: false, code: 'revoked' });
  });

  it('revocation wins over expiry and hash-mismatch', () => {
    const cap = revokeShareCapsule(
      capsule({ expiry: { expiresAt: '2026-07-01T00:00:00.000Z', maxUseCount: 1 } }),
      { revokedAt: '2026-07-02T00:00:00.000Z' },
    );
    const decision = evaluateCapsuleUse(cap, useRequest({
      now: '2026-07-30T00:00:00.000Z',
      priorUseCount: 99,
      content: { body: 'totally different', mediaRefs: [] },
    }));
    expect(decision).toMatchObject({ authorized: false, code: 'revoked' });
  });
});

describe('replay-vs-generative authority (property 4)', () => {
  it('authority is intrinsically exact-replay only', () => {
    expect(capsule().authority).toBe('exact_replay');
    expect(CAPSULE_AUTHORITY).toBe('exact_replay');
  });

  it('denies any generative_input use even with matching content and permitted destination', () => {
    const decision = evaluateCapsuleUse(capsule(), useRequest({ intent: 'generative_input' }));
    expect(decision).toMatchObject({ authorized: false, code: 'generative_input_requires_fresh_approval' });
  });

  it('generative denial holds regardless of content/destination correctness', () => {
    const decision = authorizeCapsuleUse(capsule(), useRequest({
      intent: 'generative_input',
      content: { body: 'a new derived work', mediaRefs: [] },
      destination: PUBLICATION_DESTINATION,
    }));
    expect(decision).toMatchObject({ authorized: false, code: 'generative_input_requires_fresh_approval' });
  });

  it('parse rejects a capsule asserting any authority other than exact_replay', () => {
    const cap = capsule();
    const serialized = JSON.parse(JSON.stringify(cap)) as Record<string, unknown>;
    serialized.authority = 'generative_input';
    expect(parseApprovedShareCapsule(serialized)).toBeNull();
  });
});

describe('fail-closed parsing (property 5)', () => {
  it('round-trips a well-formed capsule', () => {
    const cap = capsule();
    const serialized = JSON.parse(JSON.stringify(cap)) as unknown;
    expect(parseApprovedShareCapsule(serialized)).toEqual(cap);
  });

  it('denies an absent capsule', () => {
    expect(authorizeCapsuleUse(null, useRequest())).toMatchObject({ authorized: false, code: 'malformed_capsule' });
    expect(authorizeCapsuleUse(undefined, useRequest())).toMatchObject({ authorized: false, code: 'malformed_capsule' });
    expect(authorizeCapsuleUse('not-an-object', useRequest())).toMatchObject({ authorized: false, code: 'malformed_capsule' });
  });

  it('rejects a capsule whose stored hash does not match its own content (tamper)', () => {
    const cap = capsule();
    const tampered = JSON.parse(JSON.stringify(cap)) as Record<string, unknown>;
    (tampered.content as { body: string }).body = 'silently swapped content';
    // contentHash still points at the original body → mismatch → fail closed.
    expect(parseApprovedShareCapsule(tampered)).toBeNull();
    expect(authorizeCapsuleUse(tampered, useRequest())).toMatchObject({ authorized: false, code: 'malformed_capsule' });
  });

  it('rejects wrong schema version and missing required fields', () => {
    const cap = capsule();
    const base = JSON.parse(JSON.stringify(cap)) as Record<string, unknown>;
    expect(parseApprovedShareCapsule({ ...base, schemaVersion: 2 })).toBeNull();
    expect(parseApprovedShareCapsule({ ...base, capsuleId: '' })).toBeNull();
    expect(parseApprovedShareCapsule({ ...base, approval: { actor: 'x' } })).toBeNull();
    expect(parseApprovedShareCapsule({ ...base, expiry: {} })).toBeNull();
    expect(parseApprovedShareCapsule({ ...base, effectiveSensitivity: 'nonsense' })).toBeNull();
  });

  it('rejects a revocation record that smuggles revoked metadata while marked not-revoked', () => {
    expect(parseCapsuleRevocation({ revoked: false })).toEqual({ revoked: false });
    expect(parseCapsuleRevocation({ revoked: false, revokedAt: '2026-07-20T00:00:00.000Z' })).toBeNull();
    expect(parseCapsuleRevocation({ revoked: true })).toBeNull();
    expect(parseCapsuleRevocation({ revoked: true, revokedAt: 'nope' })).toBeNull();
  });

  it('denies malformed use requests', () => {
    expect(evaluateCapsuleUse(capsule(), useRequest({ priorUseCount: -1 }))).toMatchObject({ authorized: false, code: 'invalid_use_request' });
    expect(evaluateCapsuleUse(capsule(), useRequest({ priorUseCount: 1.5 }))).toMatchObject({ authorized: false, code: 'invalid_use_request' });
    expect(evaluateCapsuleUse(capsule(), useRequest({ now: 'not-a-time' }))).toMatchObject({ authorized: false, code: 'invalid_use_request' });
  });

  it('parseShareContent fails closed on bad shapes and rejects empty media entries', () => {
    expect(parseShareContent(null)).toBeNull();
    expect(parseShareContent({ mediaRefs: [] })).toBeNull();
    expect(parseShareContent({ body: 'x', mediaRefs: [''] })).toBeNull();
    expect(parseShareContent({ body: 'x', mediaRefs: [1] })).toBeNull();
    expect(parseShareContent({ body: 'x' })).toEqual({ body: 'x', mediaRefs: [] });
  });
});

describe('ShareCandidate round-trip', () => {
  it('build sets a content hash and parse validates it', () => {
    const cand = candidate();
    expect(cand.schemaVersion).toBe(SHARE_CAPSULE_SCHEMA_VERSION);
    expect(cand.contentHash).toBe(hashShareContent(cand.content));
    const serialized = JSON.parse(JSON.stringify(cand)) as unknown;
    expect(parseShareCandidate(serialized)).toEqual(cand);
  });

  it('parseShareCandidate fails closed on hash mismatch', () => {
    const cand = candidate();
    const tampered = JSON.parse(JSON.stringify(cand)) as Record<string, unknown>;
    (tampered.content as { body: string }).body = 'edited after hashing';
    expect(parseShareCandidate(tampered)).toBeNull();
  });

  it('build rejects invalid drafts', () => {
    expect(() => candidate({ candidateId: '' })).toThrow(/candidateId/);
    expect(() => candidate({ createdAt: 'nope' })).toThrow(/createdAt/);
  });
});
