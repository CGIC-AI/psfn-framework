import type { IncomingMessage, ServerResponse } from 'node:http';

import { sendJson } from '../../channels/backplane/http/primitives.js';
import { parseAdminJsonBody } from './request-body.js';
import { exactPath, paramWithSuffix, prefixedParamPath } from './route-matchers.js';
import type { AdminAuditTimelineAppender, AdminBodyReader, AdminApiRoute } from './routes/types.js';
import { ADMIN_DYNAMIC_JSON_HEADERS, ADMIN_POLLED_QUEUE_JSON_HEADERS } from './routes/shared.js';
import type { GardenRequestContext } from './garden-request-context.js';
import {
  AdminBiographicalReviewService,
  BiographicalReviewError,
  type AdminBiographicalReviewActor,
} from './services/biographical-review-service.js';

const BIOGRAPHICAL_CLAIM_PREFIX = '/api/admin/biographical-claims/';

function isAdminContext(
  context: GardenRequestContext | undefined,
  action: 'memory.read' | 'memory.manage',
): context is Exclude<GardenRequestContext, { kind: 'public' }> {
  if (context === undefined || context.kind === 'public') return false;
  if (context.action !== action || context.authorization.action !== action) return false;
  if (context.authorization.baseRole !== 'admin') return false;
  if (context.kind === 'fleet_principal') {
    return context.resource.companionId !== null
      && (context.actor.role === 'owner' || context.actor.role === 'admin');
  }
  return true;
}

function reviewActor(context: GardenRequestContext | undefined): AdminBiographicalReviewActor | null {
  if (!isAdminContext(context, 'memory.manage')) return null;
  if (context.authorization.requirements.confirmation !== 'explicit') return null;
  return context.kind === 'fleet_principal'
    ? { kind: 'operator', authorityRef: `garden-fleet:${context.authorizationEventId}` }
    : { kind: 'operator', authorityRef: 'garden-standalone:operator' };
}

function reviewErrorStatus(error: BiographicalReviewError): number {
  if (error.reason === 'malformed') return 400;
  if (error.reason === 'unauthorized') return 403;
  if (error.reason === 'claim-not-found' || error.reason === 'grant-not-found') return 404;
  return 409;
}

function sendReviewError(res: ServerResponse, error: unknown): void {
  if (error instanceof BiographicalReviewError) {
    sendJson(res, reviewErrorStatus(error), { error: error.message, reason: error.reason });
    return;
  }
  sendJson(res, 500, { error: 'Biographical review failed' });
}

export function buildAdminBiographicalReviewRoutes(options: {
  service: AdminBiographicalReviewService | null;
  withBody: AdminBodyReader;
  appendAuditTimelineEntry?: AdminAuditTimelineAppender;
}): AdminApiRoute[] {
  const { service, withBody, appendAuditTimelineEntry } = options;
  return [
    {
      method: 'GET',
      match: exactPath('/api/admin/biographical-claims'),
      handle: (_req, res, _params, context) => {
        if (!isAdminContext(context, 'memory.read')) {
          sendJson(res, 403, { error: 'Admin memory-read authority is required' });
          return;
        }
        if (service === null) {
          sendJson(res, 503, { error: 'Biographical review persistence is unavailable' });
          return;
        }
        service.listClaims().then(
          result => sendJson(res, 200, result, ADMIN_POLLED_QUEUE_JSON_HEADERS),
          error => sendReviewError(res, error),
        );
      },
    },
    {
      method: 'GET',
      match: prefixedParamPath(BIOGRAPHICAL_CLAIM_PREFIX, 'claimId', {
        exclude: path => path.endsWith('/review'),
      }),
      handle: (_req, res, { claimId }, context) => {
        if (!isAdminContext(context, 'memory.read')) {
          sendJson(res, 403, { error: 'Admin memory-read authority is required' });
          return;
        }
        if (!claimId) {
          sendJson(res, 400, { error: 'claimId is required' });
          return;
        }
        if (service === null) {
          sendJson(res, 503, { error: 'Biographical review persistence is unavailable' });
          return;
        }
        service.getClaim(claimId).then(
          result => sendJson(res, 200, result, ADMIN_DYNAMIC_JSON_HEADERS),
          error => sendReviewError(res, error),
        );
      },
    },
    {
      method: 'POST',
      match: paramWithSuffix(BIOGRAPHICAL_CLAIM_PREFIX, 'claimId', '/review'),
      handle: (req: IncomingMessage, res: ServerResponse, { claimId }, context) => {
        const actor = reviewActor(context);
        if (actor === null) {
          sendJson(res, 403, { error: 'Explicit admin memory-management authority is required' });
          return;
        }
        if (!claimId) {
          sendJson(res, 400, { error: 'claimId is required' });
          return;
        }
        if (service === null) {
          sendJson(res, 503, { error: 'Biographical review persistence is unavailable' });
          return;
        }
        withBody(req, res, body => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            appendAuditTimelineEntry?.(
              'memory_mutation',
              'denied',
              'Biographical claim review rejected malformed JSON.',
              [`claimId=${claimId}`],
              'operator',
              context,
            );
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          service.review(claimId, parsed.value, actor).then(
            result => sendJson(res, 200, result, ADMIN_DYNAMIC_JSON_HEADERS),
            error => {
              if (error instanceof BiographicalReviewError && error.reason === 'malformed') {
                appendAuditTimelineEntry?.(
                  'memory_mutation',
                  'denied',
                  'Biographical claim review rejected a malformed action.',
                  [`claimId=${claimId}`],
                  'operator',
                  context,
                );
              }
              sendReviewError(res, error);
            },
          );
        });
      },
    },
  ];
}
