// ── Garden drift review card routes (htm9.14) ──
//
// The admin API for the Cognitive Security drift-review section:
//   GET  /api/admin/intake/drift-reviews              card list (open first)
//   GET  /api/admin/intake/drift-reviews/:id          full card (evidence)
//   POST /api/admin/intake/drift-reviews/:id/resolve  acknowledge / dismiss
//
// Every resolution attempt (allowed AND denied) writes a Garden audit-
// timeline entry with actor, decision, card id, and resolution. Resolving a
// card records the operator decision only — the drift lane never auto-
// mutates memories, trust, or emotion, and neither do these routes.

import { sendJson } from '../../../channels/backplane/http/primitives.js';
import { parseAdminJsonBody } from '../request-body.js';
import { exactPath, paramWithSuffix, prefixedParamPath } from '../route-matchers.js';
import { isRecord } from '../../../shared/utils/types.js';
import {
  DRIFT_REVIEW_CARD_RESOLUTIONS,
  isDriftReviewCardResolution,
  type AdminDriftReviewService,
  type DriftReviewCardResolution,
} from '../services/drift-review-service.js';
import type { AdminAuditDecision } from '../types.js';
import { ADMIN_DYNAMIC_JSON_HEADERS, toSanitizedMessage } from './shared.js';
import type { AdminApiRoute, AdminAuditTimelineAppender, AdminBodyReader } from './types.js';

const ADMIN_DRIFT_REVIEWS_API_PATH = '/api/admin/intake/drift-reviews';
const ADMIN_DRIFT_REVIEW_ITEM_PREFIX = `${ADMIN_DRIFT_REVIEWS_API_PATH}/`;

const MAX_NOTE_CHARS = 1024;

interface ParsedResolveBody {
  resolution: DriftReviewCardResolution;
  note?: string;
}

function parseResolveBody(
  value: unknown,
): { ok: true; value: ParsedResolveBody } | { ok: false; error: string } {
  if (!isRecord(value)) {
    return { ok: false, error: 'Body must be a JSON object' };
  }
  const allowedKeys = ['resolution', 'note'];
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unknownKeys.length > 0) {
    return { ok: false, error: `Unknown drift review resolution fields: ${unknownKeys.join(', ')}` };
  }
  if (!isDriftReviewCardResolution(value.resolution)) {
    return {
      ok: false,
      error: `resolution must be one of: ${DRIFT_REVIEW_CARD_RESOLUTIONS.join(', ')}`,
    };
  }
  if (value.note !== undefined
    && (typeof value.note !== 'string' || value.note.length > MAX_NOTE_CHARS)) {
    return {
      ok: false,
      error: `note must be a string of at most ${String(MAX_NOTE_CHARS)} characters`,
    };
  }
  return {
    ok: true,
    value: {
      resolution: value.resolution,
      ...(typeof value.note === 'string' ? { note: value.note } : {}),
    },
  };
}

export function buildAdminDriftReviewRoutes(options: {
  driftReviewService: AdminDriftReviewService;
  appendAuditTimelineEntry: AdminAuditTimelineAppender | undefined;
  withBody: AdminBodyReader;
}): AdminApiRoute[] {
  const { driftReviewService, appendAuditTimelineEntry, withBody } = options;

  const appendDriftAudit = (
    decision: AdminAuditDecision,
    narrative: string,
    details: Array<string | null | undefined> = [],
  ): void => {
    appendAuditTimelineEntry?.('gateway_policy', decision, narrative, details, 'operator');
  };

  return [
    {
      method: 'GET',
      match: exactPath(ADMIN_DRIFT_REVIEWS_API_PATH),
      handle: (_req, res) => {
        try {
          sendJson(res, 200, driftReviewService.listCards(), ADMIN_DYNAMIC_JSON_HEADERS);
        } catch (error) {
          sendJson(res, 500, {
            error: toSanitizedMessage(error, 'Failed to load drift review cards'),
          });
        }
      },
    },
    {
      method: 'GET',
      match: prefixedParamPath(ADMIN_DRIFT_REVIEW_ITEM_PREFIX, 'id', {
        exclude: (path) => path.endsWith('/resolve'),
      }),
      handle: (_req, res, { id }) => {
        try {
          const card = driftReviewService.getCard(id);
          if (!card) {
            sendJson(res, 404, { error: 'Drift review card not found' });
            return;
          }
          sendJson(res, 200, { card }, ADMIN_DYNAMIC_JSON_HEADERS);
        } catch (error) {
          sendJson(res, 500, {
            error: toSanitizedMessage(error, 'Failed to load drift review card'),
          });
        }
      },
    },
    {
      method: 'POST',
      match: paramWithSuffix(ADMIN_DRIFT_REVIEW_ITEM_PREFIX, 'id', '/resolve'),
      handle: (req, res, { id }) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            appendDriftAudit(
              'denied',
              'Operator drift review resolution failed: invalid JSON payload.',
              [`cardId=${id}`],
            );
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const input = parseResolveBody(parsed.value);
          if (!input.ok) {
            appendDriftAudit(
              'denied',
              'Operator drift review resolution failed: invalid fields.',
              [`cardId=${id}`, `error=${input.error}`],
            );
            sendJson(res, 400, { error: input.error });
            return;
          }
          try {
            const result = driftReviewService.resolveCard({
              id,
              resolution: input.value.resolution,
              ...(input.value.note !== undefined ? { note: input.value.note } : {}),
            });
            if (!result.ok) {
              appendDriftAudit(
                'denied',
                'Operator drift review resolution was refused.',
                [
                  `cardId=${id}`,
                  `resolution=${input.value.resolution}`,
                  `message=${toSanitizedMessage(result.message, 'refused')}`,
                ],
              );
              sendJson(res, result.status, { error: result.message });
              return;
            }
            appendDriftAudit(
              'allowed',
              `Operator ${input.value.resolution} a drift review card.`,
              [
                `cardId=${id}`,
                `contactId=${result.card.contactId}`,
                `resolution=${input.value.resolution}`,
                `triggeredSignals=${result.card.triggeredSignalIds.join('+')}`,
              ],
            );
            sendJson(res, 200, { ok: true, card: result.card }, ADMIN_DYNAMIC_JSON_HEADERS);
          } catch (error) {
            appendDriftAudit(
              'denied',
              'Operator drift review resolution failed with a server error.',
              [`cardId=${id}`, `error=${toSanitizedMessage(error, 'server error')}`],
            );
            sendJson(res, 500, {
              error: toSanitizedMessage(error, 'Failed to resolve drift review card'),
            });
          }
        });
      },
    },
  ];
}
