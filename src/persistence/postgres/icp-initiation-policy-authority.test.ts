import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { PostgresIcpInitiationPolicyAuthority } from './icp-initiation-policy-authority.js';

const quietHours = {
  enabled: false,
  startLocalTime: '22:00',
  endLocalTime: '07:00',
  timeZone: 'UTC',
} as const;

function createAuthority(query: Pool['query']): PostgresIcpInitiationPolicyAuthority {
  return new PostgresIcpInitiationPolicyAuthority('postgres://test', {
    fleet: [
      {
        companionId: 'companion-a',
        postgresSchema: 'tenant_a',
        companionDataDir: '/tmp/psfn-icp-readiness-a',
      },
      {
        companionId: 'companion-b',
        postgresSchema: 'tenant_b',
        companionDataDir: '/tmp/psfn-icp-readiness-b',
      },
    ],
    quietHours,
    pool: { query } as unknown as Pool,
  });
}

describe('PostgresIcpInitiationPolicyAuthority readiness', () => {
  it('proves every tenant relation through privilege-safe catalog metadata', async () => {
    const query = vi.fn(async (_sql: string, values?: unknown[]) => ({
      rows: [{
        schema_name: values?.[0],
        relation_exists: true,
        missing_columns: [],
        missing_privileges: [],
      }],
    }));
    const authority = createAuthority(query as unknown as Pool['query']);

    await authority.assertReady();

    expect(query).toHaveBeenCalledTimes(6);
    for (const [sql] of query.mock.calls) {
      expect(sql).toContain('pg_catalog.pg_attribute');
      expect(sql).not.toMatch(/FROM\s+"tenant_[ab]"\./u);
    }
    expect(query.mock.calls.map(call => call[1]?.slice(0, 2))).toEqual([
      ['tenant_a', 'icp_initiation_candidates'],
      ['tenant_a', 'contacts'],
      ['tenant_a', 'contact_channel_ids'],
      ['tenant_b', 'icp_initiation_candidates'],
      ['tenant_b', 'contacts'],
      ['tenant_b', 'contact_channel_ids'],
    ]);
    for (const call of query.mock.calls) {
      expect(call[1]?.[3]).toEqual(['SELECT', 'UPDATE']);
    }
  });

  it('fails readiness when a required tenant relation is absent', async () => {
    const authority = createAuthority(vi.fn(async (_sql: string, values?: unknown[]) => ({
      rows: [{
        schema_name: values?.[0],
        relation_exists: false,
        missing_columns: values?.[2],
        missing_privileges: [],
      }],
    })) as unknown as Pool['query']);

    await expect(authority.assertReady()).rejects.toThrow(
      'PostgreSQL relation tenant_a.icp_initiation_candidates is missing',
    );
  });
});
