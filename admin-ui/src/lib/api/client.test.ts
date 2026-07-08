import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiGet, apiPostForm } from './client';

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('admin api client errors', () => {
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
    const windowRef = { location: { href: '' } };
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
