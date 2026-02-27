// ── Base API client with auth + error handling ──

import { getToken } from '$lib/stores/auth.svelte';

const DEFAULT_BASE = '';  // Same origin in production; Vite proxy in dev

export class ApiError extends Error {
  constructor(
    public status: number,
    public statusText: string,
    public body?: unknown,
  ) {
    super(`API ${status}: ${statusText}`);
    this.name = 'ApiError';
  }
}

function baseUrl(): string {
  return DEFAULT_BASE;
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

export async function apiGet<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(path, window.location.origin);
  url.pathname = baseUrl() + path;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url.toString(), {
    headers: { Accept: 'application/json', ...authHeaders() },
    credentials: 'include',
  });

  if (!res.ok) {
    const body = await res.text().catch(() => undefined);
    throw new ApiError(res.status, res.statusText, body);
  }

  return res.json() as Promise<T>;
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(baseUrl() + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...authHeaders(),
    },
    credentials: 'include',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => undefined);
    throw new ApiError(res.status, res.statusText, text);
  }

  return res.json() as Promise<T>;
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(baseUrl() + path, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...authHeaders(),
    },
    credentials: 'include',
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => undefined);
    throw new ApiError(res.status, res.statusText, text);
  }

  return res.json() as Promise<T>;
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(baseUrl() + path, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...authHeaders(),
    },
    credentials: 'include',
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => undefined);
    throw new ApiError(res.status, res.statusText, text);
  }

  return res.json() as Promise<T>;
}

export async function apiDelete<T = { ok: boolean }>(path: string): Promise<T> {
  const res = await fetch(baseUrl() + path, {
    method: 'DELETE',
    headers: { Accept: 'application/json', ...authHeaders() },
    credentials: 'include',
  });

  if (!res.ok) {
    const text = await res.text().catch(() => undefined);
    throw new ApiError(res.status, res.statusText, text);
  }

  return res.json() as Promise<T>;
}
