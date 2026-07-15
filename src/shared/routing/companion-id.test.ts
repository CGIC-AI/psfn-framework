import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  createCompanionId,
  createShardCompanionId,
  parseCompanionId,
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

  it('offers a nonthrowing parser for untrusted core identities', () => {
    expect(parseCompanionId('  companion-alpha  ')).toBe('companion-alpha');
    expect(parseCompanionId('companion:alpha')).toBeNull();
    expect(parseCompanionId('x'.repeat(129))).toBeNull();
    expect(parseCompanionId(null)).toBeNull();
  });

  it('reconstructs both shard wire forms from canonical validated tokens', () => {
    expect(createShardCompanionId('  companion-alpha :: shard-42  '))
      .toBe('companion-alpha::shard-42');
    expect(createShardCompanionId('  companion-alpha /shards/ shard-42  '))
      .toBe('companion-alpha/shards/shard-42');
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
