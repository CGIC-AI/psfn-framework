import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  CompanionAuthorityWelfareGrantVerifier,
  createWelfareGrantVerifier,
  createWelfareGrantVerifierForPool,
} from './welfare-grant-verifier.js';
import {
  WELFARE_GRANT_VERIFY_METHOD,
  parseWelfareGrantVerifyParams,
} from './welfare-grant-contract.js';

const COMPANION_A = 'companion-a';
const COMPANION_B = 'companion-b';

function fleetVerifier(
  requestCompanionAgent: (companionId: string, method: string, params: unknown) => Promise<unknown>,
) {
  return new CompanionAuthorityWelfareGrantVerifier({
    companionIds: new Set([COMPANION_A, COMPANION_B]),
    requestCompanionAgent,
  });
}

describe('createWelfareGrantVerifier factory (single-companion degradation contract)', () => {
  it('returns undefined when the dedicated database URL is absent (honest FIFO degradation)', () => {
    // No dedicated welfare verifier credential ⇒ the gateway strips every
    // asserted preemptionProtected (fail closed). The factory must not fall
    // back to any other URL the caller happens to hold.
    expect(createWelfareGrantVerifier({ databaseUrl: '' })).toBeUndefined();
    expect(createWelfareGrantVerifier({ databaseUrl: '   ' })).toBeUndefined();
    expect(createWelfareGrantVerifier({
      databaseUrl: 'postgres://verifier:pw@host/db',
      postgresSchema: 'tenant_a',
    })).toBeDefined();
  });
});

describe('Postgres welfare grant readiness (single-companion scope)', () => {
  it('probes its one tenant relation without reading rows', async () => {
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
      { mode: 'single', schema: 'tenant_a' },
    );

    await verifier.assertReady();

    expect(query).toHaveBeenCalledTimes(1);
    for (const [sql] of query.mock.calls) {
      expect(sql).toContain('pg_catalog.pg_attribute');
      expect(sql).not.toMatch(/FROM\s+"tenant_a"\.agent_background_work_jobs/u);
    }
    expect(query.mock.calls.map(call => call[1])).toEqual([
      ['tenant_a', 'agent_background_work_jobs', ['job_id', 'welfare_claimed', 'state'], ['SELECT']],
    ]);
  });

  it('fails closed when the tenant relation is absent from the catalog', async () => {
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

// psfn-framework-h248l.7: the fleet path asks the authenticated companion's own
// local authority instead of reading a sibling background-work schema, so an
// isolated-role gateway (no sibling grant, no verifier credential) keeps every
// companion's genuine welfare protection instead of stripping it at readiness.
describe('CompanionAuthorityWelfareGrantVerifier (fleet)', () => {
  it('requires no readiness probe and no sibling background-work privilege', async () => {
    const requestCompanionAgent = vi.fn(async () => ({ companionId: COMPANION_A, granted: true }));

    await expect(fleetVerifier(requestCompanionAgent).assertReady()).resolves.toBeUndefined();

    expect(requestCompanionAgent).not.toHaveBeenCalled();
  });

  it('honors an exact grant answered by the companion that owns the job', async () => {
    const requestCompanionAgent = vi.fn(async (companionId: string, _method, params: unknown) => ({
      companionId: parseWelfareGrantVerifyParams(params).companionId,
      granted: companionId === COMPANION_A,
    }));
    const verifier = fleetVerifier(requestCompanionAgent);

    expect(await verifier.verify('a-welfare-running', COMPANION_A)).toBe(true);
    expect(await verifier.verify('a-welfare-running', COMPANION_B)).toBe(false);

    expect(requestCompanionAgent.mock.calls).toEqual([
      [COMPANION_A, WELFARE_GRANT_VERIFY_METHOD, { jobId: 'a-welfare-running', companionId: COMPANION_A }],
      [COMPANION_B, WELFARE_GRANT_VERIFY_METHOD, { jobId: 'a-welfare-running', companionId: COMPANION_B }],
    ]);
  });

  it.each([
    ['an unknown companion', 'a-welfare-running', 'stranger-companion'],
    ['a blank job id', '   ', COMPANION_A],
    ['a blank companion id', 'a-welfare-running', '  '],
  ])('strips %s without asking any companion', async (_label, jobId, companionId) => {
    const requestCompanionAgent = vi.fn(async () => ({ companionId, granted: true }));

    expect(await fleetVerifier(requestCompanionAgent).verify(jobId, companionId)).toBe(false);

    expect(requestCompanionAgent).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a timed-out authority',
      async () => { throw new Error('Companion agent request timed out'); },
      /welfare grant verification is unavailable \(timeout\)/i,
    ],
    [
      'an agent older than the contract',
      async () => { throw Object.assign(new Error('Method not found'), { code: -32601 }); },
      /welfare grant verification is unavailable \(method_unavailable\)/i,
    ],
    [
      'a disconnected authority',
      async () => { throw new Error('No ready companion route'); },
      /welfare grant verification is unavailable \(authority_unavailable\)/i,
    ],
    [
      'a malformed answer',
      async () => ({ companionId: COMPANION_A, granted: 'yes' }),
      /welfare grant verification is unavailable \(malformed_response\)/i,
    ],
    [
      'an answer carrying an extra field',
      async () => ({ companionId: COMPANION_A, granted: true, schema: 'tenant_a' }),
      /welfare grant verification is unavailable \(malformed_response\)/i,
    ],
    [
      'an answer from another companion',
      async () => ({ companionId: COMPANION_B, granted: true }),
      /welfare grant verification is unavailable \(companion_mismatch\)/i,
    ],
  ])('records bounded evidence and never returns true for %s', async (_label, respond, expected) => {
    const verifier = fleetVerifier(respond as () => Promise<unknown>);

    // Rejects rather than resolving false: the RPC boundary logs the reason code
    // and strips. "Cannot tell" must never be recorded as "not welfare".
    await expect(verifier.verify('a-welfare-running', COMPANION_A)).rejects.toThrow(expected);
  });

  it('never carries the asserted job id into its failure evidence', async () => {
    const verifier = fleetVerifier(async () => { throw new Error('Companion agent request timed out'); });

    await expect(verifier.verify('secret-welfare-job-id', COMPANION_A))
      .rejects.toThrow(/^(?!.*secret-welfare-job-id).*$/su);
  });

  it('closes without owning any pool', async () => {
    await expect(fleetVerifier(async () => ({ companionId: COMPANION_A, granted: true })).close())
      .resolves.toBeUndefined();
  });
});
