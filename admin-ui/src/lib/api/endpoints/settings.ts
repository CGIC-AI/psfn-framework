import { apiGet, apiPatch, apiPostForm } from '../client';
import type { AdminSettingsData, DiscoveredModel } from '$lib/types';

export function getSettings(): Promise<AdminSettingsData> {
  return apiGet('/api/admin/settings');
}

export async function updateSettings(patch: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
  return apiPatch('/api/admin/settings', patch);
}

async function saveSubConfig(endpoint: string, config: unknown): Promise<void> {
  const params = new URLSearchParams();
  params.set('configJson', JSON.stringify(config, null, 2));
  await apiPostForm(endpoint, params);
}

export function getModelsConfig(): Promise<unknown> {
  return apiGet('/api/settings/models');
}
export function saveModelsConfig(config: unknown): Promise<void> {
  return saveSubConfig('/api/settings/models', config);
}

export function getSkillsConfig(): Promise<unknown> {
  return apiGet('/api/settings/skills');
}
export function saveSkillsConfig(config: unknown): Promise<void> {
  return saveSubConfig('/api/settings/skills', config);
}

export function getSchedulerConfig(): Promise<unknown> {
  return apiGet('/api/settings/scheduler');
}
export function saveSchedulerConfig(config: unknown): Promise<void> {
  return saveSubConfig('/api/settings/scheduler', config);
}

export function getTrustPolicyConfig(): Promise<unknown> {
  return apiGet('/api/settings/trust-policy');
}
export function saveTrustPolicyConfig(config: unknown): Promise<void> {
  return saveSubConfig('/api/settings/trust-policy', config);
}

export function getCapabilitiesConfig(): Promise<unknown> {
  return apiGet('/api/settings/capabilities');
}
export function saveCapabilitiesConfig(config: unknown): Promise<void> {
  return saveSubConfig('/api/settings/capabilities', config);
}

export function listModels(): Promise<DiscoveredModel[]> {
  return apiGet('/api/models');
}
export function refreshModels(): Promise<DiscoveredModel[]> {
  return apiGet('/api/models/refresh');
}
