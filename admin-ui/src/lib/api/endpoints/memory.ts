import { apiGet, apiDelete } from '../client';
import type { AdminMemoryListData, AdminMemoryDetailData, AdminMemorySearchResult } from '$lib/types';

export interface MemoryListParams {
  type?: string;
  limit?: number;
  offset?: number;
}

export function listMemories(params?: MemoryListParams): Promise<AdminMemoryListData> {
  const p: Record<string, string> = {};
  if (params?.type) p.type = params.type;
  if (params?.limit) p.limit = String(params.limit);
  if (params?.offset) p.offset = String(params.offset);
  return apiGet('/api/admin/memory', p);
}

export function getMemory(id: string): Promise<AdminMemoryDetailData> {
  return apiGet(`/api/admin/memory/${encodeURIComponent(id)}`);
}

export function searchMemories(query: string): Promise<AdminMemorySearchResult> {
  return apiGet('/api/admin/memory/search', { q: query });
}

export function deleteMemory(id: string): Promise<{ ok: boolean }> {
  return apiDelete(`/api/admin/memory/${encodeURIComponent(id)}`);
}
