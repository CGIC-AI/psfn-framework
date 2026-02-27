import { apiGet, apiPatch, apiPost } from '../client';
import type { AdminSettingsData, DiscoveredModel } from '$lib/types';

export function getSettings(): Promise<AdminSettingsData> {
  return apiGet('/api/admin/settings');
}

export function updateSettings(patch: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
  return apiPatch('/api/admin/settings', patch);
}

export function getModelsConfig(): Promise<unknown> {
  return apiGet('/api/admin/settings/models');
}

export function updateModelsConfig(config: unknown): Promise<{ ok: boolean; message: string }> {
  return apiPost('/api/admin/settings/models', config);
}

export function getSkillsConfig(): Promise<unknown> {
  return apiGet('/api/admin/settings/skills');
}

export function updateSkillsConfig(config: unknown): Promise<{ ok: boolean; message: string }> {
  return apiPost('/api/admin/settings/skills', config);
}

export function getSchedulerConfig(): Promise<unknown> {
  return apiGet('/api/admin/settings/scheduler');
}

export function updateSchedulerConfig(config: unknown): Promise<{ ok: boolean; message: string }> {
  return apiPost('/api/admin/settings/scheduler', config);
}

export function getTrustPolicyConfig(): Promise<unknown> {
  return apiGet('/api/admin/settings/trust-policy');
}

export function updateTrustPolicyConfig(config: unknown): Promise<{ ok: boolean; message: string }> {
  return apiPost('/api/admin/settings/trust-policy', config);
}

export function getCapabilitiesConfig(): Promise<unknown> {
  return apiGet('/api/admin/settings/capabilities');
}

export function updateCapabilitiesConfig(config: unknown): Promise<{ ok: boolean; message: string }> {
  return apiPost('/api/admin/settings/capabilities', config);
}

export function listModels(): Promise<DiscoveredModel[]> {
  return apiGet('/api/models');
}

export function refreshModels(): Promise<DiscoveredModel[]> {
  return apiPost('/api/models/refresh');
}
