import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  createCompanionId,
  createShardCompanionId,
  parseCompanionId,
  type CompanionId,
  type ShardCompanionId,
} from './companion-id.js';

const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const EXPECTED_COMPANION_ID_SHAPE = 'lowercase RFC-4122 UUID';

describe('CompanionId', () => {
  it('accepts and normalizes a fleet UUID without changing its string format', () => {
    expect(createCompanionId(`  ${COMPANION_ID}  `)).toBe(COMPANION_ID);
  });

  it('rejects the legacy single-companion shape with the expected fleet shape', () => {
    for (const value of [undefined, '   ', 'companion-alpha', 'companion:alpha']) {
      expect(() => createCompanionId(value)).toThrow(EXPECTED_COMPANION_ID_SHAPE);
    }
    expect(parseCompanionId('companion-alpha')).toBeNull();
  });

  it('keeps shard suffixes as tokens while requiring a fleet UUID core', () => {
    expect(createShardCompanionId(`${COMPANION_ID}/shards/shard-42`))
      .toBe(`${COMPANION_ID}/shards/shard-42`);
    expect(createShardCompanionId(`${COMPANION_ID}::shard-42`))
      .toBe(`${COMPANION_ID}::shard-42`);
    expect(() => createShardCompanionId('companion-alpha::shard-42'))
      .toThrow(EXPECTED_COMPANION_ID_SHAPE);
    expect(() => createShardCompanionId(COMPANION_ID))
      .toThrow('wire format');
  });

  it('offers a nonthrowing parser for untrusted core identities', () => {
    expect(parseCompanionId(`  ${COMPANION_ID}  `)).toBe(COMPANION_ID);
    expect(parseCompanionId('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA')).toBeNull();
    expect(parseCompanionId(null)).toBeNull();
  });

  it('reconstructs both shard wire forms from canonical validated tokens', () => {
    expect(createShardCompanionId(`  ${COMPANION_ID} :: shard-42  `))
      .toBe(`${COMPANION_ID}::shard-42`);
    expect(createShardCompanionId(`  ${COMPANION_ID} /shards/ shard-42  `))
      .toBe(`${COMPANION_ID}/shards/shard-42`);
  });

  it('is not assignable from an unvalidated string', () => {
    const companionId = createCompanionId(COMPANION_ID);
    expectTypeOf(companionId).toExtend<CompanionId>();
    expectTypeOf<string>().not.toExtend<CompanionId>();
    expectTypeOf<ShardCompanionId>().not.toExtend<CompanionId>();

    const requiresCompanionId = (_value: CompanionId): void => {};
    requiresCompanionId(companionId);
    // @ts-expect-error Raw strings must cross the validating constructor first.
    requiresCompanionId(COMPANION_ID);
  });
});
