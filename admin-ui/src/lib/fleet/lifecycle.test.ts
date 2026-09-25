import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FleetLifecycleRequestError,
  applyFleetLifecyclePlan,
  fetchFleetLifecycleListing,
  parseFleetLifecycleListing,
  parseFleetLifecycleProgress,
  requestFleetLifecyclePlan,
} from './lifecycle';
import { createCompanionId } from '../../../../src/shared/routing/companion-id.js';
import { compileGatewayGardenRequestTarget } from '../../../../src/boundary/fleet-auth/request-capability-target.js';

const NOVA = '33333333-3333-4333-8333-333333333333';
const PLAN_ID = '44444444-4444-4444-8444-444444444444';
const DIGEST = 'a'.repeat(64);

const PLAN = {
  schemaVersion: 1,
  planId: PLAN_ID,
  createdAt: '2026-09-24T12:00:00.000Z',
  operation: 'remove',
  companionId: NOVA,
  baseRevision: 'b'.repeat(64),
  targetRevision: 'c'.repeat(64),
  stages: ['fence_icp', 'verify_fleet_auth_retired', 'drain_workload', 'withdraw_membership'],
  request: { operation: 'remove', companionId: NOVA, confirmCompanionId: NOVA },
  retention: { postgresSchema: 'companion_nova', companionDataDir: 'companions/nova', personalWorkspace: true, backups: true },
  digest: DIGEST,
};

afterEach(() => vi.unstubAllGlobals());

describe('Fleet lifecycle client contract', () => {
  it('parses the exact plan/progress contract the CLI prints', () => {
    const progress = parseFleetLifecycleProgress({
      plan: PLAN,
      status: 'failed',
      receipts: [{ planId: PLAN_ID, stageId: 'fence_icp', outcome: 'applied', at: '2026-09-24T12:00:01.000Z' }],
      failure: { planId: PLAN_ID, stageId: 'verify_fleet_auth_retired', code: 'fleet_auth_not_retired', at: '2026-09-24T12:00:02.000Z' },
    });
    expect(progress.plan.retention).toMatchObject({ backups: true });
    expect(progress.failure?.code).toBe('fleet_auth_not_retired');
    expect(parseFleetLifecycleListing({ schemaVersion: 1, applyMode: 'cli_only', plans: [] }).applyMode)
      .toBe('cli_only');
  });

  it('rejects widened plans, unknown stages, and purge-shaped retention', () => {
    expect(() => parseFleetLifecycleProgress({ plan: { ...PLAN, secret: 'x' }, status: 'planned', receipts: [] }))
      .toThrow(/invalid plan/u);
    expect(() => parseFleetLifecycleProgress({ plan: { ...PLAN, stages: ['purge_schema'] }, status: 'planned', receipts: [] }))
      .toThrow(/unknown stage/u);
    expect(() => parseFleetLifecycleProgress({
      plan: { ...PLAN, retention: { ...PLAN.retention, backups: false } }, status: 'planned', receipts: [],
    })).toThrow(/retention/u);
  });

  it('never sends a secret value and surfaces typed server refusals', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { type: 'stale_topology' } }), { status: 409 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(requestFleetLifecyclePlan({
      operation: 'add',
      companion: { companionId: NOVA, postgresDatabaseUrlRef: 'postgres://user:secret@host/db' },
      readmit: 'yes',
    })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();

    const error = await applyFleetLifecyclePlan({
      plan: parseFleetLifecycleProgress({ plan: PLAN, status: 'planned', receipts: [] }).plan,
      confirmCompanionId: NOVA,
      resume: false,
    }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(FleetLifecycleRequestError);
    expect((error as FleetLifecycleRequestError).code).toBe('stale_topology');
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe(`/v1/fleet/lifecycle/plans/${PLAN_ID}/apply`);
    expect(JSON.parse(String(init.body))).toEqual({ planDigest: DIGEST, resume: false, confirmCompanionId: NOVA });
  });

  it('keeps plans out of browser storage and wires the Membership view', () => {
    const component = readFileSync(new URL('../components/fleet/FleetLifecycle.svelte', import.meta.url), 'utf8');
    expect(component).not.toMatch(/localStorage|sessionStorage|indexedDB/u);
    expect(component).toContain("confirmation.trim() !== reviewed.companionId");
    const page = readFileSync(new URL('../../routes/fleet/+page.svelte', import.meta.url), 'utf8');
    expect(page).toContain('<FleetLifecycle {projection} />');
  });

  it('stays outside the Garden capability catalogue so no capability can be minted for it', () => {
    const companionId = createCompanionId('11111111-1111-4111-8111-111111111111');
    for (const [method, rawTarget, body] of [
      ['GET', '/v1/fleet/lifecycle/plans', ''],
      ['POST', '/v1/fleet/lifecycle/plans', '{}'],
      ['POST', `/v1/fleet/lifecycle/plans/${PLAN_ID}/apply`, '{}'],
    ] as const) {
      expect(() => compileGatewayGardenRequestTarget({
        rawTarget,
        method,
        companionId,
        body: new TextEncoder().encode(body),
        ...(body ? { headers: { 'content-type': 'application/json' } } : {}),
      }), `${method} ${rawTarget}`).toThrow();
    }
  });

  it('sends literal same-origin requests and redirects an expired operator session', async () => {
    const location = { assign: vi.fn() };
    vi.stubGlobal('window', { location });
    const fetchMock = vi.fn(async () => new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchFleetLifecycleListing()).rejects.toMatchObject({ code: 'unauthorized' });
    expect(location.assign).toHaveBeenCalledWith('/fleet/login');
    expect(fetchMock).toHaveBeenCalledWith('/v1/fleet/lifecycle/plans', expect.objectContaining({
      method: 'GET', cache: 'no-store', credentials: 'include',
    }));
  });
});
