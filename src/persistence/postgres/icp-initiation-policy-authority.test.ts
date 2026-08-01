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
  it('proves every tenant relation and the row-lock privileges used later', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const authority = createAuthority(query as unknown as Pool['query']);

    await authority.assertReady();

    expect(query).toHaveBeenCalledTimes(6);
    for (const offset of [0, 3]) {
      expect(query.mock.calls[offset]?.[0]).toMatch(
        /FROM "tenant_[ab]"\.icp_initiation_candidates[\s\S]*LIMIT 0[\s\S]*FOR SHARE/u,
      );
      expect(query.mock.calls[offset + 1]?.[0]).toMatch(
        /FROM "tenant_[ab]"\.contacts[\s\S]*LIMIT 0[\s\S]*FOR UPDATE/u,
      );
      expect(query.mock.calls[offset + 2]?.[0]).toMatch(
        /FROM "tenant_[ab]"\.contact_channel_ids[\s\S]*LIMIT 0[\s\S]*FOR SHARE/u,
      );
    }
  });

  it('fails readiness when the production role cannot acquire its required lock', async () => {
    const authority = createAuthority(vi.fn(async () => {
      throw new Error('permission denied for table contacts');
    }) as unknown as Pool['query']);

    await expect(authority.assertReady()).rejects.toThrow('permission denied for table contacts');
  });
});
