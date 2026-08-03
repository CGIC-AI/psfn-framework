import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/api/client', () => ({
  throwIfNotOk: async (response: Response) => {
    if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  },
}));

import { issueFleetEscalationGrant } from './fleet-escalation';

const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const CSRF_TOKEN = 'a'.repeat(43);
const GRANT_ID = '22222222-2222-4222-8222-222222222222';

function companionGarden(pathname = `/companions/${COMPANION_ID}/garden/values`): void {
  vi.stubGlobal('window', { location: { pathname } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('issueFleetEscalationGrant', () => {
  it('mints one same-origin CSRF-bound grant for an exact companion Garden target', async () => {
    companionGarden();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: CSRF_TOKEN }), {
        status: 200,
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        grantId: GRANT_ID,
        routeId: 'POST /api/admin/privacy-break-glass/journal/:id/confirm',
        expiresAt: '2026-08-03T12:15:00.000Z',
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(issueFleetEscalationGrant({
      method: 'POST',
      target: '/api/admin/privacy-break-glass/journal/reflection-journal/confirm',
      reason: '  Investigating a companion welfare incident.  ',
    })).resolves.toEqual({
      grantId: GRANT_ID,
      routeId: 'POST /api/admin/privacy-break-glass/journal/:id/confirm',
      expiresAt: '2026-08-03T12:15:00.000Z',
    });

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/v1/fleet-auth/session/csrf', {
      cache: 'no-store',
      credentials: 'include',
      headers: { Accept: 'application/json' },
      signal: expect.any(AbortSignal),
    });
    const [grantPath, grantInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(grantPath).toBe('/v1/fleet-auth/escalation/grant');
    expect(grantInit).toMatchObject({
      method: 'POST',
      cache: 'no-store',
      credentials: 'include',
      signal: expect.any(AbortSignal),
    });
    expect((grantInit.headers as Record<string, string>)['X-PSFN-CSRF']).toBe(CSRF_TOKEN);
    expect(grantInit.body).toBe(JSON.stringify({
      companionId: COMPANION_ID,
      method: 'POST',
      target: '/api/admin/privacy-break-glass/journal/reflection-journal/confirm',
      reason: 'Investigating a companion welfare incident.',
    }));
  });

  it('refuses invalid reasons and requests outside an authorized companion Garden', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    companionGarden('/values');

    await expect(issueFleetEscalationGrant({
      method: 'POST',
      target: '/api/admin/privacy-break-glass/journal/values-journal/confirm',
      reason: 'welfare review',
    })).rejects.toThrow(/authorized companion Garden route/u);

    companionGarden();
    await expect(issueFleetEscalationGrant({
      method: 'POST',
      target: '/api/admin/privacy-break-glass/journal/values-journal/confirm',
      reason: '   ',
    })).rejects.toThrow(/escalation reason/u);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
