import { apiGet, apiGetConditional, apiPost } from '$lib/api/client';
import { withQuery } from '$lib/api/query';
import { getGardenCacheStorage } from '$lib/cache/indexeddb';
import {
  LocalFirstResource,
  type ConditionalFetchResponse,
} from '$lib/cache/local-first';
import {
  isAdminSessionListData,
  isAdminSessionMessagesData,
  mergeSessionMessagePages,
  sessionMessageCursor,
} from '$lib/cache/session-cache';
import type {
  AdminCogSecEventListData,
  AdminCogSecRemediationApplyData,
  AdminCogSecRemediationInput,
  AdminCogSecRemediationPreviewData,
  AdminSessionDetailData,
  AdminSessionListData,
  AdminSessionMessagesData,
  AdminSessionRouteListData,
  AdminSessionRouteResetData,
  AdminSessionRouteResetInput,
  AdminSessionSearchData,
  AdminSessionTurnDetailData,
} from '$lib/types';
import {
  getCompanionCacheScope,
  onCompanionScopeChange,
} from '$lib/fleet/companion-scope';

export const SESSION_MESSAGE_PAGE_SIZE = 100;
export const SESSION_SEARCH_LIMIT = 100;

const sessionListRevalidations = new Map<string, Promise<AdminSessionListData>>();
const sessionMessageRevalidations = new Map<string, Promise<AdminSessionMessagesData>>();

onCompanionScopeChange(() => {
  sessionListRevalidations.clear();
  sessionMessageRevalidations.clear();
});

async function fetchConditional(
  path: string,
  etag: string | undefined,
): Promise<ConditionalFetchResponse> {
  const response = await apiGetConditional(path, etag);
  if (response.kind === 'data') return response;
  return response.etag === null
    ? { kind: 'not_modified' }
    : { kind: 'not_modified', etag: response.etag };
}

const sessionListCache = new LocalFirstResource({
  key: 'sessions:list',
  storage: getGardenCacheStorage(),
  validate: isAdminSessionListData,
  fetch: request => fetchConditional(
    '/api/admin/sessions',
    request.forceFull ? undefined : request.etag,
  ),
});

export interface SessionMessagesRequest {
  limit?: number;
  beforeId?: number | null;
  messagesOnly?: boolean;
  /**
   * Send `false` to drop the up-to-50 full turn snapshots and role-envelope
   * previews while keeping compaction summaries. Omit (server default true) to
   * keep the turns array for the prompt-monitor/Loom fetch.
   */
  includeTurns?: boolean;
}

export function listSessions(): Promise<AdminSessionListData> {
  return apiGet<AdminSessionListData>('/api/admin/sessions');
}

/**
 * Read the origin-scoped persisted session index. Invalid records are removed
 * by the cache boundary and are never surfaced to the page.
 */
export async function getCachedSessionList(): Promise<AdminSessionListData | null> {
  return (await sessionListCache.read())?.data ?? null;
}

export async function clearSessionListCache(): Promise<void> {
  await sessionListCache.remove();
  sessionListRevalidations.delete(getCompanionCacheScope());
}

export function revalidateSessionList(): Promise<AdminSessionListData> {
  const companionScope = getCompanionCacheScope();
  const active = sessionListRevalidations.get(companionScope);
  if (active) return active;
  const current = sessionListCache.revalidate()
    .then(result => result.data)
    .finally(() => {
      if (sessionListRevalidations.get(companionScope) === current) {
        sessionListRevalidations.delete(companionScope);
      }
    });
  sessionListRevalidations.set(companionScope, current);
  return current;
}

export function buildSessionDetailPath(sessionId: string): string {
  return `/api/admin/sessions/${encodeURIComponent(sessionId)}/detail`;
}

export function getSessionDetail(sessionId: string): Promise<AdminSessionDetailData> {
  return apiGet<AdminSessionDetailData>(buildSessionDetailPath(sessionId));
}

export function buildSessionMessagesPath(
  sessionId: string,
  request: SessionMessagesRequest = {},
): string {
  const params = new URLSearchParams();
  if (request.limit !== undefined) {
    params.set('limit', String(request.limit));
  }
  if (request.beforeId !== undefined && request.beforeId !== null) {
    params.set('beforeId', String(request.beforeId));
  }
  if (request.messagesOnly) {
    params.set('messagesOnly', 'true');
  }
  if (request.includeTurns === false) {
    params.set('includeTurns', 'false');
  }
  const path = `/api/admin/sessions/${encodeURIComponent(sessionId)}`;
  return withQuery(path, params);
}

