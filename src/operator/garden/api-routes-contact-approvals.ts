// ── Garden pending contact approvals routes (E3.4) ──
// Additive, isolated route module for the contact-tracking policy gate's
// operator approval queue. Registered from buildAdminApiRoutes when the
// pending-contacts service is wired (agent runtime with a pending store).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../../channels/backplane/http/primitives.js';
import {
  exactPath,
  paramWithSuffix,
  type RouteMatcher,
  type RouteParams,
} from './route-matchers.js';
import type {
  AdminPendingContactMutationResult,
  AdminPendingContactsService,
} from './services/pending-contacts-service.js';

interface AdminApiRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  match: RouteMatcher;
  handle: (req: IncomingMessage, res: ServerResponse, params: RouteParams) => void;
}

const ADMIN_DYNAMIC_JSON_HEADERS = { 'Cache-Control': 'no-store' } as const;

export function buildAdminContactApprovalRoutes(options: {
  pendingContactsService: AdminPendingContactsService;
}): AdminApiRoute[] {
  const { pendingContactsService } = options;

  const respondWithMutationResult = (
    res: ServerResponse,
    result: AdminPendingContactMutationResult,
  ): void => {
    if (!result.ok) {
      sendJson(res, result.message.includes('not found') ? 404 : 400, { error: result.message });
      return;
    }
    sendJson(res, 200, result);
  };

  const handleMutation = (
    res: ServerResponse,
    mutation: Promise<AdminPendingContactMutationResult>,
  ): void => {
    mutation.then(
      (result) => respondWithMutationResult(res, result),
      (error) => sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) }),
    );
  };

  return [
    {
      method: 'GET',
      match: exactPath('/api/admin/contact-approvals'),
      handle: (_req, res) => {
        pendingContactsService.listPendingContactApprovals().then(
          (data) => sendJson(res, 200, data, ADMIN_DYNAMIC_JSON_HEADERS),
          (error) => sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) }),
        );
      },
    },
    {
      method: 'POST',
      match: paramWithSuffix('/api/admin/contact-approvals/', 'id', '/approve'),
      handle: (_req, res, { id }) => {
        handleMutation(res, pendingContactsService.approvePendingContact(id));
      },
    },
    {
      method: 'POST',
      match: paramWithSuffix('/api/admin/contact-approvals/', 'id', '/deny'),
      handle: (_req, res, { id }) => {
        handleMutation(res, pendingContactsService.denyPendingContact(id));
      },
    },
    {
      method: 'POST',
      match: paramWithSuffix('/api/admin/contact-approvals/', 'id', '/reset'),
      handle: (_req, res, { id }) => {
        handleMutation(res, pendingContactsService.resetPendingContactDecision(id));
      },
    },
  ];
}
