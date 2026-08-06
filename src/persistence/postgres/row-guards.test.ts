import { describe, expect, it } from 'vitest';

import {
  parseSafeInteger,
  requireBackgroundWorkSafeInteger,
  requireFleetAuthInteger,
  requirePartnerAffectSafeInteger,
  requirePositiveSafeInteger,
  requireSafeInteger,
  requireUuid,
} from './row-guards.js';

describe('Postgres row guards', () => {
  it('preserves the null-returning safe-integer variant', () => {
    expect(parseSafeInteger('42')).toBe(42);
    expect(parseSafeInteger(0)).toBe(0);
    expect(parseSafeInteger('not-an-integer')).toBeNull();
    expect(parseSafeInteger(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
  });

  it('preserves the throwing safe-integer variants and their diagnostics', () => {
    expect(requireSafeInteger('42', 'row.revision')).toBe(42);
    expect(() => requireSafeInteger('4.2', 'row.revision'))
      .toThrow('row.revision must be a safe integer');

    expect(requireBackgroundWorkSafeInteger(null, 'attemptCount')).toBe(0);
    expect(() => requireBackgroundWorkSafeInteger(-1, 'attemptCount'))
      .toThrow('Background work attemptCount must be a non-negative safe integer');

    expect(() => requirePartnerAffectSafeInteger('nope', 'window_start_ms'))
      .toThrow('Persisted partner-affect shadow row has non-integer window_start_ms: nope');
  });

  it('preserves positive-integer variants', () => {
    expect(requirePositiveSafeInteger(1, 'expectedRevision')).toBe(1);
    expect(() => requirePositiveSafeInteger(0, 'expectedRevision'))
      .toThrow('expectedRevision must be a positive safe integer');

    expect(requireFleetAuthInteger('1', 'authority_generation')).toBe(1);
    expect(() => requireFleetAuthInteger('0', 'authority_generation'))
      .toThrow('Invalid fleet_auth authority_generation');
  });

  it('preserves UUID validation while allowing the established diagnostic wording', () => {
    const uuid = '123e4567-e89b-42d3-a456-426614174000';
    expect(requireUuid(uuid, 'companionId')).toBe(uuid);
    expect(() => requireUuid('not-a-uuid', 'companionId'))
      .toThrow('companionId must be a lowercase RFC-4122 UUID');
    expect(() => requireUuid('not-a-uuid', 'companionId', 'RFC 4122 UUID'))
      .toThrow('companionId must be an RFC 4122 UUID');
  });
});
