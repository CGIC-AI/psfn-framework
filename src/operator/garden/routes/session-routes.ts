import type { IncomingMessage } from 'node:http';
import { sendCompressedJson, sendJson } from '../../../channels/backplane/http/primitives.js';
import { exactPath, prefixedParamPath } from '../route-matchers.js';
import { isRecord } from '../../../shared/utils/types.js';
import { parseAdminJsonBody } from '../request-body.js';
import type {
  AdminCogSecRemediationInput,
  AdminSessionRouteResetInput,
  AdminSessionService,
} from '../services/types.js';
import { MAX_ADMIN_SESSION_MESSAGE_PAGE_LIMIT } from '../services/session-service.js';
import { parseRequestUrl } from '../request-url.js';
import { toSanitizedMessage } from './shared.js';
import type { AdminApiRoute, AdminBodyReader } from './types.js';

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

function parseOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string`);
  }
  const normalized = value.trim();
  return normalized || undefined;
}

function parseRequiredString(value: unknown, field: string): string {
  const normalized = parseOptionalString(value, field);
  if (!normalized) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return normalized;
}

function parseResetMode(value: unknown): AdminSessionRouteResetInput['mode'] {
  if (value === undefined) return undefined;
  if (value === 'fresh_split' || value === 'break_glass_quarantine') return value;
  throw new Error('mode must be fresh_split or break_glass_quarantine');
}

function parseOptionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function parseRequiredPositiveInteger(value: unknown, field: string): number {
  const parsed = parseOptionalPositiveInteger(value, field);
  if (parsed === undefined) {
    throw new Error(`${field} must be a positive integer`);
  }
  return parsed;
}

function parseOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`${field} must be a boolean`);
  }
  return value;
}

function parseOptionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  const values = value
    .map((item, index) => parseRequiredString(item, `${field}[${index}]`));
  return values.length > 0 ? values : undefined;
}

function parseOptionalNumberArray(value: unknown, field: string): number[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  const values = value
    .map((item, index) => parseRequiredPositiveInteger(item, `${field}[${index}]`));
  return values.length > 0 ? values : undefined;
}

function parseCogSecRanges(value: unknown): AdminCogSecRemediationInput['affectedMessageRanges'] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error('affectedMessageRanges must be an array');
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`affectedMessageRanges[${index}] must be an object`);
    }
    const sourceChannelId = parseOptionalString(item.sourceChannelId, `affectedMessageRanges[${index}].sourceChannelId`);
    const logicalSessionId = parseOptionalString(item.logicalSessionId, `affectedMessageRanges[${index}].logicalSessionId`);
    const startEntryId = parseOptionalPositiveInteger(item.startEntryId, `affectedMessageRanges[${index}].startEntryId`);
    const endEntryId = parseOptionalPositiveInteger(item.endEntryId, `affectedMessageRanges[${index}].endEntryId`);
    const messageIds = parseOptionalNumberArray(item.messageIds, `affectedMessageRanges[${index}].messageIds`);
    const discordMessageIds = parseOptionalStringArray(item.discordMessageIds, `affectedMessageRanges[${index}].discordMessageIds`);
    return {
      ...(sourceChannelId ? { sourceChannelId } : {}),
      ...(logicalSessionId ? { logicalSessionId } : {}),
      ...(startEntryId !== undefined ? { startEntryId } : {}),
      ...(endEntryId !== undefined ? { endEntryId } : {}),
      ...(messageIds ? { messageIds } : {}),
      ...(discordMessageIds ? { discordMessageIds } : {}),
    };
  });
}

function parseSessionRouteResetInput(value: unknown): AdminSessionRouteResetInput {
  if (!isRecord(value)) {
    throw new Error('Request body must be a JSON object');
  }
  const actor = parseOptionalString(value.actor, 'actor');
  const mode = parseResetMode(value.mode);
  return {
    sourceChannelId: parseRequiredString(value.sourceChannelId, 'sourceChannelId'),
    reason: parseRequiredString(value.reason, 'reason'),
    ...(actor ? { actor } : {}),
    ...(mode ? { mode } : {}),
  };
}

function parseCogSecInput(value: unknown): AdminCogSecRemediationInput {
  if (!isRecord(value)) {
    throw new Error('Request body must be a JSON object');
  }
  const actor = parseOptionalString(value.actor, 'actor');
  const caseId = parseOptionalString(value.caseId, 'caseId');
  const affectedLogicalSessionIds = parseOptionalStringArray(value.affectedLogicalSessionIds, 'affectedLogicalSessionIds');
  const affectedMessageRanges = parseCogSecRanges(value.affectedMessageRanges);
  const messageIds = parseOptionalNumberArray(value.messageIds, 'messageIds');
  const startEntryId = parseOptionalPositiveInteger(value.startEntryId, 'startEntryId');
  const endEntryId = parseOptionalPositiveInteger(value.endEntryId, 'endEntryId');
  const cutEpoch = parseOptionalBoolean(value.cutEpoch, 'cutEpoch');
  return {
    ...(caseId ? { caseId } : {}),
    sourceChannelId: parseRequiredString(value.sourceChannelId, 'sourceChannelId'),
    ...(affectedLogicalSessionIds ? { affectedLogicalSessionIds } : {}),
    ...(affectedMessageRanges ? { affectedMessageRanges } : {}),
    ...(messageIds ? { messageIds } : {}),
    ...(startEntryId !== undefined ? { startEntryId } : {}),
    ...(endEntryId !== undefined ? { endEntryId } : {}),
    type: parseRequiredString(value.type, 'type') as AdminCogSecRemediationInput['type'],
    severity: parseRequiredString(value.severity, 'severity') as AdminCogSecRemediationInput['severity'],
    reason: parseRequiredString(value.reason, 'reason'),
    ...(actor ? { actor } : {}),
    ...(cutEpoch !== undefined ? { cutEpoch } : {}),
  };
}

export function buildAdminSessionRoutes(options: {
  sessionService: AdminSessionService;
  withBody: AdminBodyReader;
}): AdminApiRoute[] {
  const { sessionService, withBody } = options;

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
      match: exactPath('/api/admin/session-routes'),
      handle: (_req, res) => {
        sessionService.listSessionRoutes().then(
          payload => sendJson(res, 200, payload),
          error => sendJson(res, 500, {
            error: toSanitizedMessage(error, 'Failed to load session routes'),
          }),
        );
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/admin/session-routes/reset'),
      handle: (req, res) => {
        withBody(req, res, (body) => {
          const parsedBody = parseAdminJsonBody(body);
          if (!parsedBody.ok) {
            sendJson(res, 400, { ok: false, message: parsedBody.error });
            return;
          }
          let input: AdminSessionRouteResetInput;
          try {
            input = parseSessionRouteResetInput(parsedBody.value);
          } catch (error) {
            sendJson(res, 400, {
              ok: false,
              message: error instanceof Error ? error.message : String(error),
            });
            return;
          }
          sessionService.resetSourceChannelSession(input).then(
            payload => sendJson(res, 200, payload),
            error => sendJson(res, 500, {
              ok: false,
              message: toSanitizedMessage(error, 'Failed to reset session route'),
            }),
          );
        });
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/admin/session-routes/cogsec/events'),
      handle: (_req, res) => {
        sessionService.listCogSecEvents().then(
          payload => sendJson(res, 200, payload),
          error => sendJson(res, 500, {
            error: toSanitizedMessage(error, 'Failed to load CogSec events'),
          }),
        );
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/admin/session-routes/cogsec/preview'),
      handle: (req, res) => {
        withBody(req, res, (body) => {
          const parsedBody = parseAdminJsonBody(body);
          if (!parsedBody.ok) {
            sendJson(res, 400, { ok: false, message: parsedBody.error });
            return;
          }
          let input: AdminCogSecRemediationInput;
          try {
            input = parseCogSecInput(parsedBody.value);
          } catch (error) {
            sendJson(res, 400, {
              ok: false,
              message: error instanceof Error ? error.message : String(error),
            });
            return;
          }
          sessionService.previewCogSecRemediation(input).then(
            payload => sendJson(res, 200, payload),
            error => sendJson(res, 500, {
              ok: false,
              message: toSanitizedMessage(error, 'Failed to preview CogSec remediation'),
            }),
          );
        });
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/admin/session-routes/cogsec/apply'),
      handle: (req, res) => {
        withBody(req, res, (body) => {
          const parsedBody = parseAdminJsonBody(body);
          if (!parsedBody.ok) {
            sendJson(res, 400, { ok: false, message: parsedBody.error });
            return;
          }
          let input: AdminCogSecRemediationInput;
          try {
            input = parseCogSecInput(parsedBody.value);
          } catch (error) {
            sendJson(res, 400, {
              ok: false,
              message: error instanceof Error ? error.message : String(error),
            });
            return;
          }
          sessionService.applyCogSecRemediation(input).then(
            payload => sendJson(res, 200, payload),
            error => sendJson(res, 500, {
              ok: false,
              message: toSanitizedMessage(error, 'Failed to apply CogSec remediation'),
            }),
          );
        });
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
