import { ApiError, apiGet, apiPost, apiPostForm } from '$lib/api/client';
import { getToken } from '$lib/stores/auth.svelte';
import type {
  AdminSettingsData,
  ConfigUpdateResult,
  DiscoveredModel,
} from '$lib/types';

export function getSettings(): Promise<AdminSettingsData> {
  return apiGet<AdminSettingsData>('/api/admin/settings');
}

export function updateSettings(
  patch: Record<string, unknown>
): Promise<ConfigUpdateResult> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  return fetch('/api/admin/settings', {
    method: 'PATCH',
    headers,
    credentials: 'include',
    body: JSON.stringify(patch),
  }).then(async (res) => {
    if (res.status === 401) {
      window.location.href = '/garden/login';
      throw new ApiError(401, 'Unauthorized');
    }

    const raw = await res.text();
    let parsed: Record<string, unknown> = {};
    if (raw.trim().length > 0) {
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        if (!res.ok) throw new ApiError(res.status, res.statusText, raw);
      }
    }

    const validationErrors = Array.isArray(parsed.validationErrors)
      ? parsed.validationErrors
          .filter((entry): entry is { field: string; message: string; code?: string } => (
            typeof entry === 'object'
            && entry !== null
            && typeof (entry as Record<string, unknown>).field === 'string'
            && typeof (entry as Record<string, unknown>).message === 'string'
          ))
          .map(entry => ({
            field: entry.field,
            message: entry.message,
            ...(typeof entry.code === 'string' ? { code: entry.code } : {}),
          }))
      : undefined;

    if (res.ok) {
      return {
        ok: typeof parsed.ok === 'boolean' ? parsed.ok : true,
        message: typeof parsed.message === 'string' ? parsed.message : 'Settings updated',
        ...(validationErrors ? { validationErrors } : {}),
      };
    }

    if (res.status === 400) {
      const message = typeof parsed.message === 'string'
        ? parsed.message
        : (typeof parsed.error === 'string' ? parsed.error : 'Settings update failed');
      return {
        ok: false,
        message,
        ...(validationErrors ? { validationErrors } : {}),
      };
    }

    throw new ApiError(res.status, res.statusText, raw || undefined);
  });
}

/** Fetch sub-config as raw JSON text (not parsed). Server returns JSON with text/json content type. */
export async function getSubConfig(key: string): Promise<string> {
  const token = getToken();
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`/api/settings/${encodeURIComponent(key)}`, {
    headers,
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

export function saveSubConfig(key: string, json: string): Promise<string> {
  const params = new URLSearchParams();
  params.set('configJson', json);
  return apiPostForm(`/api/settings/${encodeURIComponent(key)}`, params);
}

export function listModels(): Promise<DiscoveredModel[]> {
  return apiGet<DiscoveredModel[]>('/api/models');
}

export function refreshModels(): Promise<void> {
  return apiPost<void>('/api/models/refresh');
}
