import { apiDelete, apiGet, apiPost } from '$lib/api/client';
import type {
  AdminBulkMutationResult,
  AdminMemoryLink,
  AdminMemoryLinkResult,
  AdminMemoryListData,
  AdminMemorySearchResult,
  AdminMemoryDetailData,
  AdminMemoryScopeDetailData,
  AdminMemoryScopeListData,
  AdminMemoryScopeMutationResult,
  MemoryScopeRef,
} from '$lib/types';

export interface MemoryListParams {
  type?: string;
  sensitivity?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
  offset?: number;
}

export function listMemories(
  params?: MemoryListParams
): Promise<AdminMemoryListData> {
  const search = new URLSearchParams();
  if (params?.type) search.set('type', params.type);
  if (params?.sensitivity) search.set('sensitivity', params.sensitivity);
  if (params?.startDate) search.set('startDate', params.startDate);
  if (params?.endDate) search.set('endDate', params.endDate);
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

export function listManagedMemoryScopes(kind?: 'project' | 'north_star'): Promise<AdminMemoryScopeListData> {
  const search = new URLSearchParams();
  if (kind) search.set('kind', kind);
  const qs = search.toString();
  return apiGet<AdminMemoryScopeListData>(`/api/admin/memory/scopes${qs ? `?${qs}` : ''}`);
}

export function getManagedMemoryScopeDetail(
  kind: 'project' | 'north_star',
  id: string,
): Promise<AdminMemoryScopeDetailData> {
  return apiGet<AdminMemoryScopeDetailData>(
    `/api/admin/memory/scopes/${encodeURIComponent(`${kind}:${id}`)}/detail`
  );
}

export function updateMemoryScope(
  id: string,
  fields: {
    scopeRef?: MemoryScopeRef | null;
    scopeTags?: string[];
    repair?: boolean;
  }
): Promise<AdminMemoryScopeMutationResult> {
  return apiPost<AdminMemoryScopeMutationResult>('/api/admin/memory/scope-update', {
    id,
    ...fields,
  });
}

export function deleteMemory(
  id: string
): Promise<{ ok: boolean; message: string }> {
  return apiDelete<{ ok: boolean; message: string }>(
    `/api/admin/memory/${encodeURIComponent(id)}`
  );
}

export function linkMemories(
  id1: string,
  id2: string,
  linkType?: string
): Promise<AdminMemoryLinkResult> {
  return apiPost<AdminMemoryLinkResult>('/api/admin/memory/link', {
    id1,
    id2,
    ...(linkType ? { linkType } : {}),
  });
}

export async function unlinkMemories(
  id1: string,
  id2: string
): Promise<{ ok: boolean }> {
  const res = await fetch('/api/admin/memory/link', {
    method: 'DELETE',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify({ id1, id2 }),
  });
  if (!res.ok) {
    throw new Error(`Unlink failed (${res.status})`);
  }
  return res.json() as Promise<{ ok: boolean }>;
}

export function getMemoryLinks(id: string): Promise<{ links: AdminMemoryLink[] }> {
  return apiGet<{ links: AdminMemoryLink[] }>(
    `/api/admin/memory/${encodeURIComponent(id)}/links`
  );
}

export function bulkDeleteMemories(ids: string[]): Promise<AdminBulkMutationResult> {
  return apiPost<AdminBulkMutationResult>('/api/admin/memory/bulk-delete', { ids });
}

export function bulkUpdateMemories(
  ids: string[],
  fields: { memoryType?: string; sensitivity?: string }
): Promise<AdminBulkMutationResult> {
  return apiPost<AdminBulkMutationResult>('/api/admin/memory/bulk-update', {
    ids,
    fields,
  });
}
