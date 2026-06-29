import type { IncomingMessage } from 'node:http';
import { sendCompressedJson, sendJson } from '../../../channels/backplane/http/primitives.js';
import { exactPath, prefixedParamPath } from '../route-matchers.js';
import type { AdminSessionService } from '../services/types.js';
import { MAX_ADMIN_SESSION_MESSAGE_PAGE_LIMIT } from '../services/session-service.js';
import { parseRequestUrl } from '../request-url.js';
import { toSanitizedMessage } from './shared.js';
import type { AdminApiRoute } from './types.js';

interface ParsedSessionMessageQuery {
  limit?: number;
  beforeId?: number;
}

function parsePositiveIntegerParam(
  params: URLSearchParams,
  name: string,
  max?: number,
): { ok: true; value?: number } | { ok: false; error: string } {
  const raw = params.get(name);
  if (raw === null || raw === '') return { ok: true };
  if (!/^\d+$/.test(raw)) {
    return { ok: false, error: `${name} must be a positive integer` };
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    return { ok: false, error: `${name} must be a positive integer` };
  }
  if (max !== undefined && value > max) {
    return { ok: false, error: `${name} must be <= ${max}` };
  }
  return { ok: true, value };
}

function parseSessionMessageQuery(req: IncomingMessage):
  | { ok: true; value: ParsedSessionMessageQuery }
  | { ok: false; error: string } {
  const params = parseRequestUrl(req).searchParams;
  const limit = parsePositiveIntegerParam(params, 'limit', MAX_ADMIN_SESSION_MESSAGE_PAGE_LIMIT);
  if (!limit.ok) return limit;
  const beforeId = parsePositiveIntegerParam(params, 'beforeId');
  if (!beforeId.ok) return beforeId;
  return {
    ok: true,
    value: {
      ...(limit.value !== undefined ? { limit: limit.value } : {}),
      ...(beforeId.value !== undefined ? { beforeId: beforeId.value } : {}),
    },
  };
}

export function buildAdminSessionRoutes(options: {
  sessionService: AdminSessionService;
}): AdminApiRoute[] {
  const { sessionService } = options;

  return [
    {
      method: 'GET',
      match: exactPath('/api/admin/sessions'),
      handle: (_req, res) => {
        sessionService.listSessions().then(
          (payload) => {
            sendJson(res, 200, payload);
          },
          (error) => {
            sendJson(res, 500, {
              error: toSanitizedMessage(error, 'Failed to load sessions'),
            });
          },
        );
      },
    },
    {
      method: 'GET',
      match: prefixedParamPath('/api/admin/sessions/', 'channelId'),
      handle: (req, res, { channelId }) => {
        const parsed = parseSessionMessageQuery(req);
        if (!parsed.ok) {
          sendJson(res, 400, { error: parsed.error });
          return;
        }
        sendCompressedJson(req, res, 200, sessionService.getSessionMessages(channelId, parsed.value));
      },
    },
  ];
}
