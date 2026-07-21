import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { createCompanionId } from '../../../shared/routing/companion-id.js';
import { PostgresTestingHarnessGardenAuthorizationAudit } from './testing-harness-authorization-audit.js';

function result(rows: readonly Record<string, unknown>[] = [], rowCount = rows.length): QueryResult {
  return {
    command: '',
    rowCount,
    oid: 0,
    fields: [],
    rows: [...rows],
  };
}

function fakePool(query: PoolClient['query']): {
  pool: Pool;
  release: ReturnType<typeof vi.fn>;
} {
  const release = vi.fn();
  return {
    pool: {
      connect: vi.fn(async () => ({ query, release })),
    } as unknown as Pool,
    release,
  };
}

describe('PostgresTestingHarnessGardenAuthorizationAudit', () => {
  it('locks authority and durably labels the synthetic provider before returning versions', async () => {
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
      calls.push({ sql, ...(values ? { values } : {}) });
      if (sql.includes('lock_authority_state_for_broker')) {
        return result([{ authority_generation: '9', global_auth_epoch: '12' }]);
      }
      if (sql.includes('INSERT INTO')) return result([], 1);
      return result();
    }) as unknown as PoolClient['query'];
    const { pool, release } = fakePool(query);
    const occurredAt = new Date('2026-07-21T12:00:00.000Z');
    const audit = new PostgresTestingHarnessGardenAuthorizationAudit({
      pool,
      sessionPepper: 'p'.repeat(32),
      now: () => occurredAt,
    });

    const recorded = await audit.record({
      action: 'settings.write',
      companionId: createCompanionId('22222222-2222-4222-8222-222222222222'),
      principalId: 'testing-harness',
      provider: 'testing_harness',
      correlationId: 'request-secret',
    });

    expect(calls.map(call => call.sql.trim().split(/\s+/)[0])).toEqual([
      'BEGIN', 'SELECT', 'INSERT', 'COMMIT',
    ]);
    const insert = calls[2]!;
    expect(insert.sql).toContain("'testing_harness_garden_authorization_allowed'");
    expect(insert.values?.[1]).toContain('"provider":"testing_harness"');
    expect(insert.values?.[7]).toBe(createHmac('sha256', 'p'.repeat(32))
      .update('testing-harness-garden-correlation-v1\0')
      .update('request-secret')
      .digest('hex'));
    expect(insert.values).not.toContain('request-secret');
    expect(recorded).toMatchObject({
      authorityGeneration: 9,
      globalAuthEpoch: 12,
      occurredAt,
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it('rolls back and fails closed when the durable audit insert fails', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('lock_authority_state_for_broker')) {
        return result([{ authority_generation: '1', global_auth_epoch: '1' }]);
      }
      if (sql.includes('INSERT INTO')) throw new Error('database unavailable');
      return result();
    }) as unknown as PoolClient['query'];
    const { pool, release } = fakePool(query);
    const audit = new PostgresTestingHarnessGardenAuthorizationAudit({
      pool,
      sessionPepper: 'p'.repeat(32),
    });

    await expect(audit.record({
      action: 'settings.read',
      companionId: createCompanionId('22222222-2222-4222-8222-222222222222'),
      principalId: 'testing-harness',
      provider: 'testing_harness',
      correlationId: 'request-secret',
    })).rejects.toThrow('database unavailable');
    expect(query).toHaveBeenCalledWith('ROLLBACK');
    expect(release).toHaveBeenCalledOnce();
  });
});
