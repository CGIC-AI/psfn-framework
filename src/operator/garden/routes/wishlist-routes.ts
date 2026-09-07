import { sendJson } from '../../../channels/backplane/http/primitives.js';
import type { BeadsIssueType } from '../../../boundary/gateway/protocol.js';
import { assertNoUnknownKeys, isRecord } from '../../../shared/utils/types.js';
import { parseAdminJsonBody } from '../request-body.js';
import { exactPath, paramWithSuffix } from '../route-matchers.js';
import type {
  AdminWishlistConvertInput,
  AdminWishlistDispositionLetter,
  AdminWishlistService,
} from '../services/types.js';
import { ADMIN_DYNAMIC_JSON_HEADERS, sendInternalError, toSanitizedMessage } from './shared.js';
import type {
  AdminApiRoute,
  AdminAuditTimelineAppender,
  AdminBodyReader,
} from './types.js';

const WISHLIST_UNAVAILABLE_ERROR = 'Wishlist backend unavailable';
// psfn-framework-p4rmp: every wishlist action that moves the doing-mirror
// disposition carries the exact Partner-authored Letter text; machinery never
// invents it. The fields are optional here because a repeat action that changes
// nothing writes no Letter, and the service fails closed when one is required.
const WISH_LETTER_KEYS: readonly string[] = ['subject', 'body'];
const WISH_RESPONSE_KEYS: readonly string[] = ['response', 'subject', 'body'];
const WISH_CONVERT_KEYS: readonly string[] = ['issueType', 'priority'];
const WISH_ISSUE_TYPES: ReadonlySet<string> = new Set([
  'bug',
  'feature',
  'task',
  'epic',
  'chore',
]);

function parseLetterFields(value: Record<string, unknown>): AdminWishlistDispositionLetter {
  for (const field of WISH_LETTER_KEYS) {
    const supplied = value[field];
    if (supplied !== undefined && (typeof supplied !== 'string' || !supplied.trim())) {
      throw new Error(`${field} must be a non-empty Partner-authored string when supplied`);
    }
  }
  return {
    ...(typeof value.subject === 'string' ? { subject: value.subject } : {}),
    ...(typeof value.body === 'string' ? { body: value.body } : {}),
  };
}

function parseLetterInput(value: unknown): AdminWishlistDispositionLetter {
  if (!isRecord(value)) throw new Error('Wishlist disposition payload must be a JSON object');
  assertNoUnknownKeys(value, WISH_LETTER_KEYS, 'Wishlist disposition payload');
  return parseLetterFields(value);
}

interface WishResponseInput {
  response: string;
  letter: AdminWishlistDispositionLetter;
}

function parseResponseInput(value: unknown): WishResponseInput {
  if (!isRecord(value)) throw new Error('Wishlist response payload must be a JSON object');
  assertNoUnknownKeys(value, WISH_RESPONSE_KEYS, 'Wishlist response payload');
  if (typeof value.response !== 'string' || !value.response.trim()) {
    throw new Error('response must be a non-empty string');
  }
  return { response: value.response, letter: parseLetterFields(value) };
}

function parseIssueType(value: unknown): BeadsIssueType | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !WISH_ISSUE_TYPES.has(value)) {
    throw new Error('issueType must be bug, feature, task, epic, or chore');
  }
  switch (value) {
    case 'bug':
    case 'feature':
    case 'task':
    case 'epic':
    case 'chore':
      return value;
    default:
      throw new Error('issueType is invalid');
  }
}

function parseConvertInput(value: unknown): AdminWishlistConvertInput {
  if (!isRecord(value)) throw new Error('Wishlist conversion payload must be a JSON object');
  assertNoUnknownKeys(value, WISH_CONVERT_KEYS, 'Wishlist conversion payload');
  const issueType = parseIssueType(value.issueType);
  let priority: number | undefined;
  if (value.priority !== undefined) {
    if (typeof value.priority !== 'number' || !Number.isInteger(value.priority)
      || value.priority < 0 || value.priority > 4) {
      throw new Error('priority must be an integer between 0 and 4');
    }
    priority = value.priority;
  }
  return {
    ...(issueType ? { issueType } : {}),
    ...(priority !== undefined ? { priority } : {}),
  };
}

function withParsedBody<T>(
  withBody: AdminBodyReader,
  req: Parameters<AdminApiRoute['handle']>[0],
  res: Parameters<AdminApiRoute['handle']>[1],
  parser: (value: unknown) => T,
  handle: (value: T) => void,
): void {
  withBody(req, res, (body) => {
    const parsed = parseAdminJsonBody(body);
    if (!parsed.ok) {
      sendJson(res, 400, { error: parsed.error });
      return;
    }
    try {
      handle(parser(parsed.value));
    } catch (error) {
      sendJson(res, 400, { error: toSanitizedMessage(error, 'Invalid wishlist payload') });
    }
  });
}

