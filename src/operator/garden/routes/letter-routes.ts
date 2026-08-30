import { sendJson } from '../../../channels/backplane/http/primitives.js';
import { LETTER_STATES, type LetterState } from '../../../core/letters/contracts.js';
import { assertNoUnknownKeys, isRecord } from '../../../shared/utils/types.js';
import { parseAdminJsonBody } from '../request-body.js';
import { exactPath, paramWithSuffix } from '../route-matchers.js';
import type { AdminLetterService } from '../services/types.js';
import { ADMIN_DYNAMIC_JSON_HEADERS, sendInternalError, toSanitizedMessage } from './shared.js';
import type { AdminApiRoute, AdminBodyReader } from './types.js';

const BOUNDARY = 'Letters wait in the private bin without push, sound, quiet-hour handling, or outbound delivery.';
const COMPOSE_KEYS = ['subject', 'body', 'draft'] as const;
const LETTER_STATE_SET = new Set<string>(LETTER_STATES);

function parseCompose(value: unknown): { subject: string; body: string; draft?: boolean } {
  if (!isRecord(value)) throw new Error('Letter payload must be a JSON object');
  assertNoUnknownKeys(value, COMPOSE_KEYS, 'Letter payload');
  if (typeof value.subject !== 'string' || !value.subject.trim()) {
    throw new Error('subject must be a non-empty string');
  }
  if (typeof value.body !== 'string' || !value.body.trim()) {
    throw new Error('body must be a non-empty string');
  }
  if (value.draft !== undefined && typeof value.draft !== 'boolean') {
    throw new Error('draft must be a boolean');
  }
  return {
    subject: value.subject,
    body: value.body,
    ...(value.draft === true ? { draft: true } : {}),
  };
}

function parseStates(raw: string | null): LetterState[] | undefined {
  if (!raw) return undefined;
  const states = raw.split(',').filter((state): state is LetterState => LETTER_STATE_SET.has(state));
  if (states.length !== raw.split(',').length) throw new Error('states contains an invalid letter state');
  return states;
}

export function buildAdminLetterRoutes(options: {
  letterService?: AdminLetterService | null;
  withBody: AdminBodyReader;
}): AdminApiRoute[] {
  const { letterService, withBody } = options;
  return [
    {
      method: 'GET',
      match: exactPath('/api/admin/letters'),
      handle: (req, res) => {
        if (!letterService) return void sendJson(res, 503, { error: 'Letters backend unavailable' });
        try {
          const url = new URL(req.url ?? '/api/admin/letters', 'http://garden.invalid');
          const direction = url.searchParams.get('direction');
          if (direction !== null && direction !== 'inbox' && direction !== 'outbox') {
            throw new Error('direction must be inbox or outbox');
          }
          const states = parseStates(url.searchParams.get('states'));
          Promise.all([
            letterService.list({
              party: 'partner',
              ...(direction ? { direction } : {}),
              ...(states ? { states } : {}),
            }),
            letterService.countWaiting('partner'),
          ]).then(
            ([letters, waitingCount]) => sendJson(
              res, 200, { letters, waitingCount, boundary: BOUNDARY }, ADMIN_DYNAMIC_JSON_HEADERS,
            ),
            error => sendInternalError(res, error, 'Failed to list letters'),
          );
        } catch (error) {
          sendJson(res, 400, { error: toSanitizedMessage(error, 'Invalid letter query') });
        }
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/admin/letters'),
      handle: (req, res) => {
        if (!letterService) return void sendJson(res, 503, { error: 'Letters backend unavailable' });
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) return void sendJson(res, 400, { error: parsed.error });
          try {
            const input = parseCompose(parsed.value);
            letterService.compose({
              author: 'partner', recipient: 'companion', ...input,
            }).then(
              letter => sendJson(res, 201, { letter }, ADMIN_DYNAMIC_JSON_HEADERS),
              error => sendJson(res, 400, { error: toSanitizedMessage(error, 'Failed to compose letter') }),
            );
          } catch (error) {
            sendJson(res, 400, { error: toSanitizedMessage(error, 'Invalid letter payload') });
          }
        });
      },
    },
    ...(['place', 'read', 'archive'] as const).map((action): AdminApiRoute => ({
      method: 'POST',
      match: paramWithSuffix('/api/admin/letters/', 'letterId', `/${action}`),
      handle: (_req, res, { letterId }) => {
        if (!letterService) return void sendJson(res, 503, { error: 'Letters backend unavailable' });
        if (!letterId) return void sendJson(res, 400, { error: 'letterId is required' });
        const promise = action === 'read'
          ? letterService.read(letterId, 'partner')
          : action === 'place'
            ? letterService.place(letterId, 'partner')
            : letterService.archive(letterId, 'partner');
        promise.then(
          letter => sendJson(res, 200, { letter }, ADMIN_DYNAMIC_JSON_HEADERS),
          error => sendJson(res, 400, { error: toSanitizedMessage(error, `Failed to ${action} letter`) }),
        );
      },
    })),
  ];
}
