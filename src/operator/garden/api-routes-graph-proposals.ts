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
import { assertNoUnknownKeys, isRecord } from '../../shared/utils/types.js';
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
import { parseAdminJsonBody } from './request-body.js';
import { ADMIN_POLLED_QUEUE_JSON_HEADERS } from './routes/shared.js';

interface AdminApiRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  match: RouteMatcher;
  handle: (req: IncomingMessage, res: ServerResponse, params: RouteParams) => void;
}

type AdjustedTypeParseResult =
  | { ok: true; value: string | undefined }
  | { ok: false; error: string };

function parseAdjustedType(body: unknown): AdjustedTypeParseResult {
  const parsed = parseAdminJsonBody(body);
  if (!parsed.ok) return parsed;
  if (!isRecord(parsed.value)) {
    return { ok: false, error: 'Graph proposal approval payload must be a JSON object' };
  }
  try {
    assertNoUnknownKeys(
      parsed.value,
      ['relationshipType'],
      'Graph proposal approval payload',
    );
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (parsed.value.relationshipType === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof parsed.value.relationshipType !== 'string') {
    return { ok: false, error: 'relationshipType must be a string' };
  }
  return { ok: true, value: parsed.value.relationshipType };
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
          (data) => sendJson(res, 200, data, ADMIN_POLLED_QUEUE_JSON_HEADERS),
          (error) => sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) }),
        );
      },
    },
    {
      method: 'POST',
      match: paramWithSuffix('/api/admin/graph-proposals/', 'id', '/approve'),
      handle: (req, res, { id }) => {
        withBody(req, res, (body) => {
          const parsed = parseAdjustedType(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          handleMutation(res, graphProposalsService.approveGraphProposal(id, parsed.value));
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