export function getSessionMessages(
  sessionId: string,
  request: SessionMessagesRequest = {},
): Promise<AdminSessionMessagesData> {
  return apiGet<AdminSessionMessagesData>(buildSessionMessagesPath(sessionId, request));
}

function requireCacheableSessionMessagesRequest(request: SessionMessagesRequest): void {
  if ((request.beforeId !== undefined && request.beforeId !== null)
    || request.messagesOnly
    || request.includeTurns !== false) {
    throw new Error('Session transcript cache only accepts the lean newest-message page');
  }
}

function createSessionMessagesCache(
  sessionId: string,
  request: SessionMessagesRequest,
): LocalFirstResource<AdminSessionMessagesData> {
  requireCacheableSessionMessagesRequest(request);
  const path = buildSessionMessagesPath(sessionId, request);
  return new LocalFirstResource({
    key: `sessions:transcript:${path}`,
    storage: getGardenCacheStorage(),
    validate: isAdminSessionMessagesData,
    cursor: sessionMessageCursor,
    merge: mergeSessionMessagePages,
    fetch: conditional => fetchConditional(
      path,
      conditional.forceFull ? undefined : conditional.etag,
    ),
  });
}

export async function getCachedSessionMessages(
  sessionId: string,
  request: SessionMessagesRequest,
): Promise<AdminSessionMessagesData | null> {
  return (await createSessionMessagesCache(sessionId, request).read())?.data ?? null;
}

export function revalidateSessionMessages(
  sessionId: string,
  request: SessionMessagesRequest,
): Promise<AdminSessionMessagesData> {
  const path = buildSessionMessagesPath(sessionId, request);
  const key = `${getCompanionCacheScope()}:${path}`;
  const active = sessionMessageRevalidations.get(key);
  if (active) return active;
  const current = createSessionMessagesCache(sessionId, request)
    .revalidate()
    .then(result => result.data)
    .finally(() => {
      if (sessionMessageRevalidations.get(key) === current) {
        sessionMessageRevalidations.delete(key);
      }
    });
  sessionMessageRevalidations.set(key, current);
  return current;
}

export function buildSessionTurnDetailPath(sessionId: string, turnId: string): string {
  return `/api/admin/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}`;
}

export function getSessionTurnDetail(
  sessionId: string,
  turnId: string,
): Promise<AdminSessionTurnDetailData> {
  return apiGet<AdminSessionTurnDetailData>(buildSessionTurnDetailPath(sessionId, turnId));
}

export function searchSessionMessages(
  sessionId: string,
  query: string,
  limit?: number,
): Promise<AdminSessionSearchData> {
  const params = new URLSearchParams({ q: query });
  if (limit !== undefined) {
    params.set('limit', String(limit));
  }
  return apiGet<AdminSessionSearchData>(withQuery(
    `/api/admin/sessions/${encodeURIComponent(sessionId)}/search`,
    params,
  ));
}

export function listSessionRoutes(): Promise<AdminSessionRouteListData> {
  return apiGet<AdminSessionRouteListData>('/api/admin/session-routes');
}

export function resetSourceChannelSession(
  input: AdminSessionRouteResetInput,
): Promise<AdminSessionRouteResetData> {
  // The server derives the audit actor from the authenticated request context.
  // Never forward the legacy browser field across the fleet capability boundary.
  return apiPost<AdminSessionRouteResetData>('/api/admin/session-routes/reset', {
    sourceChannelId: input.sourceChannelId,
    reason: input.reason,
    ...(input.mode ? { mode: input.mode } : {}),
  });
}

export function listCogSecEvents(): Promise<AdminCogSecEventListData> {
  return apiGet<AdminCogSecEventListData>('/api/admin/session-routes/cogsec/events');
}

export function previewCogSecRemediation(
  input: AdminCogSecRemediationInput,
): Promise<AdminCogSecRemediationPreviewData> {
  const { actor: _serverOwnedActor, ...body } = input;
  return apiPost<AdminCogSecRemediationPreviewData>(
    '/api/admin/session-routes/cogsec/preview',
    body,
  );
}

export function applyCogSecRemediation(
  input: AdminCogSecRemediationInput,
): Promise<AdminCogSecRemediationApplyData> {
  const { actor: _serverOwnedActor, ...body } = input;
  return apiPost<AdminCogSecRemediationApplyData>(
    '/api/admin/session-routes/cogsec/apply',
    body,
  );
}
