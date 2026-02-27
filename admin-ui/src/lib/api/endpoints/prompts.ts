import { apiGet, apiPatch, apiPost } from '../client';
import type { AdminPromptListData, AdminPromptDetailData } from '$lib/types';

export function listPrompts(): Promise<AdminPromptListData> {
  return apiGet('/api/admin/prompts');
}

export function getPrompt(layerId: string): Promise<AdminPromptDetailData> {
  return apiGet(`/api/admin/prompts/${encodeURIComponent(layerId)}`);
}

export function updatePrompt(layerId: string, patch: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
  return apiPatch(`/api/admin/prompts/${encodeURIComponent(layerId)}`, { layerId, ...patch });
}

export function togglePrompt(layerId: string): Promise<{ ok: boolean; message: string }> {
  return apiPost(`/api/admin/prompts/${encodeURIComponent(layerId)}/toggle`);
}

export function rollbackPrompt(layerId: string, version: number): Promise<{ ok: boolean; message: string }> {
  return apiPost(`/api/admin/prompts/${encodeURIComponent(layerId)}/rollback`, { version });
}

export function diffPrompt(layerId: string): Promise<{ oldContent: string; newContent: string }> {
  return apiGet(`/api/admin/prompts/${encodeURIComponent(layerId)}/diff`);
}
