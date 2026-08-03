import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/api/client', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('$lib/api/fleet-escalation', () => ({
  FLEET_ESCALATION_GRANT_HEADER: 'x-psfn-escalation-grant',
  issueFleetEscalationGrant: vi.fn(),
}));

import { apiPost as apiPostImport } from '$lib/api/client';
import { issueFleetEscalationGrant as issueGrantImport } from '$lib/api/fleet-escalation';
import {
  resolveConcern,
  resolveStaleConcerns,
  suppressConcern,
  transitionConcern,
} from './concerns.js';

const apiPost = vi.mocked(apiPostImport);
const issueGrant = vi.mocked(issueGrantImport);
const GRANT_ID = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  apiPost.mockReset().mockResolvedValue({ ok: true });
  issueGrant.mockReset().mockResolvedValue({
    grantId: GRANT_ID,
    routeId: 'cogsec.manage',
    expiresAt: new Date(0).toISOString(),
  });
});

describe('audited concern mutations', () => {
  it.each([
    {
      act: () => resolveConcern('concern/a', 'Investigate a reported policy conflict', 'resolved safely'),
      target: '/api/admin/concerns/concern%2Fa/resolve',
      reason: 'Investigate a reported policy conflict',
      body: { outcome: 'resolved safely' },
    },
    {
      act: () => suppressConcern('concern/a', 'Suppress a confirmed duplicate', 'duplicate'),
      target: '/api/admin/concerns/concern%2Fa/suppress',
      reason: 'Suppress a confirmed duplicate',
      body: { outcome: 'duplicate' },
    },
    {
      act: () => transitionConcern(
        'concern/a',
        'watching',
        'Monitor the concern while evidence develops',
        { outcome: 'monitoring' },
      ),
      target: '/api/admin/concerns/concern%2Fa/transition',
      reason: 'Monitor the concern while evidence develops',
      body: { status: 'watching', outcome: 'monitoring' },
    },
    {
      act: () => resolveStaleConcerns('Clear stale concern projections after review'),
      target: '/api/admin/concerns/resolve-stale',
      reason: 'Clear stale concern projections after review',
      body: {},
    },
  ])('mints and immediately spends one grant for $target', async ({ act, target, reason, body }) => {
    await expect(act()).resolves.toEqual({ ok: true });

    expect(issueGrant).toHaveBeenCalledOnce();
    expect(issueGrant).toHaveBeenCalledWith({
      method: 'POST',
      target,
      reason,
    });
    expect(apiPost).toHaveBeenCalledWith(target, body, {
      headers: { 'x-psfn-escalation-grant': GRANT_ID },
    });
  });

  it('never sends the concern action when grant issuance fails closed', async () => {
    issueGrant.mockRejectedValue(new Error('Escalation grant is unavailable'));

    await expect(resolveConcern('concern-a', 'Resolve after reviewed remediation'))
      .rejects.toThrow(/grant is unavailable/u);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('does not reuse a grant when a failed action is retried', async () => {
    issueGrant
      .mockResolvedValueOnce({ grantId: GRANT_ID, routeId: 'cogsec.manage', expiresAt: new Date(0).toISOString() })
      .mockResolvedValueOnce({
        grantId: '33333333-3333-4333-8333-333333333333',
        routeId: 'cogsec.manage',
        expiresAt: new Date(0).toISOString(),
      });
    apiPost.mockRejectedValueOnce(new Error('upstream failed')).mockResolvedValueOnce({ ok: true });

    await expect(resolveConcern('concern-a', 'Resolve after reviewed remediation')).rejects.toThrow();
    await expect(resolveConcern('concern-a', 'Resolve after reviewed remediation')).resolves.toEqual({ ok: true });

    expect(issueGrant).toHaveBeenCalledTimes(2);
    expect(apiPost.mock.calls.map((call) => call[2])).toEqual([
      { headers: { 'x-psfn-escalation-grant': GRANT_ID } },
      { headers: { 'x-psfn-escalation-grant': '33333333-3333-4333-8333-333333333333' } },
    ]);
  });
});
