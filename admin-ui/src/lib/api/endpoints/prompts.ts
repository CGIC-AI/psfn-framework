import { apiGet, apiPatch, apiPost } from '$lib/api/client';
import type { AdminPromptListData, PromptUpdateResult } from '$lib/types';

export function listPrompts(): Promise<AdminPromptListData> {
  return apiGet<AdminPromptListData>('/api/admin/prompts');
}

export function getPromptDetail(
  id: string
): Promise<{ layer: unknown; history: unknown[] }> {
  return apiGet<{ layer: unknown; history: unknown[] }>(
    `/api/admin/prompts/${encodeURIComponent(id)}`
  );
}

export function updatePrompt(
  id: string,
  patch: Record<string, unknown>
): Promise<PromptUpdateResult> {
  return apiPatch<PromptUpdateResult>(
    `/api/admin/prompts/${encodeURIComponent(id)}`,
    patch
  );
}

export function togglePrompt(
  id: string
): Promise<PromptUpdateResult> {
  return apiPost<PromptUpdateResult>(
    `/api/admin/prompts/${encodeURIComponent(id)}/toggle`
  );
}

export function rollbackPrompt(
  id: string,
  body?: Record<string, unknown>
): Promise<PromptUpdateResult> {
  return apiPost<PromptUpdateResult>(
    `/api/admin/prompts/${encodeURIComponent(id)}/rollback`,
    body
  );
}

export function getPromptDiff(
  id: string
): Promise<{ diff: string }> {
  return apiGet<{ diff: string }>(
    `/api/admin/prompts/${encodeURIComponent(id)}/diff`
  );
}
