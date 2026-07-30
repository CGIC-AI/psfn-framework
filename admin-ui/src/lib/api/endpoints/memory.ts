import { apiDelete, apiFetch, apiGet, apiPost, throwIfNotOk } from '$lib/api/client';
import { currentCompanionGardenScope } from '$lib/fleet/companion-scope';
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

// Reveals a single high-intimacy memory body. Audit-logged server-side.
export function revealMemory(id: string): Promise<AdminMemoryDetailData> {
  return apiPost<AdminMemoryDetailData>(revealMemoryPath(id), {});
}

// Gateway fleet-auth ceremony routes. These are NOT Garden data paths: they
// must never be rewritten into a companion-scoped prefix, so they use raw
// same-origin fetch rather than apiFetch.
const FLEET_CSRF_PATH = '/v1/fleet-auth/session/csrf';
const FLEET_ESCALATION_GRANT_PATH = '/v1/fleet-auth/escalation/grant';
const FLEET_CSRF_HEADER = 'X-PSFN-CSRF';
const FLEET_ESCALATION_GRANT_HEADER = 'x-psfn-escalation-grant';
const FLEET_CSRF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
// Mirrors the server's checkedEscalationReason contract so an unusable reason
// is refused before it reaches the audit trail.
const ESCALATION_REASON_MAX_LENGTH = 512;
const ESCALATION_REASON_CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

function revealMemoryPath(id: string): string {
  return `/api/admin/memory/${encodeURIComponent(id)}/reveal`;
}

function checkedEscalationReason(reason: string): string {
  const normalized = reason.trim();
  if (!normalized
    || normalized.length > ESCALATION_REASON_MAX_LENGTH
    || ESCALATION_REASON_CONTROL_CHARS.test(normalized)) {
    throw new Error(
      `An escalation reason of 1-${ESCALATION_REASON_MAX_LENGTH} printable characters is required`,
    );
  }
  return normalized;
}

async function issueFleetCsrfToken(): Promise<string> {
  const res = await fetch(FLEET_CSRF_PATH, {
    cache: 'no-store',
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  await throwIfNotOk(res);
  const payload = await res.json() as { csrfToken?: unknown };
  if (typeof payload.csrfToken !== 'string' || !FLEET_CSRF_TOKEN_PATTERN.test(payload.csrfToken)) {
    throw new Error('Cluster escalation ceremony unavailable');
  }
  return payload.csrfToken;
}

/**
 * Reveals one high-intimacy memory body for a fleet SSO principal.
 *
 * Fleet principals have no session-wide elevation: each reveal names its own
 * reason, mints one single-use audited escalation grant bound to exactly this
 * reveal route, and spends it on the immediately following request. Every step
 * fails closed -- no grant, no reveal.
 */
export async function revealMemoryEscalated(
  id: string,
  reason: string,
): Promise<AdminMemoryDetailData> {
  const scope = currentCompanionGardenScope();
  if (!scope) {
    throw new Error('Audited escalation requires an authorized companion Garden route');
  }
  const target = revealMemoryPath(id);
  const auditedReason = checkedEscalationReason(reason);
  const csrfToken = await issueFleetCsrfToken();
  const grantResponse = await fetch(FLEET_ESCALATION_GRANT_PATH, {
    method: 'POST',
    cache: 'no-store',
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      [FLEET_CSRF_HEADER]: csrfToken,
    },
    body: JSON.stringify({
      companionId: scope.companionId,
      method: 'POST',
      target,
      reason: auditedReason,
    }),
  });
  await throwIfNotOk(grantResponse);
  const grant = await grantResponse.json() as { grantId?: unknown };
  if (typeof grant.grantId !== 'string' || !grant.grantId) {
    throw new Error('Escalation grant response is malformed');
  }
  return apiPost<AdminMemoryDetailData>(target, {}, {
    headers: { [FLEET_ESCALATION_GRANT_HEADER]: grant.grantId },
  });
}

export function getMemoryElevation(): Promise<AdminMemoryElevationStatus> {
  return apiGet<AdminMemoryElevationStatus>('/api/admin/memory/elevation');
}

// Grants TTL-bound access to all high-intimacy memory bodies. Audit-logged server-side.
export function elevateMemoryBodyAccess(): Promise<AdminMemoryElevationStatus> {
  return apiPost<AdminMemoryElevationStatus>('/api/admin/memory/elevation', {});
}

export function dropMemoryBodyElevation(): Promise<AdminMemoryElevationStatus> {
  return apiDelete<AdminMemoryElevationStatus>('/api/admin/memory/elevation');
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
