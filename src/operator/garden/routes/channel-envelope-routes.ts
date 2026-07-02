// ── Garden channel Context Envelope routes (E3.2) ──
// List view + edit affordance for channel-owned envelope labels
// (channels.json contextEnvelope). Writes go through the owner-file path with
// fail-closed validation. Kept additive and isolated from the settings routes
// (parallel E3.4/E3.5 work also registers garden routes).

import { sendJson } from '../../../channels/backplane/http/primitives.js';
import { parseAdminJsonBody } from '../request-body.js';
import { exactPath } from '../route-matchers.js';
import { isRecord } from '../../../shared/utils/types.js';
import type { AdminSettingsService } from '../services/types.js';
import type { AdminAuditDecision } from '../types.js';
import { toSanitizedMessage } from './shared.js';
import type { AdminApiRoute, AdminAuditTimelineAppender, AdminBodyReader } from './types.js';

const ADMIN_CHANNEL_ENVELOPE_API_PATH = '/api/admin/channels/context-envelope';

export function buildAdminChannelEnvelopeRoutes(options: {
  settingsService: AdminSettingsService;
  appendAuditTimelineEntry?: AdminAuditTimelineAppender;
  withBody: AdminBodyReader;
}): AdminApiRoute[] {
  const { settingsService, appendAuditTimelineEntry, withBody } = options;

  const appendChannelEnvelopeMutationAudit = (
    decision: AdminAuditDecision,
    narrative: string,
    details: Array<string | null | undefined> = [],
  ): void => {
    appendAuditTimelineEntry?.('settings_change', decision, narrative, details, 'operator');
  };

  return [
    {
      method: 'GET',
      match: exactPath(ADMIN_CHANNEL_ENVELOPE_API_PATH),
      handle: (_req, res) => {
        try {
          sendJson(res, 200, settingsService.getChannelEnvelopeData());
        } catch (error) {
          sendJson(res, 500, { error: String(error) });
        }
      },
    },
    {
      method: 'POST',
      match: exactPath(ADMIN_CHANNEL_ENVELOPE_API_PATH),
      handle: (req, res) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            appendChannelEnvelopeMutationAudit(
              'denied',
              'Operator channel envelope label update failed: invalid JSON payload.',
            );
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          if (!isRecord(parsed.value) || typeof parsed.value.channelId !== 'string') {
            appendChannelEnvelopeMutationAudit(
              'denied',
              'Operator channel envelope label update failed: missing channelId.',
            );
            sendJson(res, 400, { error: 'Body must be a JSON object with a string channelId' });
            return;
          }

          const channelId = parsed.value.channelId;
          const label = Object.prototype.hasOwnProperty.call(parsed.value, 'label')
            ? parsed.value.label
            : undefined;
          const result = settingsService.saveChannelEnvelopeLabel(channelId, label ?? null);
          if (!result.ok) {
            appendChannelEnvelopeMutationAudit(
              'denied',
              'Operator channel envelope label update failed.',
              [
                `channelId=${channelId}`,
                `message=${toSanitizedMessage(result.message, 'channel envelope label save failed')}`,
              ],
            );
            sendJson(res, 400, { error: result.message });
            return;
          }

          appendChannelEnvelopeMutationAudit(
            'allowed',
            label === undefined || label === null
              ? 'Operator removed a channel-owned envelope label via /api/admin/channels/context-envelope.'
              : 'Operator saved a channel-owned envelope label via /api/admin/channels/context-envelope.',
            [`channelId=${channelId}`],
          );
          sendJson(res, 200, {
            ok: true,
            message: result.message,
            data: settingsService.getChannelEnvelopeData(),
          });
        });
      },
    },
  ];
}
