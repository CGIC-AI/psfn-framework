import { apiGet, apiPatch, apiPost, apiPostForm } from '$lib/api/client';
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

export function getSubConfig(key: string): Promise<string> {
  return apiGet<string>(`/api/settings/${encodeURIComponent(key)}`);
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
