import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/api/client', () => ({
  throwIfNotOk: async (response: Response) => {
    if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  },
}));

import { withFleetEscalationGrant } from './fleet-escalation';

const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const CSRF_TOKEN = 'a'.repeat(43);
const GRANT_ID = '22222222-2222-4222-8222-222222222222';

function companionGarden(pathname = `/companions/${COMPANION_ID}/garden/values`): void {
  vi.stubGlobal('window', { location: { pathname } });
}

beforeEach(() => {
  vi.stubGlobal('navigator', {
    locks: {
      request: async <T>(
        _name: string,
        _options: LockOptions,
        callback: () => Promise<T>,
      ): Promise<T> => await callback(),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('withFleetEscalationGrant', () => {
  it('mints and spends one same-origin grant inside the session transition lock', async () => {
    companionGarden();
    let lockHeld = false;
    const requestLock = vi.fn(async <T>(
      _name: string,
      _options: LockOptions,
      callback: () => Promise<T>,
    ): Promise<T> => {
      lockHeld = true;
      try {
        return await callback();
      } finally {
        lockHeld = false;
      }
    });
    vi.stubGlobal('navigator', { locks: { request: requestLock } });
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

    await expect(withFleetEscalationGrant({
      method: 'POST',
      target: '/api/admin/privacy-break-glass/journal/reflection-journal/confirm',
      reason: '  Investigating a companion welfare incident.  ',
    }, async (grant, signal) => {
      expect(lockHeld).toBe(true);
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(grant).toEqual({
        grantId: GRANT_ID,
        routeId: 'POST /api/admin/privacy-break-glass/journal/:id/confirm',
        expiresAt: '2026-08-03T12:15:00.000Z',
      });
      return 'spent';
    })).resolves.toBe('spent');
    expect(lockHeld).toBe(false);

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
    expect(requestLock).toHaveBeenCalledTimes(1);
    expect(requestLock).toHaveBeenCalledWith(
      'fleet-session-transition',
      expect.objectContaining({ mode: 'exclusive' }),
      expect.any(Function),
    );
  });

  it('refuses invalid reasons and requests outside an authorized companion Garden', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    companionGarden('/values');

    await expect(withFleetEscalationGrant({
      method: 'POST',
      target: '/api/admin/privacy-break-glass/journal/values-journal/confirm',
      reason: 'welfare review',
    }, vi.fn())).rejects.toThrow(/authorized companion Garden route/u);

    companionGarden();
    await expect(withFleetEscalationGrant({
      method: 'POST',
      target: '/api/admin/privacy-break-glass/journal/values-journal/confirm',
      reason: '   ',
    }, vi.fn())).rejects.toThrow(/escalation reason/u);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
