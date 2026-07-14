import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../../channels/backplane/http/primitives.js';
import { isRecord } from '../../shared/utils/types.js';
import { exactPath, paramWithSuffix } from './route-matchers.js';
import { parseAdminJsonBody } from './request-body.js';
import { parseRequestUrl } from './request-url.js';
import type { AdminApiRoute } from './routes/types.js';
import type { AdminSharedWorkspaceService } from './services/shared-workspace-service.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function buildAdminSharedWorkspaceRoutes(options: {
  service: AdminSharedWorkspaceService;
  withBody: (req: IncomingMessage, res: ServerResponse, cb: (body: string) => void) => void;
}): AdminApiRoute[] {
  return [
    {
      method: 'GET',
      match: exactPath('/api/admin/shared-workspace'),
      handle: (_req, res) => {
        try {
          sendJson(res, 200, options.service.getSnapshot(), { 'Cache-Control': 'no-store' });
        } catch (error) {
          sendJson(res, 500, { error: errorMessage(error) });
        }
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/admin/shared-workspace/artifact'),
      handle: (req, res) => {
        const artifactPath = parseRequestUrl(req, '/api/admin/shared-workspace/artifact')
          .searchParams.get('path');
        if (!artifactPath) {
          sendJson(res, 400, { error: 'path query parameter is required' });
          return;
        }
        try {
          sendJson(res, 200, options.service.readArtifact(artifactPath), { 'Cache-Control': 'no-store' });
        } catch (error) {
          sendJson(res, 400, { error: errorMessage(error) });
        }
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/admin/shared-workspace/proposals'),
      handle: (req, res) => options.withBody(req, res, (body) => {
        const parsed = parseAdminJsonBody(body);
        if (!parsed.ok || !isRecord(parsed.value)) {
          sendJson(res, 400, { error: parsed.ok ? 'Expected JSON object body' : parsed.error });
          return;
        }
        const value = parsed.value;
        if (typeof value.artifactPath !== 'string'
          || typeof value.content !== 'string'
          || (value.mediaType !== 'text/markdown'
            && value.mediaType !== 'text/plain'
            && value.mediaType !== 'application/json')
          || typeof value.actorId !== 'string'
          || typeof value.provenance !== 'string') {
          sendJson(res, 400, {
            error: 'artifactPath, content, mediaType, actorId, and provenance are required',
          });
          return;
        }
        try {
          sendJson(res, 201, options.service.propose({
            artifactPath: value.artifactPath,
            content: value.content,
            mediaType: value.mediaType,
            actor: { id: value.actorId, role: 'operator' },
            provenance: value.provenance,
          }));
        } catch (error) {
          sendJson(res, 400, { error: errorMessage(error) });
        }
      }),
    },
    {
      method: 'POST',
      match: paramWithSuffix('/api/admin/shared-workspace/reviews/', 'reviewId', '/decision'),
      handle: (req, res, { reviewId }) => options.withBody(req, res, (body) => {
        const parsed = parseAdminJsonBody(body);
        if (!parsed.ok || !isRecord(parsed.value)) {
          sendJson(res, 400, { error: parsed.ok ? 'Expected JSON object body' : parsed.error });
          return;
        }
        const value = parsed.value;
        if (typeof value.reviewerId !== 'string'
          || (value.decision !== 'approve' && value.decision !== 'reject')
          || (value.cogSecDecision !== 'approved' && value.cogSecDecision !== 'rejected')
          || (value.note !== undefined && typeof value.note !== 'string')) {
          sendJson(res, 400, {
            error: 'reviewerId, decision, and cogSecDecision are required; note must be a string',
          });
          return;
        }
        try {
          sendJson(res, 200, options.service.review({
            reviewId,
            reviewer: { id: value.reviewerId, role: 'operator' },
            decision: value.decision,
            cogSecDecision: value.cogSecDecision,
            ...(value.note ? { note: value.note } : {}),
          }));
        } catch (error) {
          sendJson(res, 400, { error: errorMessage(error) });
        }
      }),
    },
  ];
}
