import { apiGet, apiPatch, apiPost, apiPostForm } from '$lib/api/client';
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
  return apiPatch<ConfigUpdateResult>('/api/admin/settings', patch);
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
