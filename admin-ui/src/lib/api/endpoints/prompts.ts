import { apiGet, apiPatch, apiPost, apiPut } from '$lib/api/client';
import { isRecord } from '../../../../../src/shared/utils/types.js';
import type {
  ConstitutionUpdateResult,
  ConstitutionSnapshotData,
  FoundationSnapshotData,
  FoundationUpdateResult,
  NorthStarSnapshotData,
  NorthStarUpdateResult,
  AdminPromptListData,
  AdminPromptDetailData,
  PromptUpdateResult,
  PromptDiffResult,
  RuntimePromptUpdateResult,
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

export async function countPromptTokens(texts: string[]): Promise<number[]> {
  const result = await apiPost<unknown>('/api/admin/prompts/count-tokens', { texts });
  if (!isRecord(result)
    || Object.keys(result).some(key => key !== 'counts')
    || !Array.isArray(result.counts)
    || result.counts.length !== texts.length
    || !result.counts.every(count => Number.isSafeInteger(count) && count >= 0)) {
    throw new Error('Invalid prompt token-count response');
  }
  return result.counts as number[];
}

export function getConstitutionSnapshot(): Promise<ConstitutionSnapshotData> {
  return apiGet<ConstitutionSnapshotData>('/api/admin/prompts/constitution');
}

export function getFoundationSnapshot(): Promise<FoundationSnapshotData> {
  return apiGet<FoundationSnapshotData>('/api/admin/prompts/foundation');
}

export function saveFoundationSections(body: {
  sections: Array<{
    id: string;
    content: string;
    enabled: boolean;
  }>;
}): Promise<FoundationUpdateResult> {
  return apiPut<FoundationUpdateResult>('/api/admin/prompts/foundation', body);
}

export function saveConstitutionMutableLayers(body: {
  mutableLayers: Array<{
    id: string;
    content?: string;
    enabled?: boolean;
    identifier?: string | null;
    role?: string | null;
    promptOrder?: number | null;
  }>;
}): Promise<ConstitutionUpdateResult> {
  return apiPut<ConstitutionUpdateResult>('/api/admin/prompts/constitution', body);
}

export function getNorthStarSnapshot(): Promise<NorthStarSnapshotData> {
  return apiGet<NorthStarSnapshotData>('/api/admin/prompts/north-star');
}

export function saveNorthStarItems(body: {
  items: Array<{
    id?: string;
    title: string;
    content: string;
    scope: 'shared' | 'companion';
    enabled: boolean;
  }>;
}): Promise<NorthStarUpdateResult> {
  return apiPut<NorthStarUpdateResult>('/api/admin/prompts/north-star', body);
}

export function saveRuntimePromptBlocks(body: {
  blocks: Array<{
    id: string;
    content: string;
  }>;
}): Promise<RuntimePromptUpdateResult> {
  return apiPut<RuntimePromptUpdateResult>('/api/admin/prompts/runtime-blocks', body);
}

export function createPromptLayer(
  body: Record<string, unknown>
): Promise<PromptUpdateResult> {
  return apiPost<PromptUpdateResult>('/api/admin/prompts', body);
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
