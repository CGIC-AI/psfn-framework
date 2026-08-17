import type { IncomingMessage } from 'node:http';
import { sendCompressedJson, sendJson } from '../../../channels/backplane/http/primitives.js';
import { exactPath, nestedParamPath, prefixedParamPath, wrappedParamPath } from '../route-matchers.js';
import { isRecord } from '../../../shared/utils/types.js';
import { parseAdminJsonBody } from '../request-body.js';
import type {
  AdminCogSecRemediationInput,
  AdminSessionRouteResetInput,
  AdminSessionService,
} from '../services/types.js';
import {
  AdminSessionNotFoundError,
  AdminSessionTurnNotFoundError,
  MAX_ADMIN_SESSION_MESSAGE_PAGE_LIMIT,
  MAX_ADMIN_SESSION_SEARCH_LIMIT,
} from '../services/session-service.js';
import { parseRequestUrl } from '../request-url.js';
import {
  parsePositiveIntegerQueryParam,
  sendInternalError,
  toSanitizedMessage,
} from './shared.js';
import type { AdminApiRoute, AdminBodyReader } from './types.js';
import type { GardenRequestContext } from '../garden-request-context.js';

interface ParsedSessionMessageQuery {
  limit?: number;
  beforeId?: number;
  messagesOnly?: boolean;
  includeTurns?: boolean;
}

function parseBooleanParam(
  params: URLSearchParams,
  name: string,
): { ok: true; value?: boolean } | { ok: false; error: string } {
  const raw = params.get(name);
  if (raw === null || raw === '') return { ok: true };
  if (raw === 'true' || raw === '1') return { ok: true, value: true };
  if (raw === 'false' || raw === '0') return { ok: true, value: false };
  return { ok: false, error: `${name} must be a boolean` };
}

function parseSessionMessageQuery(req: IncomingMessage):
  | { ok: true; value: ParsedSessionMessageQuery }
  | { ok: false; error: string } {
  const params = parseRequestUrl(req).searchParams;
  const limit = parsePositiveIntegerQueryParam(params, 'limit', {
    max: MAX_ADMIN_SESSION_MESSAGE_PAGE_LIMIT,
  });
  if (!limit.ok) return limit;
  const beforeId = parsePositiveIntegerQueryParam(params, 'beforeId');
  if (!beforeId.ok) return beforeId;
  const messagesOnly = parseBooleanParam(params, 'messagesOnly');
  if (!messagesOnly.ok) return messagesOnly;
  const includeTurns = parseBooleanParam(params, 'includeTurns');
  if (!includeTurns.ok) return includeTurns;
  return {
    ok: true,
    value: {
      ...(limit.value !== undefined ? { limit: limit.value } : {}),
      ...(beforeId.value !== undefined ? { beforeId: beforeId.value } : {}),
      ...(messagesOnly.value !== undefined ? { messagesOnly: messagesOnly.value } : {}),
      ...(includeTurns.value !== undefined ? { includeTurns: includeTurns.value } : {}),
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
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
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
    const sourceMessageIds = parseOptionalStringArray(item.sourceMessageIds, `affectedMessageRanges[${index}].sourceMessageIds`);
    return {
      ...(sourceChannelId ? { sourceChannelId } : {}),
      ...(logicalSessionId ? { logicalSessionId } : {}),
      ...(startEntryId !== undefined ? { startEntryId } : {}),
      ...(endEntryId !== undefined ? { endEntryId } : {}),
      ...(messageIds ? { messageIds } : {}),
      ...(sourceMessageIds ? { sourceMessageIds } : {}),
      ...(discordMessageIds ? { discordMessageIds } : {}),
    };
  });
}

function requestActor(context: GardenRequestContext | undefined): string {
  return context?.kind === 'fleet_principal'
    ? `fleet-principal:${context.actor.principalId}`
    : 'standalone-token:operator';
}

function parseSessionRouteResetInput(
  value: unknown,
  context: GardenRequestContext | undefined,
): AdminSessionRouteResetInput {
  if (!isRecord(value)) {
    throw new Error('Request body must be a JSON object');
  }
  parseOptionalString(value.actor, 'actor');
  const mode = parseResetMode(value.mode);
  return {
    sourceChannelId: parseRequiredString(value.sourceChannelId, 'sourceChannelId'),
    reason: parseRequiredString(value.reason, 'reason'),
    actor: requestActor(context),
    ...(mode ? { mode } : {}),
  };
}

