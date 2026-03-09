import { ApiError, apiGet, apiPost, apiPostForm } from '$lib/api/client';
import { getToken } from '$lib/stores/auth.svelte';
import type { DiscoveredModel } from '$lib/types';

export async function getModelsConfigRaw(): Promise<string> {
  const token = getToken();
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch('/api/admin/settings/models', {
    headers,
    credentials: 'include',
  });
  if (res.status === 401) {
    window.location.href = '/garden/login';
    throw new ApiError(401, 'Unauthorized');
  }
  if (!res.ok) {
    throw new ApiError(res.status, res.statusText, await res.text().catch(() => undefined));
  }
  return res.text();
}

export function saveModelsConfigRaw(json: string): Promise<string> {
  const params = new URLSearchParams();
  params.set('configJson', json);
  return apiPostForm('/api/admin/settings/models', params);
}

export function listDiscoveredModels(): Promise<DiscoveredModel[]> {
  return apiGet<DiscoveredModel[]>('/api/admin/models');
}

export function refreshDiscoveredModels(): Promise<void> {
  return apiPost<void>('/api/admin/models/refresh');
}
