import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiGet, apiGetConditional, apiPostForm } from './client';
import { isAbortError } from './abort';
import { activateCompanionScope } from '$lib/fleet/companion-scope';

const COMPANION_A = '11111111-1111-4111-8111-111111111111';
const COMPANION_B = '22222222-2222-4222-8222-222222222222';

function mockFetch(response: Response): void {
  vi.stubGlobal('fetch', vi.fn(async () => response));
}

async function expectApiError(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error('Expected ApiError');
}

afterEach(async () => {
  await activateCompanionScope(null);
  vi.unstubAllGlobals();
});

describe('admin api client errors', () => {
  it('uses browser conditional revalidation for GET requests', async () => {
    mockFetch(new Response(JSON.stringify({ channels: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    await expect(apiGet('/api/admin/sessions')).resolves.toEqual({ channels: [] });

    expect(fetch).toHaveBeenCalledWith('/api/admin/sessions', expect.objectContaining({
      cache: 'no-cache',
      credentials: 'include',
    }));
  });

  it('derives the immutable request target from the canonical companion route', async () => {
    vi.stubGlobal('window', {
      location: {
        pathname: `/companions/${COMPANION_A}/garden/sessions`,
        href: '',
      },
    });
    mockFetch(new Response(JSON.stringify({ sessions: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    await apiGet('/api/admin/sessions');

    expect(fetch).toHaveBeenCalledWith(
      `/companions/${COMPANION_A}/garden/api/admin/sessions`,
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('aborts an in-flight companion request when the active scope switches', async () => {
    const location = {
      pathname: `/companions/${COMPANION_A}/garden/sessions`,
      href: '',
    };
    vi.stubGlobal('window', { location });
    await activateCompanionScope(COMPANION_A);
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>(
      (_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      },
    )));

    const request = apiGet('/api/admin/sessions');
    location.pathname = `/companions/${COMPANION_B}/garden/sessions`;
    await activateCompanionScope(COMPANION_B);

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('keeps an incoming companion request alive while its scope activates', async () => {
    const location = {
      pathname: `/companions/${COMPANION_B}/garden`,
      href: '',
    };
    vi.stubGlobal('window', { location });
    let resolveRequest = (_response: Response) => {};
    let requestSignal: AbortSignal | null = null;
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>(
      (resolve) => {
        resolveRequest = resolve;
        requestSignal = init?.signal ?? null;
      },
    )));

    const request = apiGet('/api/admin/dashboard?costWindow=today');
    await activateCompanionScope(COMPANION_B);
    resolveRequest(new Response(JSON.stringify({ companion: COMPANION_B }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    await expect(request).resolves.toEqual({ companion: COMPANION_B });
    expect(requestSignal?.aborted).toBe(false);
  });

  it('classifies an aborted raced response before its 401 can redirect', async () => {
    const location = {
      pathname: `/companions/${COMPANION_A}/garden`,
      href: '',
    };
    vi.stubGlobal('window', { location });
    await activateCompanionScope(COMPANION_A);
    let resolveRequest = (_response: Response) => {};
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    })));

    const request = apiGet('/api/admin/dashboard');
    await activateCompanionScope(COMPANION_B);
    resolveRequest(new Response('{}', { status: 401 }));

    const error = await request.catch((reason: unknown) => reason);
    expect(isAbortError(error)).toBe(true);
    expect(location.href).toBe('');
  });

  it('canonicalizes a nonstandard fetch rejection from an aborted outgoing scope', async () => {
    const location = {
      pathname: `/companions/${COMPANION_A}/garden`,
      href: '',
    };
    vi.stubGlobal('window', { location });
    await activateCompanionScope(COMPANION_A);
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>(
      (_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('signal aborted without reason', 'NetworkError'));
        });
      },
    )));

    const request = apiGet('/api/admin/dashboard');
    await activateCompanionScope(COMPANION_B);

    const error = await request.catch((reason: unknown) => reason);
    expect(isAbortError(error)).toBe(true);
    expect(location.href).toBe('');
  });

  it('sends an explicit ETag and surfaces an unchanged conditional response', async () => {
    mockFetch(new Response(null, {
      status: 304,
      headers: { etag: '"sessions-v1"' },
    }));

    await expect(apiGetConditional('/api/admin/sessions', '"sessions-v1"')).resolves.toEqual({
      kind: 'not_modified',
      etag: '"sessions-v1"',
    });
    expect(fetch).toHaveBeenCalledWith('/api/admin/sessions', expect.objectContaining({
      cache: 'no-store',
      credentials: 'include',
      headers: expect.objectContaining({ 'If-None-Match': '"sessions-v1"' }),
    }));
  });

  it('preserves JSON error envelopes in ApiError', async () => {
    mockFetch(new Response(JSON.stringify({
      error: {
        message: 'Retention class is invalid',
        type: 'invalid_request',
      },
    }), {
      status: 400,
      statusText: 'Bad Request',
      headers: { 'content-type': 'application/json' },
    }));

    const error = await expectApiError(apiGet('/api/admin/memory'));

    expect(error.status).toBe(400);
    expect(error.statusText).toBe('Retention class is invalid');
    expect(error.body).toBe('{"error":{"message":"Retention class is invalid","type":"invalid_request"}}');
    expect(error.message).toBe('400 Retention class is invalid');
  });

  it('preserves plain string JSON error envelopes', async () => {
    mockFetch(new Response(JSON.stringify({ error: 'Denied by policy' }), {
      status: 403,
      statusText: 'Forbidden',
      headers: { 'content-type': 'application/json' },
    }));

    const error = await expectApiError(apiGet('/api/admin/settings'));

    expect(error.status).toBe(403);
    expect(error.statusText).toBe('Denied by policy');
    expect(error.body).toBe('{"error":"Denied by policy"}');
  });

  it('preserves text error bodies', async () => {
    mockFetch(new Response('upstream unavailable', {
      status: 502,
      statusText: 'Bad Gateway',
      headers: { 'content-type': 'text/plain' },
    }));

    const error = await expectApiError(apiPostForm('/api/admin/upload', new URLSearchParams()));

    expect(error.status).toBe(502);
    expect(error.statusText).toBe('upstream unavailable');
    expect(error.body).toBe('upstream unavailable');
  });

  it('falls back to status text for empty error bodies', async () => {
    mockFetch(new Response('', {
      status: 500,
      statusText: 'Internal Server Error',
    }));

    const error = await expectApiError(apiGet('/api/admin/dashboard'));

    expect(error.status).toBe(500);
    expect(error.statusText).toBe('Internal Server Error');
    expect(error.body).toBeUndefined();
  });

  it('preserves 401 login redirect behavior', async () => {
    const windowRef = { location: { href: '', pathname: '/' } };
    vi.stubGlobal('window', windowRef);
    mockFetch(new Response(JSON.stringify({ error: 'session expired' }), {
      status: 401,
      statusText: 'Unauthorized',
      headers: { 'content-type': 'application/json' },
    }));

    const error = await expectApiError(apiGet('/api/admin/dashboard'));

    expect(windowRef.location.href).toBe('/login');
    expect(error.status).toBe(401);
    expect(error.statusText).toBe('Unauthorized');
    expect(error.body).toBeUndefined();
  });
});
