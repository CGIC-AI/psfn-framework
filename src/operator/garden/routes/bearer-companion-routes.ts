// ── Companion Cluster Bearer API pin routes (vknn) ──
// Read/select which single companion the inbound OpenAI-compatible Bearer API
// is pinned to (channels.json api.companionId). Writes go through the owner-file
// path with fail-closed roster validation. There is deliberately no per-request
// companion selection here — the Bearer surface stays pinned to exactly one
// companion. Kept additive and isolated from the settings routes.

import { sendJson } from '../../../channels/backplane/http/primitives.js';
import { parseAdminJsonBody } from '../request-body.js';
import { exactPath } from '../route-matchers.js';
import { isRecord } from '../../../shared/utils/types.js';
import type { AdminSettingsService } from '../services/types.js';
import type { AdminAuditDecision } from '../types.js';
import { toSanitizedMessage } from './shared.js';
import type { AdminApiRoute, AdminAuditTimelineAppender, AdminBodyReader } from './types.js';

const ADMIN_BEARER_COMPANION_API_PATH = '/api/admin/channels/bearer-companion';

export function buildAdminBearerCompanionRoutes(options: {
  settingsService: AdminSettingsService;
  appendAuditTimelineEntry?: AdminAuditTimelineAppender;
  withBody: AdminBodyReader;
}): AdminApiRoute[] {
  const { settingsService, appendAuditTimelineEntry, withBody } = options;

  const appendPinMutationAudit = (
    decision: AdminAuditDecision,
    narrative: string,
    details: Array<string | null | undefined> = [],
  ): void => {
    appendAuditTimelineEntry?.('settings_change', decision, narrative, details, 'operator');
  };

  return [
    {
      method: 'GET',
      match: exactPath(ADMIN_BEARER_COMPANION_API_PATH),
      handle: (_req, res) => {
        try {
          sendJson(res, 200, settingsService.getBearerApiCompanionPin());
        } catch (error) {
          sendJson(res, 500, { error: String(error) });
        }
      },
    },
    {
      method: 'POST',
      match: exactPath(ADMIN_BEARER_COMPANION_API_PATH),
      handle: (req, res) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            appendPinMutationAudit(
              'denied',
              'Operator Bearer API companion pin update failed: invalid JSON payload.',
            );
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          if (!isRecord(parsed.value) || typeof parsed.value.companionId !== 'string') {
            appendPinMutationAudit(
              'denied',
              'Operator Bearer API companion pin update failed: missing companionId.',
            );
            sendJson(res, 400, { error: 'Body must be a JSON object with a string companionId' });
            return;
          }

          const companionId = parsed.value.companionId;
          const result = settingsService.setBearerApiCompanionPin(companionId);
          if (!result.ok) {
            appendPinMutationAudit(
              'denied',
              'Operator Bearer API companion pin update rejected.',
              [
                `companionId=${companionId}`,
                `message=${toSanitizedMessage(result.message, 'bearer companion pin rejected')}`,
              ],
            );
            sendJson(res, 400, { error: result.message });
            return;
          }

          appendPinMutationAudit(
            'allowed',
            'Operator pinned the Bearer API to a Companion Cluster member via '
              + '/api/admin/channels/bearer-companion.',
            [`companionId=${companionId}`],
          );
          sendJson(res, 200, {
            ok: true,
            message: result.message,
            data: settingsService.getBearerApiCompanionPin(),
          });
        });
      },
    },
  ];
}
