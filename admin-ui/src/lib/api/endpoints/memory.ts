import { apiGet, apiDelete } from '$lib/api/client';
import type {
  AdminMemoryListData,
  AdminMemorySearchResult,
  AdminMemoryDetailData,
} from '$lib/types';

export interface MemoryListParams {
  type?: string;
  limit?: number;
  offset?: number;
}

export function listMemories(
  params?: MemoryListParams
): Promise<AdminMemoryListData> {
  const search = new URLSearchParams();
  if (params?.type) search.set('type', params.type);
  if (params?.limit !== undefined) search.set('limit', String(params.limit));
  if (params?.offset !== undefined) search.set('offset', String(params.offset));
  const qs = search.toString();
  return apiGet<AdminMemoryListData>(`/api/admin/memory${qs ? `?${qs}` : ''}`);
}

export function searchMemories(q: string): Promise<AdminMemorySearchResult> {
  return apiGet<AdminMemorySearchResult>(
    `/api/admin/memory/search?q=${encodeURIComponent(q)}`
  );
}

export function getMemoryDetail(id: string): Promise<AdminMemoryDetailData> {
  return apiGet<AdminMemoryDetailData>(
    `/api/admin/memory/${encodeURIComponent(id)}`
  );
}

export function deleteMemory(
  id: string
): Promise<{ ok: boolean; message: string }> {
  return apiDelete<{ ok: boolean; message: string }>(
    `/api/admin/memory/${encodeURIComponent(id)}`
  );
}
