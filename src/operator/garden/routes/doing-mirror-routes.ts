import { sendJson } from '../../../channels/backplane/http/primitives.js';
import {
  DOING_MIRROR_ITEM_TYPES,
  type DoingMirrorItemType,
  type DoingMirrorTransitionInput,
} from '../../../core/doing-mirror/contracts.js';
import { assertNoUnknownKeys, isRecord } from '../../../shared/utils/types.js';
import { parseAdminJsonBody } from '../request-body.js';
import { exactPath, nestedParamPath } from '../route-matchers.js';
import type { AdminDoingMirrorService } from '../services/types.js';
import { ADMIN_DYNAMIC_JSON_HEADERS, sendInternalError, toSanitizedMessage } from './shared.js';
import type {
  AdminApiRoute,
  AdminAuditTimelineAppender,
  AdminBodyReader,
} from './types.js';

const BOUNDARY = 'A disposition reports the Partner decision without mutating the source item or transferring decision authority. Every change carries exact Partner-authored Letter text.';
const TRANSITION_KEYS = ['state', 'reason', 'subject', 'body'] as const;

function parseItemType(value: string): DoingMirrorItemType {
  if (!DOING_MIRROR_ITEM_TYPES.some(itemType => itemType === value)) {
    throw new Error(`itemType must be one of: ${DOING_MIRROR_ITEM_TYPES.join(', ')}`);
  }
  return value as DoingMirrorItemType;
}

function parseTransition(
  itemType: string,
  itemId: string,
  value: unknown,
): DoingMirrorTransitionInput {
  if (!isRecord(value)) throw new Error('Doing-mirror transition payload must be a JSON object');
  assertNoUnknownKeys(value, TRANSITION_KEYS, 'Doing-mirror transition payload');
  if (value.state !== 'considering' && value.state !== 'done' && value.state !== 'declined') {
    throw new Error('state must be considering, done, or declined');
  }
  if (typeof value.subject !== 'string' || !value.subject.trim()) {
    throw new Error('subject must be a non-empty Partner-authored string');
  }
  if (typeof value.body !== 'string' || !value.body.trim()) {
    throw new Error('body must be a non-empty Partner-authored string');
  }
  if (value.reason !== undefined && (typeof value.reason !== 'string' || !value.reason.trim())) {
    throw new Error('reason must be a non-empty string when supplied');
  }
  if (value.state === 'declined' && (typeof value.reason !== 'string' || !value.reason.trim())) {
    throw new Error('declined disposition requires a reason');
  }
  return {
    itemType: parseItemType(itemType),
    itemId,
    state: value.state,
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
    subject: value.subject,
    body: value.body,
  };
}

export function buildAdminDoingMirrorRoutes(options: {
  doingMirrorService?: AdminDoingMirrorService | null;
  withBody: AdminBodyReader;
  appendAuditTimelineEntry?: AdminAuditTimelineAppender;
}): AdminApiRoute[] {
  const { doingMirrorService, withBody, appendAuditTimelineEntry } = options;
  return [
    {
      method: 'GET',
      match: exactPath('/api/admin/doing-mirror'),
      handle: (_req, res) => {
        if (!doingMirrorService) return void sendJson(res, 503, { error: 'Doing-mirror backend unavailable' });
        doingMirrorService.list().then(
          items => sendJson(res, 200, { items, boundary: BOUNDARY }, ADMIN_DYNAMIC_JSON_HEADERS),
          error => sendInternalError(res, error, 'Failed to list doing-mirror items'),
        );
      },
    },
    {
      method: 'POST',
      match: nestedParamPath('/api/admin/doing-mirror/', '/', 'itemType', 'itemId'),
      handle: (req, res, { itemType, itemId }) => {
        if (!doingMirrorService) return void sendJson(res, 503, { error: 'Doing-mirror backend unavailable' });
        if (!itemType || !itemId) return void sendJson(res, 400, { error: 'itemType and itemId are required' });
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) return void sendJson(res, 400, { error: parsed.error });
          let input: DoingMirrorTransitionInput;
          try {
            input = parseTransition(itemType, itemId, parsed.value);
          } catch (error) {
            return void sendJson(res, 400, { error: toSanitizedMessage(error, 'Invalid doing-mirror transition') });
          }
          doingMirrorService.transition(input).then(
            (item) => {
              appendAuditTimelineEntry?.(
                'external_action',
                'allowed',
                'Operator recorded a companion-visible disposition and authored its Letter.',
                [`itemType=${input.itemType}`, `itemId=${input.itemId}`, `state=${input.state}`],
                'operator',
              );
              sendJson(res, 200, { item, boundary: BOUNDARY }, ADMIN_DYNAMIC_JSON_HEADERS);
            },
            error => sendJson(res, 400, { error: toSanitizedMessage(error, 'Failed to change disposition') }),
          );
        });
      },
    },
  ];
}
