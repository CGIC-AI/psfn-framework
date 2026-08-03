import { afterEach, describe, expect, it, vi } from 'vitest';
import { refreshFleetSession } from './fleet-session';

const CSRF_TOKEN = 'c'.repeat(43);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('refreshFleetSession', () => {
  it('rotates the HttpOnly fleet session through same-origin CSRF-bound routes', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: CSRF_TOKEN }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        csrfToken: 'd'.repeat(43),
        principalStatus: 'active',
        idleExpiresAt: '2026-08-03T12:40:00.000Z',
        absoluteExpiresAt: '2026-08-03T20:00:00.000Z',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(refreshFleetSession()).resolves.toEqual({
      principalStatus: 'active',
      idleExpiresAtMs: Date.parse('2026-08-03T12:40:00.000Z'),
      absoluteExpiresAtMs: Date.parse('2026-08-03T20:00:00.000Z'),
    });

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/v1/fleet-auth/session/csrf', {
      cache: 'no-store',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/v1/fleet-auth/session/refresh', {
      method: 'POST',
      cache: 'no-store',
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        'X-PSFN-CSRF': CSRF_TOKEN,
      },
    });
  });

  it('rejects an impossible server expiry contract', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: CSRF_TOKEN }), {
        status: 200,
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        csrfToken: 'd'.repeat(43),
        principalStatus: 'active',
        idleExpiresAt: '2026-08-03T20:00:00.001Z',
        absoluteExpiresAt: '2026-08-03T20:00:00.000Z',
      }), { status: 200 })));

    await expect(refreshFleetSession()).rejects.toThrow(/response is malformed/u);
  });
});
