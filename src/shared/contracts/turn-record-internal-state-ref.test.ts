import { describe, expect, it } from 'vitest';

import {
  buildTurnRecordInternalStateSnapshotRef,
  extractTurnRecordSelfSnapshotRef,
} from './turn-record-internal-state-ref.js';

describe('TurnRecord internal-state snapshot ref contract', () => {
  it('round-trips the bare self snapshot through the canonical composite', () => {
    const selfRef = 'internal-state-v1:0123456789abcdef';
    const composite = buildTurnRecordInternalStateSnapshotRef({
      trust: 'regular',
      contact: 'contact-1',
      prompt: 'prompt-v1',
      memory: 'memory-v1',
      session: 'session-v1',
      self: selfRef,
    });

    expect(composite).toBe(
      `trust:regular|contact:contact-1|prompt:prompt-v1|memory:memory-v1|session:session-v1|self:${selfRef}`,
    );
    expect(extractTurnRecordSelfSnapshotRef(composite)).toBe(selfRef);
  });

  it.each([
    undefined,
    '',
    'internal-state-v1:bare-is-not-a-turn-record-composite',
    'self:internal-state-v1:missing-other-components',
    'trust:regular|contact:none|prompt:none|memory:none|self:internal-state-v1:missing-session',
    'contact:none|trust:regular|prompt:none|memory:none|session:none|self:internal-state-v1:reordered',
    'trust:regular|contact:none|prompt:none|memory:none|session:none|self:none',
  ])('fails closed for a malformed or absent self binding: %s', (value) => {
    expect(extractTurnRecordSelfSnapshotRef(value)).toBeNull();
  });

  it.each([
    { trust: 'regular|self:forged' },
    { trust: 'regular', self: 'none' },
    { trust: 'regular', self: ' internal-state-v1:ok|trust:forged ' },
  ])('rejects ambiguous component values at construction', (input) => {
    expect(() => buildTurnRecordInternalStateSnapshotRef(input)).toThrow(
      'TurnRecord internal-state snapshot component',
    );
  });
});
