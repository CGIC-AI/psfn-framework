import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createWelfareGrantVerifierForPool } from './welfare-grant-verifier.js';

describe('Postgres welfare grant readiness', () => {
  it('probes every configured tenant relation without reading rows', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const verifier = createWelfareGrantVerifierForPool(
      { query } as unknown as Pool,
      {
        mode: 'fleet',
        schemaByCompanionId: new Map([
          ['companion-a', 'tenant_a'],
          ['companion-b', 'tenant_b'],
        ]),
      },
    );

    await verifier.assertReady();

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.map(call => call[0])).toEqual([
      expect.stringContaining('FROM "tenant_a".agent_background_work_jobs'),
      expect.stringContaining('FROM "tenant_b".agent_background_work_jobs'),
    ]);
    for (const [sql] of query.mock.calls) expect(sql).toContain('LIMIT 0');
  });

  it('fails closed when a tenant relation cannot be read', async () => {
    const verifier = createWelfareGrantVerifierForPool(
      {
        query: vi.fn(async () => { throw new Error('permission denied for relation'); }),
      } as unknown as Pool,
      { mode: 'single', schema: 'tenant_a' },
    );

    await expect(verifier.assertReady()).rejects.toThrow('permission denied for relation');
  });
});
