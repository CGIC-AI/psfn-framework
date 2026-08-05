import { afterEach, describe, expect, it, vi } from 'vitest';

type AuthStore = typeof import('./auth.svelte');

const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const CSRF_TOKEN = 'c'.repeat(43);

class FakeVisibilityDocument {
  hidden: boolean;
  private readonly listeners = new Set<() => void>();

  constructor(hidden = false) {
    this.hidden = hidden;
  }

  addEventListener(_type: 'visibilitychange', listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'visibilitychange', listener: () => void): void {
    this.listeners.delete(listener);
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    for (const listener of this.listeners) listener();
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

function shouldRedirectToLogin(auth: AuthStore): boolean {
  return auth.isAuthResolved() && !auth.isAuthenticated();
}

async function loadAuthStore(
  fetchImpl: typeof fetch,
  options: { pathname?: string; documentRef?: FakeVisibilityDocument } = {},
): Promise<AuthStore> {
  vi.resetModules();
  vi.stubGlobal('window', {
    location: { pathname: options.pathname ?? '/', href: '' },
    localStorage: { removeItem: vi.fn() },
  });
  // Node 24 exposes process-wide Web Locks. Keep each synthetic store lifecycle
  // isolated while preserving the browser's exclusive transition semantics.
  let lockTail = Promise.resolve();
  vi.stubGlobal('navigator', {
    locks: {
      request: async <T>(
        _name: string,
        _options: LockOptions,
        callback: () => Promise<T>,
      ): Promise<T> => {
        const previous = lockTail;
        let release = () => {};
        lockTail = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        try {
          return await callback();
        } finally {
          release();
        }
      },
    },
  });
  if (options.documentRef) vi.stubGlobal('document', options.documentRef);
  vi.stubGlobal('fetch', vi.fn(fetchImpl));
  return import('./auth.svelte');
}

async function flushAsyncWork(): Promise<void> {
  for (let count = 0; count < 8; count += 1) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Garden admin session auth guard', () => {
  it('resolves and renews an authenticated fleet overview session', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T12:00:00.000Z'));
    const documentRef = new FakeVisibilityDocument();
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      if (path === '/v1/fleet/portal') {
        return new Response(JSON.stringify({ schemaVersion: 2 }), { status: 200 });
      }
      if (path === '/v1/fleet-auth/session/csrf') {
        return new Response(JSON.stringify({ csrfToken: CSRF_TOKEN }), { status: 200 });
      }
      if (path === '/v1/fleet-auth/session/refresh') {
        return new Response(JSON.stringify({
          principalStatus: 'active',
          idleExpiresAt: '2026-08-03T12:40:00.000Z',
          absoluteExpiresAt: '2026-08-03T20:00:00.000Z',
        }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const auth = await loadAuthStore(fetchImpl as typeof fetch, {
      pathname: '/fleet',
      documentRef,
    });

    auth.startServerSessionRefresh();
    await expect(auth.ensureAuthResolved()).resolves.toBe(true);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));

    expect(auth.isAuthenticated()).toBe(true);
    expect(fetchImpl.mock.calls.map(call => String(call[0]))).toEqual([
      '/v1/fleet/portal',
      '/v1/fleet-auth/session/csrf',
      '/v1/fleet-auth/session/refresh',
    ]);
    auth.stopServerSessionRefresh();
  });

  it('rotates an authenticated fleet session and schedules from the returned idle expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T12:00:00.000Z'));
    const documentRef = new FakeVisibilityDocument();
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      if (path.endsWith('/api/admin/dashboard')) return new Response('{}', { status: 200 });
      if (path === '/v1/fleet-auth/session/csrf') {
        return new Response(JSON.stringify({ csrfToken: CSRF_TOKEN }), { status: 200 });
      }
      if (path === '/v1/fleet-auth/session/refresh') {
        return new Response(JSON.stringify({
          csrfToken: 'd'.repeat(43),
          principalStatus: 'active',
          idleExpiresAt: new Date(Date.now() + 40 * 60_000).toISOString(),
          absoluteExpiresAt: '2026-08-03T20:00:00.000Z',
        }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const auth = await loadAuthStore(fetchImpl as typeof fetch, {
      pathname: `/companions/${COMPANION_ID}/garden`,
      documentRef,
    });

    auth.startServerSessionRefresh();
    await expect(auth.ensureAuthResolved()).resolves.toBe(true);
    await flushAsyncWork();

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    await vi.advanceTimersByTimeAsync(19 * 60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    await flushAsyncWork();
    expect(fetchImpl).toHaveBeenCalledTimes(5);

    auth.stopServerSessionRefresh();
  });

  it('defers fleet session traffic while hidden and refreshes once when visible', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T12:00:00.000Z'));
    const documentRef = new FakeVisibilityDocument(true);
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      if (path.endsWith('/api/admin/dashboard')) return new Response('{}', { status: 200 });
      if (path === '/v1/fleet-auth/session/csrf') {
        return new Response(JSON.stringify({ csrfToken: CSRF_TOKEN }), { status: 200 });
      }
      if (path === '/v1/fleet-auth/session/refresh') {
        return new Response(JSON.stringify({
          csrfToken: 'd'.repeat(43),
          principalStatus: 'active',
          idleExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
          absoluteExpiresAt: '2026-08-03T20:00:00.000Z',
        }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const auth = await loadAuthStore(fetchImpl as typeof fetch, {
      pathname: `/companions/${COMPANION_ID}/garden/memory`,
      documentRef,
    });

    auth.startServerSessionRefresh();
    await expect(auth.ensureAuthResolved()).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    documentRef.setHidden(false);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    documentRef.setHidden(false);
    await flushAsyncWork();
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    auth.stopServerSessionRefresh();
  });

  it('reconciles a stale tab-local idle deadline after a sibling refresh', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T12:00:00.000Z'));
    const documentRef = new FakeVisibilityDocument();
    let refreshCalls = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      if (path.endsWith('/api/admin/dashboard')) return new Response('{}', { status: 200 });
      if (path === '/v1/fleet-auth/session/csrf') {
        return new Response(JSON.stringify({ csrfToken: CSRF_TOKEN }), { status: 200 });
      }
      if (path === '/v1/fleet-auth/session/refresh') {
        refreshCalls += 1;
        return new Response(JSON.stringify({
          principalStatus: 'active',
          idleExpiresAt: refreshCalls === 1
            ? '2026-08-03T12:30:00.000Z'
            : '2026-08-03T13:30:00.000Z',
          absoluteExpiresAt: '2026-08-03T20:00:00.000Z',
        }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const auth = await loadAuthStore(fetchImpl as typeof fetch, {
      pathname: `/companions/${COMPANION_ID}/garden`,
      documentRef,
    });

    auth.startServerSessionRefresh();
    await auth.ensureAuthResolved();
    await vi.waitFor(() => expect(refreshCalls).toBe(1));
    documentRef.setHidden(true);

    // A sibling tab rotates the origin-wide cookie while this hidden tab keeps
    // its older local 12:30 idle deadline.
    await vi.advanceTimersByTimeAsync(40 * 60_000);
    documentRef.setHidden(false);
    await vi.waitFor(() => expect(refreshCalls).toBe(2));

    expect(auth.isAuthenticated()).toBe(true);
    expect(window.location.href).toBe('');
    auth.stopServerSessionRefresh();
  });

  it('retries a transient foreground failure after a stale local idle deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T12:00:00.000Z'));
    const documentRef = new FakeVisibilityDocument();
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let csrfCalls = 0;
    let refreshCalls = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      if (path.endsWith('/api/admin/dashboard')) return new Response('{}', { status: 200 });
      if (path === '/v1/fleet-auth/session/csrf') {
        csrfCalls += 1;
        if (csrfCalls === 2) return new Response('temporarily unavailable', { status: 503 });
        return new Response(JSON.stringify({ csrfToken: CSRF_TOKEN }), { status: 200 });
      }
      if (path === '/v1/fleet-auth/session/refresh') {
        refreshCalls += 1;
        return new Response(JSON.stringify({
          principalStatus: 'active',
          idleExpiresAt: refreshCalls === 1
            ? '2026-08-03T12:30:00.000Z'
            : '2026-08-03T13:30:00.000Z',
          absoluteExpiresAt: '2026-08-03T20:00:00.000Z',
        }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const auth = await loadAuthStore(fetchImpl as typeof fetch, {
      pathname: `/companions/${COMPANION_ID}/garden`,
      documentRef,
    });

    auth.startServerSessionRefresh();
    await auth.ensureAuthResolved();
    await vi.waitFor(() => expect(refreshCalls).toBe(1));
    documentRef.setHidden(true);
    await vi.advanceTimersByTimeAsync(40 * 60_000);
    documentRef.setHidden(false);
    await vi.waitFor(() => expect(csrfCalls).toBe(2));

    expect(auth.isAuthenticated()).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(refreshCalls).toBe(2));
    expect(auth.isAuthenticated()).toBe(true);
    expect(consoleWarn).toHaveBeenCalledTimes(1);
    auth.stopServerSessionRefresh();
  });

  it('retries the first transient renewal failure before an idle deadline is learned', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T12:00:00.000Z'));
    const documentRef = new FakeVisibilityDocument();
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let csrfCalls = 0;
    let refreshCalls = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      if (path.endsWith('/api/admin/dashboard')) return new Response('{}', { status: 200 });
      if (path === '/v1/fleet-auth/session/csrf') {
        csrfCalls += 1;
        if (csrfCalls === 1) return new Response('temporarily unavailable', { status: 503 });
        return new Response(JSON.stringify({ csrfToken: CSRF_TOKEN }), { status: 200 });
      }
      if (path === '/v1/fleet-auth/session/refresh') {
        refreshCalls += 1;
        return new Response(JSON.stringify({
          principalStatus: 'active',
          idleExpiresAt: '2026-08-03T12:40:00.000Z',
          absoluteExpiresAt: '2026-08-03T20:00:00.000Z',
        }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const auth = await loadAuthStore(fetchImpl as typeof fetch, {
      pathname: `/companions/${COMPANION_ID}/garden`,
      documentRef,
    });

    auth.startServerSessionRefresh();
    await expect(auth.ensureAuthResolved()).resolves.toBe(true);
    await flushAsyncWork();
    expect(csrfCalls).toBe(1);
    expect(refreshCalls).toBe(0);
    expect(auth.isAuthenticated()).toBe(true);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(csrfCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(refreshCalls).toBe(1));
    expect(csrfCalls).toBe(2);
    expect(auth.isAuthenticated()).toBe(true);
    expect(consoleWarn).toHaveBeenCalledTimes(1);

    auth.stopServerSessionRefresh();
  });

  it('cleans the fleet refresh timer and visibility listener on teardown', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T12:00:00.000Z'));
    const documentRef = new FakeVisibilityDocument();
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      if (path.endsWith('/api/admin/dashboard')) return new Response('{}', { status: 200 });
      if (path === '/v1/fleet-auth/session/csrf') {
        return new Response(JSON.stringify({ csrfToken: CSRF_TOKEN }), { status: 200 });
      }
      if (path === '/v1/fleet-auth/session/refresh') {
        return new Response(JSON.stringify({
          csrfToken: 'd'.repeat(43),
          principalStatus: 'active',
          idleExpiresAt: '2026-08-03T12:30:00.000Z',
          absoluteExpiresAt: '2026-08-03T20:00:00.000Z',
        }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const auth = await loadAuthStore(fetchImpl as typeof fetch, {
      pathname: `/companions/${COMPANION_ID}/garden`,
      documentRef,
    });

    auth.startServerSessionRefresh();
    await auth.ensureAuthResolved();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    expect(documentRef.listenerCount()).toBe(1);

    auth.stopServerSessionRefresh();
    expect(documentRef.listenerCount()).toBe(0);
    documentRef.setHidden(true);
    documentRef.setHidden(false);
    await vi.advanceTimersByTimeAsync(8 * 60 * 60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('suppresses concurrent rotation attempts while one CSRF-bound refresh is in flight', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T12:00:00.000Z'));
    const documentRef = new FakeVisibilityDocument();
    let resolveCsrf = (_response: Response) => {};
    const csrfPending = new Promise<Response>((resolve) => {
      resolveCsrf = resolve;
    });
    const fetchImpl = vi.fn((input: string | URL | Request): Promise<Response> => {
      const path = String(input);
      if (path.endsWith('/api/admin/dashboard')) {
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      if (path === '/v1/fleet-auth/session/csrf') return csrfPending;
      if (path === '/v1/fleet-auth/session/refresh') {
        return Promise.resolve(new Response(JSON.stringify({
          csrfToken: 'd'.repeat(43),
          principalStatus: 'active',
          idleExpiresAt: '2026-08-03T12:30:00.000Z',
          absoluteExpiresAt: '2026-08-03T20:00:00.000Z',
        }), { status: 200 }));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const auth = await loadAuthStore(fetchImpl as typeof fetch, {
      pathname: `/companions/${COMPANION_ID}/garden`,
      documentRef,
    });

    auth.startServerSessionRefresh();
    await auth.ensureAuthResolved();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));

    documentRef.setHidden(true);
    documentRef.setHidden(false);
    documentRef.setHidden(false);
    await flushAsyncWork();
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    resolveCsrf(new Response(JSON.stringify({ csrfToken: CSRF_TOKEN }), { status: 200 }));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));

    auth.stopServerSessionRefresh();
  });

  it('abandons an in-flight rotation across teardown and starts a fresh lifecycle request', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T12:00:00.000Z'));
    const documentRef = new FakeVisibilityDocument();
    let resolveFirstCsrf = (_response: Response) => {};
    let csrfCalls = 0;
    const fetchImpl = vi.fn((
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const path = String(input);
      if (path.endsWith('/api/admin/dashboard')) {
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      if (path === '/v1/fleet-auth/session/csrf') {
        csrfCalls += 1;
        if (csrfCalls === 1) {
          return new Promise<Response>((resolve, reject) => {
            resolveFirstCsrf = resolve;
            const requestSignal = init?.signal;
            requestSignal?.addEventListener('abort', () => reject(requestSignal.reason), {
              once: true,
            });
          });
        }
        return Promise.resolve(new Response(JSON.stringify({ csrfToken: CSRF_TOKEN }), {
          status: 200,
        }));
      }
      if (path === '/v1/fleet-auth/session/refresh') {
        return Promise.resolve(new Response(JSON.stringify({
          csrfToken: 'd'.repeat(43),
          principalStatus: 'active',
          idleExpiresAt: '2026-08-03T12:30:00.000Z',
          absoluteExpiresAt: '2026-08-03T20:00:00.000Z',
        }), { status: 200 }));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const auth = await loadAuthStore(fetchImpl as typeof fetch, {
      pathname: `/companions/${COMPANION_ID}/garden`,
      documentRef,
    });

    auth.startServerSessionRefresh();
    await auth.ensureAuthResolved();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));

    auth.stopServerSessionRefresh();
    auth.startServerSessionRefresh();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(4));

    resolveFirstCsrf(new Response(JSON.stringify({ csrfToken: CSRF_TOKEN }), { status: 200 }));
    await flushAsyncWork();
    expect(fetchImpl).toHaveBeenCalledTimes(4);

    auth.stopServerSessionRefresh();
  });

  it('returns a definitively rejected refresh to the existing fleet login path', async () => {
    const documentRef = new FakeVisibilityDocument();
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      if (path.endsWith('/api/admin/dashboard')) return new Response('{}', { status: 200 });
      if (path === '/v1/fleet/portal') {
        return new Response(JSON.stringify({ schemaVersion: 1, state: 'signed_out' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        error: { type: 'reauthentication_required', message: 'Reauthentication is required' },
      }), { status: 401, headers: { 'content-type': 'application/json' } });
    });
    const auth = await loadAuthStore(fetchImpl as typeof fetch, {
      pathname: `/companions/${COMPANION_ID}/garden`,
      documentRef,
    });

    auth.startServerSessionRefresh();
    await auth.ensureAuthResolved();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    await flushAsyncWork();

    expect(auth.isAuthenticated()).toBe(false);
    expect(window.location.href).toBe('/fleet/login');
    expect(consoleWarn).not.toHaveBeenCalled();

    auth.stopServerSessionRefresh();
  });

  it('reconciles a stale refresh after another tab advances the shared session cookie', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T12:00:00.000Z'));
    const documentRef = new FakeVisibilityDocument();
    let dashboardCalls = 0;
    let statusCalls = 0;
    let csrfCalls = 0;
    let refreshCalls = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      if (path.endsWith('/api/admin/dashboard')) {
        dashboardCalls += 1;
        return new Response('{}', { status: 200 });
      }
      if (path === '/v1/fleet/portal') {
        statusCalls += 1;
        return new Response(JSON.stringify({ schemaVersion: 2 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (path === '/v1/fleet-auth/session/csrf') {
        csrfCalls += 1;
        return new Response(JSON.stringify({ csrfToken: CSRF_TOKEN }), { status: 200 });
      }
      if (path === '/v1/fleet-auth/session/refresh') {
        refreshCalls += 1;
        if (refreshCalls === 1) {
          // A sibling tab completed the single-use rotation first. The shared
          // browser cookie already carries its valid successor by the time this
          // tab receives the stale-session response.
          return new Response(JSON.stringify({
            error: { type: 'invalid_session', message: 'Session is invalid or expired' },
          }), { status: 401, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({
          csrfToken: 'd'.repeat(43),
          principalStatus: 'active',
          idleExpiresAt: '2026-08-03T12:40:00.000Z',
          absoluteExpiresAt: '2026-08-03T20:00:00.000Z',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const auth = await loadAuthStore(fetchImpl as typeof fetch, {
      pathname: `/companions/${COMPANION_ID}/garden`,
      documentRef,
    });

    auth.startServerSessionRefresh();
    await expect(auth.ensureAuthResolved()).resolves.toBe(true);
    await vi.waitFor(() => expect(refreshCalls).toBe(2));

    expect(dashboardCalls).toBe(1);
    expect(statusCalls).toBe(1);
    expect(csrfCalls).toBe(2);
    expect(auth.isAuthenticated()).toBe(true);
    expect(window.location.href).toBe('');

    auth.stopServerSessionRefresh();
  });

  it('queues the dashboard auth probe behind a sibling session rotation', async () => {
    let resolveRefresh = (_response: Response) => {};
    const refreshPending = new Promise<Response>((resolve) => { resolveRefresh = resolve; });
    let dashboardCalls = 0;
    const fetchImpl = vi.fn((input: string | URL | Request): Promise<Response> => {
      const path = String(input);
      if (path === '/v1/fleet-auth/session/csrf') {
        return Promise.resolve(new Response(JSON.stringify({ csrfToken: CSRF_TOKEN }), {
          status: 200,
        }));
      }
      if (path === '/v1/fleet-auth/session/refresh') return refreshPending;
      if (path.endsWith('/api/admin/dashboard')) {
        dashboardCalls += 1;
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const auth = await loadAuthStore(fetchImpl as typeof fetch, {
      pathname: `/companions/${COMPANION_ID}/garden`,
    });
    const { refreshFleetSession } = await import('$lib/api/fleet-session');

    const refresh = refreshFleetSession();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    const probe = auth.ensureAuthResolved();
    await flushAsyncWork();
    expect(dashboardCalls).toBe(0);

    resolveRefresh(new Response(JSON.stringify({
      principalStatus: 'active',
      idleExpiresAt: '2026-08-03T12:40:00.000Z',
      absoluteExpiresAt: '2026-08-03T20:00:00.000Z',
    }), { status: 200 }));

    await expect(refresh).resolves.toMatchObject({ principalStatus: 'active' });
    await expect(probe).resolves.toBe(true);
    expect(dashboardCalls).toBe(1);
  });

  it('revalidates a server-reported absolute expiry before signing out', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T12:00:00.000Z'));
    const documentRef = new FakeVisibilityDocument();
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      if (path.endsWith('/api/admin/dashboard')) return new Response('{}', { status: 200 });
      if (path === '/v1/fleet-auth/session/csrf') {
        return new Response(JSON.stringify({ csrfToken: CSRF_TOKEN }), { status: 200 });
      }
      if (path === '/v1/fleet-auth/session/refresh') {
        return new Response(JSON.stringify({
          csrfToken: 'd'.repeat(43),
          principalStatus: 'active',
          idleExpiresAt: '2026-08-03T13:00:00.000Z',
          absoluteExpiresAt: '2026-08-03T13:00:00.000Z',
        }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const auth = await loadAuthStore(fetchImpl as typeof fetch, {
      pathname: `/companions/${COMPANION_ID}/garden`,
      documentRef,
    });

    auth.startServerSessionRefresh();
    await auth.ensureAuthResolved();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));

    documentRef.setHidden(true);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    documentRef.setHidden(false);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(5));

    expect(auth.isAuthenticated()).toBe(false);

    auth.stopServerSessionRefresh();
  });

  it.each([403, 503])(
    'retries a non-auth refresh failure (%i) from the remaining server idle window without a tight loop',
    async (failureStatus) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-03T12:00:00.000Z'));
      const documentRef = new FakeVisibilityDocument();
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      let csrfCalls = 0;
      const fetchImpl = vi.fn(async (input: string | URL | Request) => {
        const path = String(input);
        if (path.endsWith('/api/admin/dashboard')) return new Response('{}', { status: 200 });
        if (path === '/v1/fleet-auth/session/csrf') {
          csrfCalls += 1;
          if (csrfCalls === 2) {
            return new Response('refresh unavailable', { status: failureStatus });
          }
          return new Response(JSON.stringify({ csrfToken: CSRF_TOKEN }), { status: 200 });
        }
        if (path === '/v1/fleet-auth/session/refresh') {
          return new Response(JSON.stringify({
            csrfToken: 'd'.repeat(43),
            principalStatus: 'active',
            idleExpiresAt: new Date(Date.now() + 40 * 60_000).toISOString(),
            absoluteExpiresAt: '2026-08-03T20:00:00.000Z',
          }), { status: 200 });
        }
        throw new Error(`Unexpected request: ${path}`);
      });
      const auth = await loadAuthStore(fetchImpl as typeof fetch, {
        pathname: `/companions/${COMPANION_ID}/garden`,
        documentRef,
      });

      auth.startServerSessionRefresh();
      await auth.ensureAuthResolved();
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));

      await vi.advanceTimersByTimeAsync(20 * 60_000);
      await flushAsyncWork();
      expect(fetchImpl).toHaveBeenCalledTimes(4);
      expect(auth.isAuthenticated()).toBe(true);
      expect(window.location.href).toBe('');

      await vi.advanceTimersByTimeAsync(9 * 60_000);
      expect(fetchImpl).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(6));
      expect(consoleWarn).toHaveBeenCalledTimes(1);

      auth.stopServerSessionRefresh();
    },
  );

  it('keeps a valid HttpOnly cookie session after the authenticated probe succeeds', async () => {
    const auth = await loadAuthStore(async () => new Response('{}', { status: 200 }));

    await expect(auth.ensureAuthResolved()).resolves.toBe(true);

    expect(auth.isAuthResolved()).toBe(true);
    expect(auth.isAuthenticated()).toBe(true);
    expect(shouldRedirectToLogin(auth)).toBe(false);
    expect(fetch).toHaveBeenCalledWith('/api/admin/dashboard', expect.objectContaining({
      credentials: 'include',
    }));
  });

  it.each([401, 403])('redirects after a definitive %i auth denial', async (status) => {
    const auth = await loadAuthStore(async () => new Response('{}', { status }));

    await expect(auth.ensureAuthResolved()).resolves.toBe(false);

    expect(auth.isAuthResolved()).toBe(true);
    expect(auth.isAuthenticated()).toBe(false);
    expect(shouldRedirectToLogin(auth)).toBe(true);
  });

  it('lets the valid-cookie probe survive initialization of its matching scope', async () => {
    let markProbeStarted = () => {};
    let resolveProbe = (_response: Response) => {};
    const probeStarted = new Promise<void>((resolve) => {
      markProbeStarted = resolve;
    });
    const auth = await loadAuthStore((_input, init) => new Promise<Response>(
      (resolve, reject) => {
        resolveProbe = resolve;
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('scope initialized', 'AbortError'));
        });
        markProbeStarted();
      },
    ));
    const { activateCompanionScope } = await import('$lib/fleet/companion-scope');

    const authResult = auth.ensureAuthResolved();
    await probeStarted;
    await activateCompanionScope(null);
    resolveProbe(new Response('{}', { status: 200 }));

    await expect(authResult).resolves.toBe(true);

    expect(auth.isAuthResolved()).toBe(true);
    expect(auth.isAuthenticated()).toBe(true);
    expect(shouldRedirectToLogin(auth)).toBe(false);
  });

  it('re-probes after client-side Garden to fleet navigation clears companion scope', async () => {
    const location = {
      pathname: `/companions/${COMPANION_ID}/garden`,
      href: '',
    };
    let dashboardCalls = 0;
    let statusCalls = 0;
    const auth = await loadAuthStore(async (input) => {
      const path = String(input);
      if (path.endsWith('/api/admin/dashboard')) {
        dashboardCalls += 1;
        return new Response('{}', { status: 200 });
      }
      if (path === '/v1/fleet/portal') {
        statusCalls += 1;
        return new Response(JSON.stringify({ schemaVersion: 2 }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${path}`);
    }, { pathname: location.pathname });
    Object.assign(window.location, location);
    const { activateCompanionScope } = await import('$lib/fleet/companion-scope');
    await activateCompanionScope(COMPANION_ID);
    await expect(auth.ensureAuthResolved()).resolves.toBe(true);

    window.location.pathname = '/fleet';
    await auth.activateSessionScopeFromPath('/fleet');

    expect(dashboardCalls).toBe(1);
    expect(statusCalls).toBe(1);
    expect(auth.isAuthResolved()).toBe(true);
    expect(auth.isAuthenticated()).toBe(true);
  });

  it('does not turn a canceled probe with a raced 401 into an auth denial', async () => {
    let markProbeStarted = () => {};
    let resolveProbe = (_response: Response) => {};
    const probeStarted = new Promise<void>((resolve) => { markProbeStarted = resolve; });
    const auth = await loadAuthStore(() => new Promise<Response>((resolve) => {
      resolveProbe = resolve;
      markProbeStarted();
    }));
    const { activateCompanionScope } = await import('$lib/fleet/companion-scope');

    const authResult = auth.ensureAuthResolved();
    await probeStarted;
    await activateCompanionScope('11111111-1111-4111-8111-111111111111');
    resolveProbe(new Response('{}', { status: 401 }));

    await expect(authResult).resolves.toBe(false);
    expect(auth.isAuthResolved()).toBe(false);
    expect(auth.isAuthenticated()).toBe(false);
    expect(shouldRedirectToLogin(auth)).toBe(false);
  });

  it('does not turn a transient server failure into an auth denial', async () => {
    const auth = await loadAuthStore(async () => new Response('{}', { status: 503 }));

    await expect(auth.ensureAuthResolved()).resolves.toBe(false);

    expect(auth.isAuthResolved()).toBe(false);
    expect(auth.isAuthenticated()).toBe(false);
    expect(shouldRedirectToLogin(auth)).toBe(false);
  });

  it('reports a failed probe without turning it into an auth denial', async () => {
    const networkError = new TypeError('network unavailable');
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const auth = await loadAuthStore(async () => {
      throw networkError;
    });

    await expect(auth.ensureAuthResolved()).resolves.toBe(false);

    expect(auth.isAuthResolved()).toBe(false);
    expect(auth.isAuthenticated()).toBe(false);
    expect(shouldRedirectToLogin(auth)).toBe(false);
    expect(consoleWarn).toHaveBeenCalledWith(
      'Garden admin session probe failed; authentication remains unresolved.',
      networkError,
    );
  });
});
