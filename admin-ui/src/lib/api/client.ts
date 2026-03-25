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

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(API_BASE + path, {
    cache: 'no-store',
    headers: { ...authHeaders(), Accept: 'application/json' },
    credentials: 'include',
  });
  if (res.status === 401) {
    window.location.href = '/login';
    throw new ApiError(401, 'Unauthorized');
  }
  if (!res.ok) throw new ApiError(res.status, res.statusText);
  return res.json();
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(API_BASE + path, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    credentials: 'include',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    window.location.href = '/login';
    throw new ApiError(401, 'Unauthorized');
  }
  if (!res.ok) throw new ApiError(res.status, res.statusText);
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
  if (res.status === 401) {
    window.location.href = '/login';
    throw new ApiError(401, 'Unauthorized');
  }
  if (!res.ok) throw new ApiError(res.status, res.statusText);
  return res.json();
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(API_BASE + path, {
    method: 'PATCH',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    window.location.href = '/login';
    throw new ApiError(401, 'Unauthorized');
  }
  if (!res.ok) throw new ApiError(res.status, res.statusText);
  return res.json();
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(API_BASE + path, {
    method: 'PUT',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    window.location.href = '/login';
    throw new ApiError(401, 'Unauthorized');
  }
  if (!res.ok) throw new ApiError(res.status, res.statusText);
  return res.json();
}

export async function apiDelete<T>(path: string): Promise<T> {
  const res = await fetch(API_BASE + path, {
    method: 'DELETE',
    headers: authHeaders(),
    credentials: 'include',
  });
  if (res.status === 401) {
    window.location.href = '/login';
    throw new ApiError(401, 'Unauthorized');
  }
  if (!res.ok) throw new ApiError(res.status, res.statusText);
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
  if (!res.ok)
    throw new ApiError(
      res.status,
      res.statusText,
      await res.text().catch(() => undefined)
    );
  return res.text();
}
