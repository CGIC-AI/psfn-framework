// ── Garden human escalation routes (bead psfn-framework-bznbn) ──
//
//   GET  /api/admin/escalations              open attention queue + state counts
//   POST /api/admin/escalations/:id/resolve  record what a human decided
//
// The read shares the confirmation queue's authority (`confirmations.read`) and
// the write shares its resolution authority (`confirmations.resolve`) rather
// than minting a parallel pair: this surface IS the governed generalisation of
// that queue's outer control plane, and an operator who may answer a
// confirmation is exactly the operator who may answer an escalation.
//
// Every field of the resolve body is validated against a closed vocabulary, so
// there is no path by which free text reaches the ledger. The narrative half of
// a decision — who, in their own words — is written to the Garden audit
// timeline, which already carries actor identity under its own retention.
//
// Its own route rather than a field on the incident snapshot, for the same
// reason the incident timeline is: this one reads Postgres, and folding it into
// an in-memory projection would let a ledger fault take down a page that would
// then have to fabricate a healthy-looking state to stay up.

import { sendJson } from '../../../channels/backplane/http/primitives.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { isRecord } from '../../../shared/utils/types.js';
import {
  HUMAN_ESCALATION_RESOLUTION_REASONS,
  HUMAN_ESCALATION_RESOLUTION_STATES,
  HUMAN_ESCALATION_STATES,
  isHumanEscalationResolutionReason,
  isHumanEscalationResolutionState,
  isHumanEscalationState,
  type HumanEscalationActor,
  type HumanEscalationResolutionReason,
  type HumanEscalationResolutionState,
  type HumanEscalationState,
} from '../../../shared/escalation/contracts.js';
import type {
  AdminHumanEscalationService,
} from '../services/human-escalation-service.js';
import { parseAdminJsonBody } from '../request-body.js';
import { exactPath, paramWithSuffix } from '../route-matchers.js';
import type { GardenRequestContext } from '../garden-request-context.js';
import {
  ADMIN_POLLED_QUEUE_JSON_HEADERS,
  sendInternalError,
  toSanitizedMessage,
} from './shared.js';
import type { AdminApiRoute, AdminAuditTimelineAppender, AdminBodyReader } from './types.js';

const log = createComponentLogger('AdminHumanEscalationRoutes');

const ADMIN_ESCALATIONS_API_PATH = '/api/admin/escalations';
const ADMIN_ESCALATION_ITEM_PREFIX = `${ADMIN_ESCALATIONS_API_PATH}/`;

interface ParsedResolveBody {
  state: HumanEscalationResolutionState;
  reason: HumanEscalationResolutionReason;
}

function parseResolveBody(
  value: unknown,
): { ok: true; value: ParsedResolveBody } | { ok: false; error: string } {
  if (!isRecord(value)) {
    return { ok: false, error: 'Body must be a JSON object' };
  }
  const unknownKeys = Object.keys(value).filter(key => key !== 'state' && key !== 'reason');
  if (unknownKeys.length > 0) {
    return { ok: false, error: `Unknown escalation resolution fields: ${unknownKeys.join(', ')}` };
  }
  if (!isHumanEscalationResolutionState(value.state)) {
    return {
      ok: false,
      error: `state must be one of: ${HUMAN_ESCALATION_RESOLUTION_STATES.join(', ')}`,
    };
  }
  if (!isHumanEscalationResolutionReason(value.reason)) {
    return {
      ok: false,
      error: `reason must be one of: ${HUMAN_ESCALATION_RESOLUTION_REASONS.join(', ')}`,
    };
  }
  return { ok: true, value: { state: value.state, reason: value.reason } };
}

/**
 * `?state=` filters the queue. Omitted means the open queue, because that is
 * the question this page exists to answer; `state=all` is the explicit way to
 * ask for history rather than a silently unbounded default.
 */
function parseStateFilter(
  raw: readonly string[] | undefined,
): { ok: true; value: readonly HumanEscalationState[] | undefined } | { ok: false; error: string } {
  if (!raw || raw.length === 0) return { ok: true, value: ['open'] };
  if (raw.length === 1 && raw[0] === 'all') return { ok: true, value: undefined };
  const states: HumanEscalationState[] = [];
  for (const entry of raw) {
    if (!isHumanEscalationState(entry)) {
      return {
        ok: false,
        error: `state must be "all" or one of: ${HUMAN_ESCALATION_STATES.join(', ')}`,
      };
    }
    if (!states.includes(entry)) states.push(entry);
  }
  return { ok: true, value: states };
}

