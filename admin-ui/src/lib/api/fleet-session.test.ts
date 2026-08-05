import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  logoutFleetSession,
  readFleetSessionState,
  refreshFleetSession,
} from './fleet-session';

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

  it('serializes concurrent browser-tab rotations with one origin-wide lock', async () => {
    let lockTail = Promise.resolve();
    const requestLock = vi.fn(async <T>(
      _name: string,
      _options: LockOptions,
      callback: () => Promise<T>,
    ): Promise<T> => {
      const previous = lockTail;
      let release = () => {};
      lockTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await callback();
      } finally {
        release();
      }
    });
    vi.stubGlobal('navigator', { locks: { request: requestLock } });
    let activeCeremonies = 0;
    let maximumActiveCeremonies = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      if (path === '/v1/fleet-auth/session/csrf') {
        activeCeremonies += 1;
        maximumActiveCeremonies = Math.max(maximumActiveCeremonies, activeCeremonies);
        return new Response(JSON.stringify({ csrfToken: CSRF_TOKEN }), { status: 200 });
      }
      if (path === '/v1/fleet-auth/session/refresh') {
        activeCeremonies -= 1;
        return new Response(JSON.stringify({
          csrfToken: 'd'.repeat(43),
          principalStatus: 'active',
          idleExpiresAt: '2026-08-03T12:40:00.000Z',
          absoluteExpiresAt: '2026-08-03T20:00:00.000Z',
        }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await Promise.all([refreshFleetSession(), refreshFleetSession()]);

    expect(requestLock).toHaveBeenCalledTimes(2);
    expect(maximumActiveCeremonies).toBe(1);
  });

  it('serializes status, refresh, and logout across the shared session transition', async () => {
    let lockTail = Promise.resolve();
    const requestLock = vi.fn(async <T>(
      _name: string,
      _options: LockOptions,
      callback: () => Promise<T>,
    ): Promise<T> => {
      const previous = lockTail;
      let release = () => {};
      lockTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await callback();
      } finally {
        release();
      }
    });
    vi.stubGlobal('navigator', { locks: { request: requestLock } });
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    let csrfGeneration = 0;
    let currentCsrf = '';
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      await new Promise(resolve => setTimeout(resolve, 2));
      const path = String(input);
      try {
        if (path === '/v1/fleet-auth/session/status') {
          return new Response(JSON.stringify({ schemaVersion: 1, state: 'signed_in' }), {
            status: 200,
          });
        }
        if (path === '/v1/fleet-auth/session/csrf') {
          csrfGeneration += 1;
          currentCsrf = String(csrfGeneration).padStart(43, 'a');
          return new Response(JSON.stringify({ csrfToken: currentCsrf }), { status: 200 });
        }
        const csrf = (init?.headers as Record<string, string> | undefined)?.['X-PSFN-CSRF'];
        if (csrf !== currentCsrf) return new Response('stale csrf', { status: 403 });
        if (path === '/v1/fleet-auth/session/refresh') {
          return new Response(JSON.stringify({
            principalStatus: 'active',
            idleExpiresAt: '2026-08-03T12:40:00.000Z',
            absoluteExpiresAt: '2026-08-03T20:00:00.000Z',
          }), { status: 200 });
        }
        if (path === '/v1/fleet-auth/logout') return new Response(null, { status: 204 });
        throw new Error(`Unexpected request: ${path}`);
      } finally {
        activeRequests -= 1;
      }
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(Promise.all([
      readFleetSessionState(),
      refreshFleetSession(),
      logoutFleetSession(),
    ])).resolves.toHaveLength(3);

    expect(requestLock).toHaveBeenCalledTimes(3);
    expect(new Set(requestLock.mock.calls.map(call => call[0]))).toHaveLength(1);
    expect(requestLock.mock.calls.every(call => call[0] === 'fleet-session-transition')).toBe(true);
    expect(maximumActiveRequests).toBe(1);
  });

  it('reads the canonical session state without exposing browser-owned credentials', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      schemaVersion: 1,
      state: 'signed_in',
      guestMode: 'disabled',
      websocketPath: '/companion-ui/companions/11111111-1111-4111-8111-111111111111/ws',
      human: { provider: 'discord', label: 'Discord user', role: 'owner' },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(readFleetSessionState()).resolves.toBe('signed_in');
    expect(fetchMock).toHaveBeenCalledWith('/v1/fleet-auth/session/status', {
      cache: 'no-store',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
  });
});
