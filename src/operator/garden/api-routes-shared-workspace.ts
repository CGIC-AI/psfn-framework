import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../../channels/backplane/http/primitives.js';
import { isRecord } from '../../shared/utils/types.js';
import { exactPath, paramWithSuffix } from './route-matchers.js';
import { parseAdminJsonBody } from './request-body.js';
import { parseRequestUrl } from './request-url.js';
import type { AdminApiRoute } from './routes/types.js';
import {
  SharedWorkspaceAuthenticationError,
  type AdminSharedWorkspaceService,
} from './services/shared-workspace-service.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sendActionError(res: ServerResponse, error: unknown): void {
  sendJson(res, error instanceof SharedWorkspaceAuthenticationError ? 401 : 400, {
    error: errorMessage(error),
  });
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every(key => allowedSet.has(key));
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
      handle: (req, res, _params, context) => options.withBody(req, res, (body) => {
        const parsed = parseAdminJsonBody(body);
        if (!parsed.ok || !isRecord(parsed.value)) {
          sendJson(res, 400, { error: parsed.ok ? 'Expected JSON object body' : parsed.error });
          return;
        }
        const value = parsed.value;
        if (!hasOnlyKeys(value, ['artifactPath', 'content', 'mediaType', 'provenance'])
          || typeof value.artifactPath !== 'string'
          || typeof value.content !== 'string'
          || (value.mediaType !== 'text/markdown'
            && value.mediaType !== 'text/plain'
            && value.mediaType !== 'application/json')
          || typeof value.provenance !== 'string') {
          sendJson(res, 400, {
            error: 'artifactPath, content, mediaType, and provenance are required; identity claims are forbidden',
          });
          return;
        }
        try {
          sendJson(res, 201, options.service.propose(context, {
            artifactPath: value.artifactPath,
            content: value.content,
            mediaType: value.mediaType,
            provenance: value.provenance,
          }));
        } catch (error) {
          sendActionError(res, error);
        }
      }),
    },
    {
      method: 'POST',
      match: paramWithSuffix('/api/admin/shared-workspace/reviews/', 'reviewId', '/cogsec'),
      handle: (req, res, { reviewId }, context) => options.withBody(req, res, (body) => {
        const parsed = parseAdminJsonBody(body);
        if (!parsed.ok || !isRecord(parsed.value)) {
          sendJson(res, 400, { error: parsed.ok ? 'Expected JSON object body' : parsed.error });
          return;
        }
        const value = parsed.value;
        if (!hasOnlyKeys(value, ['decision', 'note'])
          || (value.decision !== 'approved' && value.decision !== 'rejected')
          || (value.note !== undefined && typeof value.note !== 'string')) {
          sendJson(res, 400, {
            error: 'decision must be approved or rejected; note must be a string; identity claims are forbidden',
          });
          return;
        }
        try {
          sendJson(res, 201, options.service.recordCogSecDecision(
            context,
            {
              reviewId,
              decision: value.decision,
              ...(value.note ? { note: value.note } : {}),
            },
          ));
        } catch (error) {
          sendActionError(res, error);
        }
      }),
    },
    {
      method: 'POST',
      match: paramWithSuffix('/api/admin/shared-workspace/reviews/', 'reviewId', '/decision'),
      handle: (req, res, { reviewId }, context) => options.withBody(req, res, (body) => {
        const parsed = parseAdminJsonBody(body);
        if (!parsed.ok || !isRecord(parsed.value)) {
          sendJson(res, 400, { error: parsed.ok ? 'Expected JSON object body' : parsed.error });
          return;
        }
        const value = parsed.value;
        if (!hasOnlyKeys(value, ['decision', 'note'])
          || (value.decision !== 'approve' && value.decision !== 'reject')
          || (value.note !== undefined && typeof value.note !== 'string')) {
          sendJson(res, 400, {
            error: 'decision must be approve or reject; note must be a string; identity claims are forbidden',
          });
          return;
        }
        try {
          sendJson(res, 200, options.service.review(
            context,
            {
              reviewId,
              decision: value.decision,
              ...(value.note ? { note: value.note } : {}),
            },
          ));
        } catch (error) {
          sendActionError(res, error);
        }
      }),
    },
  ];
}