function auditWishMutation(
  append: AdminAuditTimelineAppender | undefined,
  wishId: string,
  action: string,
): void {
  append?.(
    'external_action',
    'allowed',
    `Operator ${action} companion wishlist item.`,
    [`wishId=${wishId}`, `action=${action}`],
    'operator',
  );
}

export function buildAdminWishlistRoutes(options: {
  wishlistService?: AdminWishlistService | null;
  withBody: AdminBodyReader;
  appendAuditTimelineEntry?: AdminAuditTimelineAppender;
}): AdminApiRoute[] {
  const { wishlistService, withBody, appendAuditTimelineEntry } = options;

  return [
    {
      method: 'GET',
      match: exactPath('/api/admin/wishlist'),
      handle: (_req, res) => {
        if (!wishlistService) {
          sendJson(res, 503, { error: WISHLIST_UNAVAILABLE_ERROR });
          return;
        }
        wishlistService.listWishes().then(
          payload => sendJson(res, 200, payload, ADMIN_DYNAMIC_JSON_HEADERS),
          error => sendInternalError(res, error, 'Failed to list wishes'),
        );
      },
    },
    {
      method: 'POST',
      match: paramWithSuffix('/api/admin/wishlist/', 'wishId', '/acknowledge'),
      handle: (req, res, { wishId }) => {
        if (!wishId) {
          sendJson(res, 400, { error: 'wishId is required' });
          return;
        }
        if (!wishlistService) {
          sendJson(res, 503, { error: WISHLIST_UNAVAILABLE_ERROR });
          return;
        }
        withParsedBody(withBody, req, res, parseLetterInput, (letter) => {
          wishlistService.acknowledgeWish(wishId, letter).then(
            (wish) => {
              auditWishMutation(appendAuditTimelineEntry, wishId, 'acknowledged');
              sendJson(res, 200, { wish }, ADMIN_DYNAMIC_JSON_HEADERS);
            },
            error => sendJson(res, 400, { error: toSanitizedMessage(error, 'Failed to acknowledge wish') }),
          );
        });
      },
    },
    {
      method: 'POST',
      match: paramWithSuffix('/api/admin/wishlist/', 'wishId', '/respond'),
      handle: (req, res, { wishId }) => {
        if (!wishId) {
          sendJson(res, 400, { error: 'wishId is required' });
          return;
        }
        if (!wishlistService) {
          sendJson(res, 503, { error: WISHLIST_UNAVAILABLE_ERROR });
          return;
        }
        withParsedBody(withBody, req, res, parseResponseInput, ({ response, letter }) => {
          wishlistService.respondToWish(wishId, response, letter).then(
            (wish) => {
              auditWishMutation(appendAuditTimelineEntry, wishId, 'responded to');
              sendJson(res, 200, { wish }, ADMIN_DYNAMIC_JSON_HEADERS);
            },
            error => sendJson(res, 400, { error: toSanitizedMessage(error, 'Failed to respond to wish') }),
          );
        });
      },
    },
    {
      method: 'POST',
      match: paramWithSuffix('/api/admin/wishlist/', 'wishId', '/convert-to-bead'),
      handle: (req, res, { wishId }) => {
        if (!wishId) {
          sendJson(res, 400, { error: 'wishId is required' });
          return;
        }
        if (!wishlistService) {
          sendJson(res, 503, { error: WISHLIST_UNAVAILABLE_ERROR });
          return;
        }
        withParsedBody(withBody, req, res, parseConvertInput, (input) => {
          wishlistService.convertWishToBead(wishId, input).then(
            (wish) => {
              auditWishMutation(appendAuditTimelineEntry, wishId, 'converted to a bead');
              sendJson(res, 200, { wish }, ADMIN_DYNAMIC_JSON_HEADERS);
            },
            error => sendJson(res, 400, { error: toSanitizedMessage(error, 'Failed to convert wish') }),
          );
        });
      },
    },
    {
      method: 'POST',
      match: paramWithSuffix('/api/admin/wishlist/', 'wishId', '/done'),
      handle: (req, res, { wishId }) => {
        if (!wishId) {
          sendJson(res, 400, { error: 'wishId is required' });
          return;
        }
        if (!wishlistService) {
          sendJson(res, 503, { error: WISHLIST_UNAVAILABLE_ERROR });
          return;
        }
        withParsedBody(withBody, req, res, parseLetterInput, (letter) => {
          wishlistService.completeWish(wishId, letter).then(
            (wish) => {
              auditWishMutation(appendAuditTimelineEntry, wishId, 'completed');
              sendJson(res, 200, { wish }, ADMIN_DYNAMIC_JSON_HEADERS);
            },
            error => sendJson(res, 400, { error: toSanitizedMessage(error, 'Failed to complete wish') }),
          );
        });
      },
    },
  ];
}
