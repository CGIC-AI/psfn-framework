import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  logoutFleetSession,
  readFleetSessionState,
  refreshFleetSession,
} from './fleet-session';

const CSRF_TOKEN = 'c'.repeat(43);

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
  vi.restoreAllMocks();
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
      signal: expect.any(AbortSignal),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/v1/fleet-auth/session/refresh', {
      method: 'POST',
      cache: 'no-store',
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        'X-PSFN-CSRF': CSRF_TOKEN,
      },
      signal: expect.any(AbortSignal),
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
        if (path === '/v1/fleet/portal') {
          return new Response(JSON.stringify({ schemaVersion: 2 }), { status: 200 });
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

  it('fails closed in a browser without origin-wide lock support', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('fetch', fetchMock);

    await expect(readFleetSessionState()).rejects.toThrow(/coordination is unavailable/u);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('bounds a stalled lock holder with the transition deadline', async () => {
    const timeoutController = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutController.signal);
    let lockReleased = false;
    const requestLock = vi.fn(async <T>(
      _name: string,
      _options: LockOptions,
      callback: () => Promise<T>,
    ): Promise<T> => {
      try {
        return await callback();
      } finally {
        lockReleased = true;
      }
    });
    vi.stubGlobal('navigator', { locks: { request: requestLock } });
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) throw new Error('Expected a bounded transition signal');
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      })
    ));
    vi.stubGlobal('fetch', fetchMock);

    const refresh = refreshFleetSession();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    timeoutController.abort(new DOMException('Timed out', 'TimeoutError'));

    await expect(refresh).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(lockReleased).toBe(true);
  });

  it('reads session authority from the always-present fleet portal route', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ schemaVersion: 2 }), {
      status: 200,
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(readFleetSessionState()).resolves.toBe('signed_in');
    expect(fetchMock).toHaveBeenCalledWith('/v1/fleet/portal', {
      cache: 'no-store',
      credentials: 'include',
      headers: { Accept: 'application/json' },
      signal: expect.any(AbortSignal),
    });
  });

  it('maps a portal authentication denial to signed out without clearing credentials', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      error: { type: 'fleet_portal_denied' },
    }), { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(readFleetSessionState()).resolves.toBe('signed_out');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([201, 204, 206])('rejects unexpected successful portal status %i', async status => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status })));

    await expect(readFleetSessionState()).rejects.toThrow(
      `Fleet session authority returned unexpected status ${status}`,
    );
  });
});
