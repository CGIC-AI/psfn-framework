// ── Garden social-graph proposal routes (E4.2) ──
// Additive, isolated route module for the operator review surface over the
// background graph-builder worker's edge proposals. Registered from
// buildAdminApiRoutes when a graph-proposals service is wired. Endpoints:
//   GET  /api/admin/graph-proposals              — list proposals + review state
//   POST /api/admin/graph-proposals/:id/approve  — write edge (optional adjusted type)
//   POST /api/admin/graph-proposals/:id/reject   — reject (blocks re-proposal)
// Proposals never become live edges until approved here.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../../channels/backplane/http/primitives.js';
import {
  exactPath,
  paramWithSuffix,
  type RouteMatcher,
  type RouteParams,
} from './route-matchers.js';
import type {
  AdminGraphProposalMutationResult,
  AdminGraphProposalsService,
} from './services/graph-proposals-service.js';

interface AdminApiRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  match: RouteMatcher;
  handle: (req: IncomingMessage, res: ServerResponse, params: RouteParams) => void;
}

const ADMIN_DYNAMIC_JSON_HEADERS = { 'Cache-Control': 'no-store' } as const;

function parseAdjustedType(body: string): string | undefined {
  const trimmed = body.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as { relationshipType?: unknown };
    return typeof parsed.relationshipType === 'string' ? parsed.relationshipType : undefined;
  } catch {
    return undefined;
  }
}

export function buildAdminGraphProposalRoutes(options: {
  graphProposalsService: AdminGraphProposalsService;
  withBody: (req: IncomingMessage, res: ServerResponse, cb: (body: string) => void) => void;
}): AdminApiRoute[] {
  const { graphProposalsService, withBody } = options;

  const respondWithMutationResult = (
    res: ServerResponse,
    result: AdminGraphProposalMutationResult,
  ): void => {
    if (!result.ok) {
      sendJson(res, result.message.includes('not found') ? 404 : 400, { error: result.message });
      return;
    }
    sendJson(res, 200, result);
  };

  const handleMutation = (
    res: ServerResponse,
    mutation: Promise<AdminGraphProposalMutationResult>,
  ): void => {
    mutation.then(
      (result) => respondWithMutationResult(res, result),
      (error) => sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) }),
    );
  };

  return [
    {
      method: 'GET',
      match: exactPath('/api/admin/graph-proposals'),
      handle: (_req, res) => {
        graphProposalsService.listGraphProposals().then(
          (data) => sendJson(res, 200, data, ADMIN_DYNAMIC_JSON_HEADERS),
          (error) => sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) }),
        );
      },
    },
    {
      method: 'POST',
      match: paramWithSuffix('/api/admin/graph-proposals/', 'id', '/approve'),
      handle: (req, res, { id }) => {
        withBody(req, res, (body) => {
          handleMutation(res, graphProposalsService.approveGraphProposal(id, parseAdjustedType(body)));
        });
      },
    },
    {
      method: 'POST',
      match: paramWithSuffix('/api/admin/graph-proposals/', 'id', '/reject'),
      handle: (_req, res, { id }) => {
        handleMutation(res, graphProposalsService.rejectGraphProposal(id));
      },
    },
  ];
}
