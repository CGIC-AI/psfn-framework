import { apiGet, apiPost } from '$lib/api/client';
import type {
  AdminSessionListData,
  AdminSessionMessagesData,
  AdminSessionRouteListData,
  AdminSessionRouteResetData,
  AdminSessionRouteResetInput,
} from '$lib/types';

export const SESSION_MESSAGE_PAGE_SIZE = 100;

export interface SessionMessagesRequest {
  limit?: number;
  beforeId?: number | null;
}

export function listSessions(): Promise<AdminSessionListData> {
  return apiGet<AdminSessionListData>('/api/admin/sessions');
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

export function listSessionRoutes(): Promise<AdminSessionRouteListData> {
  return apiGet<AdminSessionRouteListData>('/api/admin/session-routes');
}

export function resetSourceChannelSession(
  input: AdminSessionRouteResetInput,
): Promise<AdminSessionRouteResetData> {
  return apiPost<AdminSessionRouteResetData>('/api/admin/session-routes/reset', input);
}
