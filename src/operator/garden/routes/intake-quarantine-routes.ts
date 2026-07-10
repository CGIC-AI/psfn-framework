// ── Garden intake quarantine + firewall-policy routes (htm9.11) ──
//
// The admin API for the Cognitive Security tab:
//   GET  /api/admin/intake/policy                  read-only intake-policy view
//   GET  /api/admin/intake/quarantine              approval queue (list)
//   GET  /api/admin/intake/quarantine/:id          full item detail
//   POST /api/admin/intake/quarantine/:id/confirm  step 1: issue confirm token
//   POST /api/admin/intake/quarantine/:id/decide   step 2: execute with token
//
// The double-confirm is enforced SERVER-SIDE by the service's confirm-token
// flow; these routes add fail-closed body validation and write a Garden
// audit-timeline entry for every confirmation request and every decision
// (allowed AND denied), with actor, decision, reason, envelope id, and
// content hash.

import { sendJson } from '../../../channels/backplane/http/primitives.js';
import { parseAdminJsonBody } from '../request-body.js';
import { exactPath, paramWithSuffix, prefixedParamPath } from '../route-matchers.js';
import { isRecord } from '../../../shared/utils/types.js';
import {
  INTAKE_QUARANTINE_DECISION_ACTIONS,
  type IntakeQuarantineDecisionAction,
} from '../../../core/cogsec/intake/quarantine-store.js';
import {
  isAdminIntakeQuarantineSourceListAction,
  INTAKE_QUARANTINE_SOURCE_LIST_ACTIONS,
  type AdminIntakeQuarantineService,
  type AdminIntakeQuarantineSourceListAction,
} from '../services/intake-quarantine-service.js';
import type { AdminSettingsService } from '../services/types.js';
import type { AdminAuditDecision } from '../types.js';
import { ADMIN_DYNAMIC_JSON_HEADERS, toSanitizedMessage } from './shared.js';
import type { AdminApiRoute, AdminAuditTimelineAppender, AdminBodyReader } from './types.js';

const ADMIN_INTAKE_POLICY_API_PATH = '/api/admin/intake/policy';
const ADMIN_INTAKE_QUARANTINE_API_PATH = '/api/admin/intake/quarantine';
const ADMIN_INTAKE_QUARANTINE_ITEM_PREFIX = `${ADMIN_INTAKE_QUARANTINE_API_PATH}/`;

const MAX_REASON_CHARS = 1024;
const MAX_TOKEN_CHARS = 128;

interface ParsedDecisionBody {
  action: IntakeQuarantineDecisionAction;
  sourceList?: AdminIntakeQuarantineSourceListAction;
  confirmToken?: string;
  reason?: string;
}

function parseDecisionBody(
  value: unknown,
  options: { requireToken: boolean },
): { ok: true; value: ParsedDecisionBody } | { ok: false; error: string } {
  if (!isRecord(value)) {
    return { ok: false, error: 'Body must be a JSON object' };
  }
  const allowedKeys = options.requireToken
    ? ['action', 'sourceList', 'confirmToken', 'reason']
    : ['action', 'sourceList'];
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unknownKeys.length > 0) {
    return { ok: false, error: `Unknown quarantine decision fields: ${unknownKeys.join(', ')}` };
  }
  if (typeof value.action !== 'string'
    || !(INTAKE_QUARANTINE_DECISION_ACTIONS as readonly string[]).includes(value.action)) {
    return {
      ok: false,
      error: `action must be one of: ${INTAKE_QUARANTINE_DECISION_ACTIONS.join(', ')}`,
    };
  }
  if (value.sourceList !== undefined && !isAdminIntakeQuarantineSourceListAction(value.sourceList)) {
    return {
      ok: false,
      error: `sourceList must be one of: ${INTAKE_QUARANTINE_SOURCE_LIST_ACTIONS.join(', ')}`,
    };
  }
  const parsed: ParsedDecisionBody = {
    action: value.action as IntakeQuarantineDecisionAction,
    ...(value.sourceList !== undefined
      ? { sourceList: value.sourceList as AdminIntakeQuarantineSourceListAction }
      : {}),
  };
  if (options.requireToken) {
    if (typeof value.confirmToken !== 'string'
      || !value.confirmToken.trim()
      || value.confirmToken.length > MAX_TOKEN_CHARS) {
      return { ok: false, error: 'confirmToken must be a non-empty string (request a confirmation first)' };
    }
    if (typeof value.reason !== 'string'
      || !value.reason.trim()
      || value.reason.length > MAX_REASON_CHARS) {
      return {
        ok: false,
        error: `reason must be a non-empty string of at most ${String(MAX_REASON_CHARS)} characters`,
      };
    }
    parsed.confirmToken = value.confirmToken.trim();
    parsed.reason = value.reason;
  }
  return { ok: true, value: parsed };
}

