import { apiGet, apiPatch, apiPost } from '$lib/api/client';
import type {
  AdminPromptListData,
  AdminPromptDetailData,
  PromptUpdateResult,
  PromptDiffResult,
} from '$lib/types';

export interface PromptCreateParams {
  type: 'runtime' | 'channel' | 'task';
  name: string;
  content: string;
  channelType?: string;
  taskKind?: string;
  priority?: number;
  identifier?: string;
  role?: string;
  promptOrder?: number;
}

export function listPrompts(): Promise<AdminPromptListData> {
  return apiGet<AdminPromptListData>('/api/admin/prompts');
}

export function getPromptDetail(
  id: string
): Promise<AdminPromptDetailData> {
  return apiGet<AdminPromptDetailData>(
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
): Promise<PromptDiffResult> {
  return apiGet<PromptDiffResult>(
    `/api/admin/prompts/${encodeURIComponent(id)}/diff`
  );
}

/**
 * Create a new prompt layer.
 * Endpoint: POST /api/admin/prompts
 *
 * Only runtime, channel, and task layers can be created via the admin API.
 * Base and operator layers are managed by the system.
 */
export function createPrompt(
  params: PromptCreateParams
): Promise<PromptUpdateResult> {
  return apiPost<PromptUpdateResult>('/api/admin/prompts', params);
}
