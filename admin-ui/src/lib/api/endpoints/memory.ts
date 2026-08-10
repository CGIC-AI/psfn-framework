import { apiDelete, apiFetch, apiGet, apiPost } from '$lib/api/client';
import { withQuery } from '$lib/api/query';
import { apiPostProtected } from '$lib/api/protected-mutation';
import type {
  AdminBulkMutationResult,
  AdminMemoryElevationStatus,
  AdminMemoryLink,
  AdminMemoryLinkResult,
  AdminMemoryListData,
  AdminMemorySearchResult,
  AdminMemoryDetailData,
  AdminMemoryScopeDetailData,
  AdminMemoryScopeListData,
  AdminMemoryScopeMutationResult,
  AdminUiMemoryScopeRef,
} from '$lib/types';

export interface MemoryListParams {
  type?: string;
  sensitivity?: string;
  retention?: string;
  preference?: boolean;
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
  if (params?.retention) search.set('retention', params.retention);
  if (params?.preference) search.set('preference', 'true');
  if (params?.startDate) search.set('startDate', params.startDate);
  if (params?.endDate) search.set('endDate', params.endDate);
  if (params?.limit !== undefined) search.set('limit', String(params.limit));
  if (params?.offset !== undefined) search.set('offset', String(params.offset));
  return apiGet<AdminMemoryListData>(withQuery('/api/admin/memory', search));
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

// Reveals a single high-intimacy memory body. Audit-logged server-side.
export function revealMemory(id: string, reason = ''): Promise<AdminMemoryDetailData> {
  const statedReason = reason.trim();
  return apiPostProtected<AdminMemoryDetailData>(
    revealMemoryPath(id),
    statedReason ? { reason: statedReason } : {},
    statedReason,
  );
}

function revealMemoryPath(id: string): string {
  return `/api/admin/memory/${encodeURIComponent(id)}/reveal`;
}

/**
 * Reveals one high-intimacy memory body for a fleet SSO principal.
 *
 * Fleet principals have no session-wide elevation: each reveal names its own
 * reason, mints one single-use audited escalation grant bound to exactly this
 * reveal route, and spends it on the immediately following request. Every step
 * fails closed -- no grant, no reveal.
 */
// Grants TTL-bound access to all high-intimacy memory bodies. Audit-logged server-side.
export function elevateMemoryBodyAccess(reason = ''): Promise<AdminMemoryElevationStatus> {
  return apiPostProtected<AdminMemoryElevationStatus>('/api/admin/memory/elevation', {}, reason);
}

export function dropMemoryBodyElevation(): Promise<AdminMemoryElevationStatus> {
  return apiDelete<AdminMemoryElevationStatus>('/api/admin/memory/elevation');
}

export function listManagedMemoryScopes(kind?: 'project' | 'north_star'): Promise<AdminMemoryScopeListData> {
  const search = new URLSearchParams();
  if (kind) search.set('kind', kind);
  return apiGet<AdminMemoryScopeListData>(withQuery('/api/admin/memory/scopes', search));
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
    scopeRef?: AdminUiMemoryScopeRef | null;
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
  const res = await apiFetch('/api/admin/memory/link', {
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
  fields: { memoryType?: string; sensitivity?: string; retentionClass?: string }
): Promise<AdminBulkMutationResult> {
  return apiPost<AdminBulkMutationResult>('/api/admin/memory/bulk-update', {
    ids,
    fields,
  });
}