/**
 * The actor CLASS recorded in the ledger. A fleet principal and a standalone
 * ADMIN_TOKEN / harness operator are different authorities and are recorded as
 * such; neither identity itself reaches the content-free ledger.
 */
function resolveActor(context: GardenRequestContext | undefined): HumanEscalationActor {
  return context?.kind === 'fleet_principal' ? 'fleet_principal' : 'operator';
}

export function buildAdminHumanEscalationRoutes(options: {
  escalations?: AdminHumanEscalationService | null;
  withBody: AdminBodyReader;
  appendAuditTimelineEntry: AdminAuditTimelineAppender | undefined;
}): AdminApiRoute[] {
  const { escalations, withBody, appendAuditTimelineEntry } = options;

  return [
    {
      method: 'GET',
      match: exactPath(ADMIN_ESCALATIONS_API_PATH),
      handle: (req, res) => {
        if (!escalations) {
          sendJson(res, 503, { error: 'Human escalation ledger unavailable' });
          return;
        }
        const query = new URL(req.url ?? '', 'http://localhost').searchParams;
        const states = parseStateFilter(query.getAll('state'));
        if (!states.ok) {
          sendJson(res, 400, { error: states.error });
          return;
        }
        void escalations.getSnapshot(states.value)
          .then(snapshot => sendJson(res, 200, snapshot, ADMIN_POLLED_QUEUE_JSON_HEADERS))
          .catch((error: unknown) => {
            log.error('Human escalation snapshot failed', { error: String(error) });
            sendJson(res, 503, { error: 'Human escalation ledger unavailable' });
          });
      },
    },
    {
      method: 'POST',
      match: paramWithSuffix(ADMIN_ESCALATION_ITEM_PREFIX, 'id', '/resolve'),
      handle: (req, res, { id }, context) => {
        if (!escalations) {
          sendJson(res, 503, { error: 'Human escalation ledger unavailable' });
          return;
        }
        if (!id) {
          sendJson(res, 400, { error: 'id is required' });
          return;
        }
        const appendAudit = (
          decision: 'allowed' | 'denied',
          narrative: string,
          details: Array<string | null | undefined>,
        ): void => {
          appendAuditTimelineEntry?.(
            'gateway_policy', decision, narrative, details, 'operator', context,
          );
        };
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            appendAudit('denied', 'Operator escalation resolution failed: invalid JSON payload.', [
              `escalationId=${id}`,
            ]);
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const input = parseResolveBody(parsed.value);
          if (!input.ok) {
            appendAudit('denied', 'Operator escalation resolution failed: invalid fields.', [
              `escalationId=${id}`,
              `error=${input.error}`,
            ]);
            sendJson(res, 400, { error: input.error });
            return;
          }
          void escalations.resolve({
            escalationId: id,
            state: input.value.state,
            reason: input.value.reason,
            actor: resolveActor(context),
          }).then((result) => {
            if (!result.ok) {
              appendAudit('denied', 'Operator escalation resolution was refused.', [
                `escalationId=${id}`,
                `state=${input.value.state}`,
                `message=${toSanitizedMessage(result.error, 'refused')}`,
              ]);
              sendJson(res, result.status, { error: result.error });
              return;
            }
            appendAudit('allowed', 'Operator resolved a human escalation.', [
              `escalationId=${id}`,
              `kind=${result.record.kind}`,
              `state=${result.record.state}`,
              `reason=${input.value.reason}`,
            ]);
            sendJson(res, 200, { ok: true, escalation: result.record });
          }).catch((error: unknown) => {
            appendAudit('denied', 'Operator escalation resolution failed with a server error.', [
              `escalationId=${id}`,
              `error=${toSanitizedMessage(error, 'server error')}`,
            ]);
            sendInternalError(res, error, 'Failed to record the escalation resolution');
          });
        });
      },
    },
  ];
}
