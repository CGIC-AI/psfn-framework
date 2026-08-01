import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createWelfareGrantVerifierForPool } from './welfare-grant-verifier.js';

describe('Postgres welfare grant readiness', () => {
  it('probes every configured tenant relation without reading rows', async () => {
    const query = vi.fn(async (_sql: string, values?: unknown[]) => ({
      rows: [{
        schema_name: values?.[0],
        relation_exists: true,
        missing_columns: [],
        missing_privileges: [],
      }],
    }));
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
    for (const [sql] of query.mock.calls) {
      expect(sql).toContain('pg_catalog.pg_attribute');
      expect(sql).not.toMatch(/FROM\s+"tenant_[ab]"\.agent_background_work_jobs/u);
    }
    expect(query.mock.calls.map(call => call[1])).toEqual([
      ['tenant_a', 'agent_background_work_jobs', ['job_id', 'welfare_claimed', 'state'], ['SELECT']],
      ['tenant_b', 'agent_background_work_jobs', ['job_id', 'welfare_claimed', 'state'], ['SELECT']],
    ]);
  });

  it('fails closed when a tenant relation is absent from the catalog', async () => {
    const verifier = createWelfareGrantVerifierForPool(
      {
        query: vi.fn(async (_sql: string, values?: unknown[]) => ({
          rows: [{
            schema_name: values?.[0],
            relation_exists: false,
            missing_columns: values?.[2],
            missing_privileges: [],
          }],
        })),
      } as unknown as Pool,
      { mode: 'single', schema: 'tenant_a' },
    );

    await expect(verifier.assertReady()).rejects.toThrow(
      'PostgreSQL relation tenant_a.agent_background_work_jobs is missing',
    );
  });
});
