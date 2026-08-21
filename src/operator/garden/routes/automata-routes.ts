import { sendJson } from '../../../channels/backplane/http/primitives.js';
import { exactPath } from '../route-matchers.js';
import { parseRequestUrl } from '../request-url.js';
import {
  AdminAutomataNotFoundError,
  AdminAutomataQueryError,
  AdminAutomataUnavailableError,
  type AdminAutomataService,
  type AdminAutomataSnapshotOptions,
} from '../services/automata-service.js';
import {
  ADMIN_DYNAMIC_JSON_HEADERS,
  parsePositiveIntegerQueryNumber,
  toSanitizedMessage,
} from './shared.js';
import type { AdminApiRoute } from './types.js';

const AUTOMATA_PATH = '/api/admin/automata';
const AUTOMATA_REINDEX_PATH = '/api/admin/automata/reindex';

function parseOffset(params: URLSearchParams, name: string): { ok: true; value?: number } | { ok: false; error: string } {
  const raw = params.get(name);
  if (raw === null) return { ok: true };
  if (!/^\d+$/u.test(raw)) return { ok: false, error: `${name} must be a non-negative integer` };
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return { ok: false, error: `${name} must be a non-negative safe integer` };
  return { ok: true, value };
}

function optionalQuery(params: URLSearchParams, name: string): string | undefined {
  return params.get(name) ?? undefined;
}

export function buildAdminAutomataRoutes(options: {
  automataService?: AdminAutomataService | null;
}): AdminApiRoute[] {
  return [{
    method: 'GET',
    match: exactPath(AUTOMATA_PATH),
    handle: (req, res) => {
      if (!options.automataService) {
        sendJson(res, 503, { error: 'Automata registry unavailable' });
        return;
      }
      const url = parseRequestUrl(req, AUTOMATA_PATH);
      const limit = parsePositiveIntegerQueryNumber(url.searchParams, 'limit');
      const busLimit = parsePositiveIntegerQueryNumber(url.searchParams, 'busLimit');
      const runOffset = parseOffset(url.searchParams, 'runOffset');
      const busOffset = parseOffset(url.searchParams, 'busOffset');
      if (!limit.ok) {
        sendJson(res, 400, { error: limit.error });
        return;
      }
      if (!busLimit.ok) {
        sendJson(res, 400, { error: busLimit.error });
        return;
      }
      if (!runOffset.ok) {
        sendJson(res, 400, { error: runOffset.error });
        return;
      }
      if (!busOffset.ok) {
        sendJson(res, 400, { error: busOffset.error });
        return;
      }
      try {
        const status = optionalQuery(url.searchParams, 'status');
        const classId = optionalQuery(url.searchParams, 'classId');
        const taskId = optionalQuery(url.searchParams, 'taskId');
        const busClassId = optionalQuery(url.searchParams, 'busClassId');
        const busRunId = optionalQuery(url.searchParams, 'busRunId');
        const busTaskId = optionalQuery(url.searchParams, 'busTaskId');
        const eventId = optionalQuery(url.searchParams, 'eventId');
        const verificationStatus = optionalQuery(url.searchParams, 'verificationStatus');
        const query: AdminAutomataSnapshotOptions = {
          ...(status === undefined ? {} : { status }),
          ...(classId === undefined ? {} : { classId }),
          ...(taskId === undefined ? {} : { taskId }),
          ...(limit.value === undefined ? {} : { limit: limit.value }),
          ...(runOffset.value === undefined ? {} : { runOffset: runOffset.value }),
          ...(busLimit.value === undefined ? {} : { busLimit: busLimit.value }),
          ...(busOffset.value === undefined ? {} : { busOffset: busOffset.value }),
          ...(busClassId === undefined ? {} : { busClassId }),
          ...(busRunId === undefined ? {} : { busRunId }),
          ...(busTaskId === undefined ? {} : { busTaskId }),
          ...(eventId === undefined ? {} : { eventId }),
          ...(verificationStatus === undefined ? {} : { verificationStatus }),
        };
        options.automataService.getSnapshot(query).then(
          snapshot => sendJson(res, 200, snapshot, ADMIN_DYNAMIC_JSON_HEADERS),
          error => {
            if (error instanceof AdminAutomataNotFoundError) {
              sendJson(res, 404, { error: toSanitizedMessage(error, 'Unknown Automata resource') });
              return;
            }
            if (error instanceof AdminAutomataQueryError) {
              sendJson(res, 400, { error: toSanitizedMessage(error, 'Invalid automata query') });
              return;
            }
            sendJson(res, 500, { error: 'Failed to load Automata data' });
          },
        );
      } catch {
        sendJson(res, 500, { error: 'Failed to load Automata data' });
      }
    },
  }, {
    method: 'POST',
    match: exactPath(AUTOMATA_REINDEX_PATH),
    handle: (_req, res) => {
      const reindex = options.automataService?.reindex;
      if (!reindex) {
        sendJson(res, 503, { error: 'Automata Bus reindex unavailable' });
        return;
      }
      reindex.call(options.automataService).then(
        result => sendJson(res, 200, result, ADMIN_DYNAMIC_JSON_HEADERS),
        error => {
          if (error instanceof AdminAutomataUnavailableError) {
            sendJson(res, 503, { error: 'Automata Bus reindex unavailable' });
            return;
          }
          sendJson(res, 500, { error: 'Automata Bus reindex failed' });
        },
      );
    },
  }];
}
