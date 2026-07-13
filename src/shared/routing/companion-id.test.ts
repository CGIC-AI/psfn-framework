import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  createCompanionId,
  createShardCompanionId,
  type CompanionId,
  type ShardCompanionId,
} from './companion-id.js';

describe('CompanionId', () => {
  it('normalizes a supported wire value without changing its string format', () => {
    expect(createCompanionId('  companion-alpha  ')).toBe('companion-alpha');
  });

  it('rejects missing and empty identities at the constructor boundary', () => {
    expect(() => createCompanionId(undefined)).toThrow('companionId must be a string');
    expect(() => createCompanionId('   ')).toThrow('companionId must be a non-empty string');
  });

  it('enforces the deliberate core grammar and distinct existing shard wire formats', () => {
    expect(() => createCompanionId('companion:alpha')).toThrow('companion-id token');
    expect(() => createCompanionId('companion/alpha')).toThrow('companion-id token');
    expect(createShardCompanionId('companion-alpha/shards/shard-42'))
      .toBe('companion-alpha/shards/shard-42');
    expect(createShardCompanionId('companion-alpha::shard-42'))
      .toBe('companion-alpha::shard-42');
    expect(() => createShardCompanionId('companion-alpha'))
      .toThrow('wire format');
  });

  it('is not assignable from an unvalidated string', () => {
    const companionId = createCompanionId('companion-alpha');
    expectTypeOf(companionId).toExtend<CompanionId>();
    expectTypeOf<string>().not.toExtend<CompanionId>();
    expectTypeOf<ShardCompanionId>().not.toExtend<CompanionId>();

    const requiresCompanionId = (_value: CompanionId): void => {};
    requiresCompanionId(companionId);
    // @ts-expect-error Raw strings must cross the validating constructor first.
    requiresCompanionId('companion-alpha');
  });
});
