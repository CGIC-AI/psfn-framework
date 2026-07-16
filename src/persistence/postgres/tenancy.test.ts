import { describe, expect, it } from 'vitest';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import { POSTGRES_SCHEMA_NAME_MAX_LENGTH } from '../postgres.js';
import {
  derivePostgresShardSchema,
  derivePostgresTenantRole,
  planPostgresTenantAccess,
} from './tenancy.js';

const PARENT_ID = createCompanionId(
  '11111111-1111-4111-8111-111111111111',
  'test parent companion',
);

describe('PostgreSQL tenant identity derivation', () => {
  it('derives a deterministic bounded shard schema from full lineage', () => {
    const input = {
      parentCompanionId: PARENT_ID,
      parentSchema: 'companion_flagship_with_a_long_readable_suffix',
      shardId: 'shard-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    };
    const first = derivePostgresShardSchema(input);
    expect(derivePostgresShardSchema(input)).toBe(first);
    expect(first).toMatch(/^[a-z][a-z0-9_]+$/u);
    expect(first.length).toBeLessThanOrEqual(POSTGRES_SCHEMA_NAME_MAX_LENGTH);
    expect(derivePostgresShardSchema({ ...input, shardId: `${input.shardId}-peer` }))
      .not.toBe(first);
  });

  it('binds shard schemas to parent companion identity as well as the parent schema', () => {
    const common = { parentSchema: 'companion_flagship', shardId: 'shard-1' };
    const peer = createCompanionId(
      '22222222-2222-4222-8222-222222222222',
      'test peer companion',
    );
    expect(derivePostgresShardSchema({ parentCompanionId: PARENT_ID, ...common }))
      .not.toBe(derivePostgresShardSchema({ parentCompanionId: peer, ...common }));
  });

  it('fails closed on empty shard identity and invalid parent schemas', () => {
    expect(() => derivePostgresShardSchema({
      parentCompanionId: PARENT_ID,
      parentSchema: 'companion_flagship',
      shardId: ' ',
    })).toThrow('non-empty shard id');
    expect(() => derivePostgresShardSchema({
      parentCompanionId: PARENT_ID,
      parentSchema: 'public,peer',
      shardId: 'shard-1',
    })).toThrow('Invalid Postgres schema name');
  });

  it('produces one deterministic role and a public-free access plan', () => {
    const role = derivePostgresTenantRole('companion_flagship');
    const plan = planPostgresTenantAccess({
      schema: 'companion_flagship',
      role,
      approvedSharedSchema: 'shared',
      approvedSharedAccess: 'read',
    });
    expect(plan).toEqual({
      schema: 'companion_flagship',
      role,
      extensionSchema: 'extensions',
      searchPath: 'companion_flagship,extensions',
      approvedSharedSchema: 'shared',
      approvedSharedAccess: 'read',
    });
    expect(plan.searchPath).not.toContain('public');
  });
});
