import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteMatcher, RouteParams } from '../route-matchers.js';
import type {
  AdminAuditActionType,
  AdminAuditActor,
  AdminAuditDecision,
} from '../types.js';
import type { AuthorizedGardenRoute } from '../../../boundary/fleet-auth/garden-route-capabilities.js';
import type {
  FleetGardenRequestContext,
  GardenRequestContext,
} from '../garden-request-context.js';

export type ProtectedConcernAction = 'resolve' | 'suppress' | 'transition' | 'resolve_stale';

export interface AdminSubjectVisibleAuditPort {
  recordMemoryReveal(input: {
    context: FleetGardenRequestContext;
    reason: string;
  }): void;
  recordConcernAction(input: {
    context: FleetGardenRequestContext;
    action: ProtectedConcernAction;
    reason: string;
  }): void;
}

export interface AdminApiRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  match: RouteMatcher;
  handle: (
    req: IncomingMessage,
    res: ServerResponse,
    params: RouteParams,
    context?: GardenRequestContext,
  ) => void;
}

export type AuthorizedAdminApiRoute = AuthorizedGardenRoute<AdminApiRoute>;

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
  context?: GardenRequestContext,
) => void;
