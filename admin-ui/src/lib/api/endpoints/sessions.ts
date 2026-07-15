import { apiGet, apiPost } from '$lib/api/client';
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

export const SESSION_MESSAGE_PAGE_SIZE = 100;
export const SESSION_SEARCH_LIMIT = 100;

let cachedSessionList: AdminSessionListData | null = null;
let sessionListRevalidation: Promise<AdminSessionListData> | null = null;

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
 * The cache lives only for the current Garden JavaScript session. Revalidation
 * still uses apiGet, whose `no-cache` request contract lets the browser send
 * the shared admin ETag and reuse the body after a 304 response.
 */
export function getCachedSessionList(): AdminSessionListData | null {
  return cachedSessionList;
}

export function clearSessionListCache(): void {
  cachedSessionList = null;
  sessionListRevalidation = null;
}

export function revalidateSessionList(
  fetchList: () => Promise<AdminSessionListData> = listSessions,
): Promise<AdminSessionListData> {
  if (sessionListRevalidation) return sessionListRevalidation;
  const current = fetchList()
    .then((data) => {
      cachedSessionList = data;
      return data;
    })
    .finally(() => {
      if (sessionListRevalidation === current) sessionListRevalidation = null;
    });
  sessionListRevalidation = current;
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
  const query = params.toString();
  const path = `/api/admin/sessions/${encodeURIComponent(sessionId)}`;
  return query ? `${path}?${query}` : path;
}

export function getSessionMessages(
  sessionId: string,
  request: SessionMessagesRequest = {},
): Promise<AdminSessionMessagesData> {
  return apiGet<AdminSessionMessagesData>(buildSessionMessagesPath(sessionId, request));
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
  return apiGet<AdminSessionSearchData>(
    `/api/admin/sessions/${encodeURIComponent(sessionId)}/search?${params.toString()}`,
  );
}

export function listSessionRoutes(): Promise<AdminSessionRouteListData> {
  return apiGet<AdminSessionRouteListData>('/api/admin/session-routes');
}

export function resetSourceChannelSession(
  input: AdminSessionRouteResetInput,
): Promise<AdminSessionRouteResetData> {
  return apiPost<AdminSessionRouteResetData>('/api/admin/session-routes/reset', input);
}

export function listCogSecEvents(): Promise<AdminCogSecEventListData> {
  return apiGet<AdminCogSecEventListData>('/api/admin/session-routes/cogsec/events');
}

export function previewCogSecRemediation(
  input: AdminCogSecRemediationInput,
): Promise<AdminCogSecRemediationPreviewData> {
  return apiPost<AdminCogSecRemediationPreviewData>('/api/admin/session-routes/cogsec/preview', input);
}

export function applyCogSecRemediation(
  input: AdminCogSecRemediationInput,
): Promise<AdminCogSecRemediationApplyData> {
  return apiPost<AdminCogSecRemediationApplyData>('/api/admin/session-routes/cogsec/apply', input);
}
