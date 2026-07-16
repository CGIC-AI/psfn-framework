import { getToken } from '$lib/stores/auth.svelte';
import { ApiError } from './errors';

export { ApiError } from './errors';

const API_BASE = '';  // Relative — Vite proxy handles /api/*

function authHeaders(): Record<string, string> {
  const token = getToken();
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

function redirectToLogin(): void {
  if (typeof window !== 'undefined') {
    window.location.href = '/login';
  }
}

function extractJsonErrorMessage(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.error === 'string' && record.error.trim()) {
    return record.error.trim();
  }
  if (record.error && typeof record.error === 'object') {
    const error = record.error as Record<string, unknown>;
    if (typeof error.message === 'string' && error.message.trim()) {
      return error.message.trim();
    }
  }
  if (typeof record.message === 'string' && record.message.trim()) {
    return record.message.trim();
  }
  return null;
}

async function parseErrorResponse(res: Response): Promise<{ message: string; body?: string }> {
  const rawBody = await res.text().catch(() => '');
  const body = rawBody.trim() ? rawBody : undefined;
  if (!body) {
    return { message: res.statusText || `HTTP ${res.status}` };
  }

  const contentType = res.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType.includes('application/json') || body.startsWith('{') || body.startsWith('[')) {
    try {
      const parsed = JSON.parse(body) as unknown;
      const message = extractJsonErrorMessage(parsed);
      if (message) return { message, body };
    } catch {
      // Fall through to surfacing the raw body text.
    }
  }
  return { message: body, body };
}

async function throwIfNotOk(res: Response): Promise<void> {
  if (res.status === 401) {
    redirectToLogin();
    throw new ApiError(401, 'Unauthorized');
  }
  if (res.ok) return;
  const parsed = await parseErrorResponse(res);
  throw new ApiError(res.status, parsed.message, parsed.body);
}

export async function apiGet<T>(path: string): Promise<T> {
  // `no-cache` (not `no-store`) lets the browser revalidate against its HTTP
  // cache via If-None-Match. When the server answers 304 the browser
  // transparently serves the cached body, so polled reads skip re-downloading
  // byte-identical payloads over the WAN while still always seeing fresh data.
  const res = await fetch(API_BASE + path, {
    cache: 'no-cache',
    headers: { ...authHeaders(), Accept: 'application/json' },
    credentials: 'include',
  });
  await throwIfNotOk(res);
  return res.json();
}

export type ApiConditionalGetResult =
  | { kind: 'not_modified'; etag: string | null }
  | { kind: 'data'; data: unknown; etag: string | null };

/**
 * Explicit conditional read for IndexedDB-owned local-first resources. The
 * response body stays out of the browser HTTP cache so there is one durable
 * client authority, while the server's existing ETag still avoids unchanged
 * payload transfer.
 */
export async function apiGetConditional(
  path: string,
  etag?: string,
): Promise<ApiConditionalGetResult> {
  const headers: Record<string, string> = { ...authHeaders(), Accept: 'application/json' };
  if (etag !== undefined) headers['If-None-Match'] = etag;
  const res = await fetch(API_BASE + path, {
    cache: 'no-store',
    headers,
    credentials: 'include',
  });
  if (res.status === 304) {
    return { kind: 'not_modified', etag: res.headers.get('etag') };
  }
  await throwIfNotOk(res);
  const data: unknown = await res.json();
  return { kind: 'data', data, etag: res.headers.get('etag') };
}

export interface ApiDownload {
  blob: Blob;
  filename: string | null;
}

export async function apiDownload(path: string): Promise<ApiDownload> {
  const res = await fetch(API_BASE + path, {
    cache: 'no-store',
    headers: authHeaders(),
    credentials: 'include',
  });
  await throwIfNotOk(res);
  const disposition = res.headers.get('content-disposition') ?? '';
  const encodedFilename = disposition.match(/filename\*=UTF-8''([^;]+)/iu)?.[1];
  const plainFilename = disposition.match(/filename="?([^";]+)"?/iu)?.[1];
  let filename: string | null = plainFilename?.trim() || null;
  if (encodedFilename) {
    try {
      filename = decodeURIComponent(encodedFilename.trim());
    } catch {
      filename = encodedFilename.trim();
    }
  }
  return { blob: await res.blob(), filename };
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(API_BASE + path, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    credentials: 'include',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  await throwIfNotOk(res);
  return res.json();
}

export async function apiPostMultipart<T>(
  path: string,
  formData: FormData
): Promise<T> {
  const res = await fetch(API_BASE + path, {
    method: 'POST',
    headers: authHeaders(),
    credentials: 'include',
    body: formData,
  });
  await throwIfNotOk(res);
  return res.json();
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(API_BASE + path, {
    method: 'PATCH',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  await throwIfNotOk(res);
  return res.json();
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(API_BASE + path, {
    method: 'PUT',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  await throwIfNotOk(res);
  return res.json();
}

export async function apiDelete<T>(path: string): Promise<T> {
  const res = await fetch(API_BASE + path, {
    method: 'DELETE',
    headers: authHeaders(),
    credentials: 'include',
  });
  await throwIfNotOk(res);
  return res.json();
}

export async function apiPostForm(
  path: string,
  params: URLSearchParams
): Promise<string> {
  const res = await fetch(API_BASE + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...authHeaders(),
    },
    credentials: 'include',
    body: params.toString(),
  });
  await throwIfNotOk(res);
  return res.text();
}
