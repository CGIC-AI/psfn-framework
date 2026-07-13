import { describe, expect, expectTypeOf, it } from 'vitest';
import { createCompanionId, type CompanionId } from './companion-id.js';

describe('CompanionId', () => {
  it('normalizes a supported wire value without changing its string format', () => {
    expect(createCompanionId('  companion-alpha  ')).toBe('companion-alpha');
  });

  it('rejects missing and empty identities at the constructor boundary', () => {
    expect(() => createCompanionId(undefined)).toThrow('companionId must be a string');
    expect(() => createCompanionId('   ')).toThrow('companionId must be a non-empty string');
  });

  it('is not assignable from an unvalidated string', () => {
    const companionId = createCompanionId('companion-alpha');
    expectTypeOf(companionId).toExtend<CompanionId>();
    expectTypeOf<string>().not.toExtend<CompanionId>();

    const requiresCompanionId = (_value: CompanionId): void => {};
    requiresCompanionId(companionId);
    // @ts-expect-error Raw strings must cross the validating constructor first.
    requiresCompanionId('companion-alpha');
  });
});
