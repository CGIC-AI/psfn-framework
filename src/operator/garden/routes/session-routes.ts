import { sendJson } from '../../../channels/backplane/http/primitives.js';
import { exactPath, prefixedParamPath } from '../route-matchers.js';
import type { AdminSessionService } from '../services/types.js';
import { toSanitizedMessage } from './shared.js';
import type { AdminApiRoute } from './types.js';

export function buildAdminSessionRoutes(options: {
  sessionService: AdminSessionService;
}): AdminApiRoute[] {
  const { sessionService } = options;

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
      match: prefixedParamPath('/api/admin/sessions/', 'channelId'),
      handle: (_req, res, { channelId }) => {
        sendJson(res, 200, sessionService.getSessionMessages(channelId));
      },
    },
  ];
}
