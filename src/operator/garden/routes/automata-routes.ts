import { sendJson } from '../../../channels/backplane/http/primitives.js';
import { exactPath } from '../route-matchers.js';
import { parseRequestUrl } from '../request-url.js';
import type { AdminAutomataService } from '../services/automata-service.js';
import {
  ADMIN_DYNAMIC_JSON_HEADERS,
  parsePositiveIntegerQueryNumber,
  toSanitizedMessage,
} from './shared.js';
import type { AdminApiRoute } from './types.js';

const AUTOMATA_PATH = '/api/admin/automata';

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
      const parsedLimit = parsePositiveIntegerQueryNumber(url.searchParams, 'limit');
      if (!parsedLimit.ok) {
        sendJson(res, 400, { error: parsedLimit.error });
        return;
      }
      try {
        const status = url.searchParams.get('status') ?? undefined;
        const classId = url.searchParams.get('classId') ?? undefined;
        const taskId = url.searchParams.get('taskId') ?? undefined;
        sendJson(res, 200, options.automataService.getSnapshot({
          ...(status === undefined ? {} : { status }),
          ...(classId === undefined ? {} : { classId }),
          ...(taskId === undefined ? {} : { taskId }),
          ...(parsedLimit.value === undefined ? {} : { limit: parsedLimit.value }),
        }), ADMIN_DYNAMIC_JSON_HEADERS);
      } catch (error) {
        sendJson(res, 400, { error: toSanitizedMessage(error, 'Invalid automata query') });
      }
    },
  }];
}