export function buildAdminIntakeQuarantineRoutes(options: {
  quarantineService: AdminIntakeQuarantineService;
  settingsService: AdminSettingsService;
  appendAuditTimelineEntry: AdminAuditTimelineAppender | undefined;
  withBody: AdminBodyReader;
}): AdminApiRoute[] {
  const { quarantineService, settingsService, appendAuditTimelineEntry, withBody } = options;

  const appendQuarantineAudit = (
    decision: AdminAuditDecision,
    narrative: string,
    details: Array<string | null | undefined> = [],
  ): void => {
    appendAuditTimelineEntry?.('gateway_policy', decision, narrative, details, 'operator');
  };

  return [
    {
      method: 'GET',
      match: exactPath(ADMIN_INTAKE_POLICY_API_PATH),
      handle: (_req, res) => {
        try {
          sendJson(
            res,
            200,
            { policy: settingsService.getIntakePolicyOverview() },
            ADMIN_DYNAMIC_JSON_HEADERS,
          );
        } catch (error) {
          sendJson(res, 500, {
            error: toSanitizedMessage(error, 'Failed to load intake policy'),
          });
        }
      },
    },
    {
      method: 'GET',
      match: exactPath(ADMIN_INTAKE_QUARANTINE_API_PATH),
      handle: (_req, res) => {
        try {
          sendJson(res, 200, quarantineService.listItems(), ADMIN_DYNAMIC_JSON_HEADERS);
        } catch (error) {
          sendJson(res, 500, {
            error: toSanitizedMessage(error, 'Failed to load quarantine queue'),
          });
        }
      },
    },
    {
      method: 'GET',
      match: prefixedParamPath(ADMIN_INTAKE_QUARANTINE_ITEM_PREFIX, 'id', {
        exclude: (path) => path.endsWith('/confirm') || path.endsWith('/decide'),
      }),
      handle: (_req, res, { id }) => {
        try {
          const item = quarantineService.getItem(id);
          if (!item) {
            sendJson(res, 404, { error: 'Quarantine item not found' });
            return;
          }
          sendJson(res, 200, { item }, ADMIN_DYNAMIC_JSON_HEADERS);
        } catch (error) {
          sendJson(res, 500, {
            error: toSanitizedMessage(error, 'Failed to load quarantine item'),
          });
        }
      },
    },
    {
      method: 'POST',
      match: paramWithSuffix(ADMIN_INTAKE_QUARANTINE_ITEM_PREFIX, 'id', '/confirm'),
      handle: (req, res, { id }) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            appendQuarantineAudit(
              'denied',
              'Operator quarantine confirmation failed: invalid JSON payload.',
              [`envelopeId=${id}`],
            );
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const input = parseDecisionBody(parsed.value, { requireToken: false });
          if (!input.ok) {
            appendQuarantineAudit(
              'denied',
              'Operator quarantine confirmation failed: invalid fields.',
              [`envelopeId=${id}`, `error=${input.error}`],
            );
            sendJson(res, 400, { error: input.error });
            return;
          }
          try {
            const result = quarantineService.beginDecision({
              id,
              action: input.value.action,
              ...(input.value.sourceList !== undefined
                ? { sourceList: input.value.sourceList }
                : {}),
            });
            if (!result.ok) {
              appendQuarantineAudit(
                'denied',
                'Operator quarantine confirmation was refused.',
                [`envelopeId=${id}`, `action=${input.value.action}`, `message=${toSanitizedMessage(result.message, 'refused')}`],
              );
              sendJson(res, result.status, { error: result.message });
              return;
            }
            appendQuarantineAudit(
              'needs_approval',
              'Operator requested a quarantine decision confirmation (step 1 of 2).',
              [
                `envelopeId=${id}`,
                `action=${input.value.action}`,
                input.value.sourceList ? `sourceList=${input.value.sourceList}` : null,
              ],
            );
            sendJson(res, 200, {
              ok: true,
              confirmToken: result.confirmToken,
              expiresAtMs: result.expiresAtMs,
              summary: result.summary,
            });
          } catch (error) {
            appendQuarantineAudit(
              'denied',
              'Operator quarantine confirmation failed with a server error.',
              [`envelopeId=${id}`, `error=${toSanitizedMessage(error, 'server error')}`],
            );
            sendJson(res, 500, {
              error: toSanitizedMessage(error, 'Failed to issue quarantine confirmation'),
            });
          }
        });
      },
    },
    {
      method: 'POST',
      match: paramWithSuffix(ADMIN_INTAKE_QUARANTINE_ITEM_PREFIX, 'id', '/decide'),
      handle: (req, res, { id }) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            appendQuarantineAudit(
              'denied',
              'Operator quarantine decision failed: invalid JSON payload.',
              [`envelopeId=${id}`],
            );
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const input = parseDecisionBody(parsed.value, { requireToken: true });
          if (!input.ok) {
            appendQuarantineAudit(
              'denied',
              'Operator quarantine decision failed: invalid fields.',
              [`envelopeId=${id}`, `error=${input.error}`],
            );
            sendJson(res, 400, { error: input.error });
            return;
          }
          try {
            const result = quarantineService.resolveDecision({
              id,
              action: input.value.action,
              ...(input.value.sourceList !== undefined
                ? { sourceList: input.value.sourceList }
                : {}),
              confirmToken: input.value.confirmToken ?? '',
              reason: input.value.reason ?? '',
            });
            if (!result.ok) {
              appendQuarantineAudit(
                'denied',
                'Operator quarantine decision was refused.',
                [
                  `envelopeId=${id}`,
                  `action=${input.value.action}`,
                  `message=${toSanitizedMessage(result.message, 'refused')}`,
                ],
              );
              sendJson(res, result.status, { error: result.message });
              return;
            }
            appendQuarantineAudit(
              'allowed',
              'Operator resolved a quarantined intake item via /api/admin/intake/quarantine (step 2 of 2).',
              [
                `envelopeId=${id}`,
                `action=${input.value.action}`,
                input.value.sourceList ? `sourceList=${input.value.sourceList}` : null,
                result.item.contentSha256 ? `sha256=${result.item.contentSha256}` : null,
                `cogSecCaseId=${result.cogSecCaseId}`,
                `reason=${toSanitizedMessage(input.value.reason, 'operator decision')}`,
              ],
            );
            sendJson(res, 200, { ok: true, item: result.item, message: result.message });
          } catch (error) {
            appendQuarantineAudit(
              'denied',
              'Operator quarantine decision failed with a server error.',
              [`envelopeId=${id}`, `error=${toSanitizedMessage(error, 'server error')}`],
            );
            sendJson(res, 500, {
              error: toSanitizedMessage(error, 'Failed to apply quarantine decision'),
            });
          }
        });
      },
    },
  ];
}