function parseCogSecInput(
  value: unknown,
  context: GardenRequestContext | undefined,
): AdminCogSecRemediationInput {
  if (!isRecord(value)) {
    throw new Error('Request body must be a JSON object');
  }
  parseOptionalString(value.actor, 'actor');
  const caseId = parseOptionalString(value.caseId, 'caseId');
  const affectedLogicalSessionIds = parseOptionalStringArray(value.affectedLogicalSessionIds, 'affectedLogicalSessionIds');
  const affectedMessageRanges = parseCogSecRanges(value.affectedMessageRanges);
  const messageIds = parseOptionalNumberArray(value.messageIds, 'messageIds');
  const sourceMessageIds = parseOptionalStringArray(value.sourceMessageIds, 'sourceMessageIds');
  const startEntryId = parseOptionalPositiveInteger(value.startEntryId, 'startEntryId');
  const endEntryId = parseOptionalPositiveInteger(value.endEntryId, 'endEntryId');
  const cutEpoch = parseOptionalBoolean(value.cutEpoch, 'cutEpoch');
  return {
    ...(caseId ? { caseId } : {}),
    sourceChannelId: parseRequiredString(value.sourceChannelId, 'sourceChannelId'),
    ...(affectedLogicalSessionIds ? { affectedLogicalSessionIds } : {}),
    ...(affectedMessageRanges ? { affectedMessageRanges } : {}),
    ...(messageIds ? { messageIds } : {}),
    ...(sourceMessageIds ? { sourceMessageIds } : {}),
    ...(startEntryId !== undefined ? { startEntryId } : {}),
    ...(endEntryId !== undefined ? { endEntryId } : {}),
    type: parseRequiredString(value.type, 'type') as AdminCogSecRemediationInput['type'],
    severity: parseRequiredString(value.severity, 'severity') as AdminCogSecRemediationInput['severity'],
    reason: parseRequiredString(value.reason, 'reason'),
    actor: requestActor(context),
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
      handle: (_req, res, _params, context) => {
        (context ? sessionService.listSessions(context) : sessionService.listSessions()).then(
          (payload) => {
            sendJson(res, 200, payload);
          },
          (error) => {
            sendInternalError(res, error, 'Failed to load sessions');
          },
        );
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/admin/session-routes'),
      handle: (_req, res, _params, context) => {
        (context ? sessionService.listSessionRoutes(context) : sessionService.listSessionRoutes()).then(
          payload => sendJson(res, 200, payload),
          error => sendInternalError(res, error, 'Failed to load session routes'),
        );
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/admin/session-routes/reset'),
      handle: (req, res, _params, context) => {
        withBody(req, res, (body) => {
          const parsedBody = parseAdminJsonBody(body);
          if (!parsedBody.ok) {
            sendJson(res, 400, { ok: false, message: parsedBody.error });
            return;
          }
          let input: AdminSessionRouteResetInput;
          try {
            input = parseSessionRouteResetInput(parsedBody.value, context);
          } catch (error) {
            sendJson(res, 400, {
              ok: false,
              message: error instanceof Error ? error.message : String(error),
            });
            return;
          }
          (context
            ? sessionService.resetSourceChannelSession(input, context)
            : sessionService.resetSourceChannelSession(input)).then(
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
      handle: (_req, res, _params, context) => {
        (context ? sessionService.listCogSecEvents(context) : sessionService.listCogSecEvents()).then(
          payload => sendJson(res, 200, payload),
          error => sendInternalError(res, error, 'Failed to load CogSec events'),
        );
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/admin/session-routes/cogsec/preview'),
      handle: (req, res, _params, context) => {
        withBody(req, res, (body) => {
          const parsedBody = parseAdminJsonBody(body);
          if (!parsedBody.ok) {
            sendJson(res, 400, { ok: false, message: parsedBody.error });
            return;
          }
          let input: AdminCogSecRemediationInput;
          try {
            input = parseCogSecInput(parsedBody.value, context);
          } catch (error) {
            sendJson(res, 400, {
              ok: false,
              message: error instanceof Error ? error.message : String(error),
            });
            return;
          }
          (context
            ? sessionService.previewCogSecRemediation(input, context)
            : sessionService.previewCogSecRemediation(input)).then(
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
      handle: (req, res, _params, context) => {
        withBody(req, res, (body) => {
          const parsedBody = parseAdminJsonBody(body);
          if (!parsedBody.ok) {
            sendJson(res, 400, { ok: false, message: parsedBody.error });
            return;
          }
          let input: AdminCogSecRemediationInput;
          try {
            input = parseCogSecInput(parsedBody.value, context);
          } catch (error) {
            sendJson(res, 400, {
              ok: false,
              message: error instanceof Error ? error.message : String(error),
            });
            return;
          }
          (context
            ? sessionService.applyCogSecRemediation(input, context)
            : sessionService.applyCogSecRemediation(input)).then(
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
      match: wrappedParamPath('/api/admin/sessions/', '/search', 'channelId'),
      handle: (req, res, { channelId }, context) => {
        if (!channelId) {
          sendJson(res, 400, { error: 'channelId is required' });
          return;
        }
        const params = parseRequestUrl(req).searchParams;
        const query = params.get('q')?.trim() ?? '';
        if (!query) {
          sendJson(res, 400, { error: 'q is required' });
          return;
        }
        const limit = parsePositiveIntegerQueryParam(params, 'limit', {
          max: MAX_ADMIN_SESSION_SEARCH_LIMIT,
        });
        if (!limit.ok) {
          sendJson(res, 400, { error: limit.error });
          return;
        }
        (context
          ? sessionService.searchSessionMessages(channelId, query, limit.value, context)
          : sessionService.searchSessionMessages(channelId, query, limit.value)).then(
          payload => sendJson(res, 200, payload),
          error => sendInternalError(res, error, 'Failed to search session messages'),
        );
      },
    },
    {
      // Contact/link detail is intentionally absent from the session index.
      // Resolve it only after the operator selects one concrete session.
      method: 'GET',
      match: wrappedParamPath('/api/admin/sessions/', '/detail', 'channelId'),
      handle: (req, res, { channelId }, context) => {
        if (!channelId) {
          sendJson(res, 400, { error: 'channelId is required' });
          return;
        }
        (context
          ? sessionService.getSessionDetail(channelId, context)
          : sessionService.getSessionDetail(channelId)).then(
          payload => sendCompressedJson(req, res, 200, payload),
          (error) => {
            if (error instanceof AdminSessionNotFoundError) {
              sendJson(res, 404, { error: error.message });
              return;
            }
            sendInternalError(res, error, 'Failed to load session detail');
          },
        );
      },
    },
    {
      // Per-turn lazy detail: matched before the generic session route so
      // `.../turns/<turnId>` resolves to a single bounded turn snapshot instead
      // of being swallowed as a channelId.
      method: 'GET',
      match: nestedParamPath('/api/admin/sessions/', '/turns/', 'channelId', 'turnId'),
      handle: (req, res, { channelId, turnId }, context) => {
        if (!channelId || !turnId) {
          sendJson(res, 400, { error: 'channelId and turnId are required' });
          return;
        }
        (context
          ? sessionService.getSessionTurnDetail(channelId, turnId, context)
          : sessionService.getSessionTurnDetail(channelId, turnId)).then(
          payload => sendCompressedJson(req, res, 200, payload),
          (error) => {
            if (error instanceof AdminSessionTurnNotFoundError) {
              sendJson(res, 404, { error: error.message });
              return;
            }
            sendInternalError(res, error, 'Failed to load turn detail');
          },
        );
      },
    },
    {
      method: 'GET',
      match: prefixedParamPath('/api/admin/sessions/', 'channelId'),
      handle: (req, res, { channelId }, context) => {
        if (!channelId) {
          sendJson(res, 400, { error: 'channelId is required' });
          return;
        }
        const parsed = parseSessionMessageQuery(req);
        if (!parsed.ok) {
          sendJson(res, 400, { error: parsed.error });
          return;
        }
        (context
          ? sessionService.getSessionMessagesForAdminRead(channelId, parsed.value, context)
          : sessionService.getSessionMessagesForAdminRead(channelId, parsed.value)).then(
          payload => sendCompressedJson(req, res, 200, payload),
          error => sendInternalError(res, error, 'Failed to load session messages'),
        );
      },
    },
  ];
}
