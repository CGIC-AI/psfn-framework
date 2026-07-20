import { afterEach, describe, expect, it, vi } from 'vitest';

type AuthStore = typeof import('./auth.svelte');

function shouldRedirectToLogin(auth: AuthStore): boolean {
  return auth.isAuthResolved() && !auth.isAuthenticated();
}

async function loadAuthStore(fetchImpl: typeof fetch): Promise<AuthStore> {
  vi.resetModules();
  vi.stubGlobal('window', {
    location: { pathname: '/' },
    localStorage: { removeItem: vi.fn() },
  });
  vi.stubGlobal('fetch', vi.fn(fetchImpl));
  return import('./auth.svelte');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Garden admin session auth guard', () => {
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

  it('does not turn a canceled probe with a raced 401 into an auth denial', async () => {
    let resolveProbe = (_response: Response) => {};
    const auth = await loadAuthStore(() => new Promise<Response>((resolve) => {
      resolveProbe = resolve;
    }));
    const { activateCompanionScope } = await import('$lib/fleet/companion-scope');

    const authResult = auth.ensureAuthResolved();
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
