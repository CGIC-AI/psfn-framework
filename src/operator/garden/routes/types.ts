import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteMatcher, RouteParams } from '../route-matchers.js';
import type {
  AdminAuditActionType,
  AdminAuditActor,
  AdminAuditDecision,
} from '../types.js';

export interface AdminApiRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  match: RouteMatcher;
  handle: (req: IncomingMessage, res: ServerResponse, params: RouteParams) => void;
}

export type AdminBodyReader = (
  req: IncomingMessage,
  res: ServerResponse,
  cb: (body: string) => void,
) => void;

export type AdminAuditTimelineAppender = (
  actionType: AdminAuditActionType,
  decision: AdminAuditDecision,
  narrative: string,
  details?: Array<string | null | undefined>,
  actor?: AdminAuditActor,
) => void;
