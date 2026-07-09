// ── Garden intake source-list routes (htm9.13) ──
// Minimal CRUD for the intake-policy trusted/denied sites and people lists.
// The htm9.11 Garden flywheel tab builds its UI on these routes; keep them
// small. Writes go through the intake-policy owner-file path (settings
// service → applyIntakeSourceListMutation → saveIntakePolicy) with
// fail-closed server-side validation, and every mutation attempt is
// audit-logged.

import { sendJson } from '../../../channels/backplane/http/primitives.js';
import { parseAdminJsonBody } from '../request-body.js';
import { exactPath } from '../route-matchers.js';
import { isRecord } from '../../../shared/utils/types.js';
import {
  INTAKE_SOURCE_LIST_NAMES,
  isIntakeSourceListName,
} from '../../../system/config/intake-policy-config.js';
import type {
  AdminIntakeSourceListMutationInput,
  AdminSettingsService,
} from '../services/types.js';
import type { AdminAuditDecision } from '../types.js';
import { toSanitizedMessage } from './shared.js';
import type { AdminApiRoute, AdminAuditTimelineAppender, AdminBodyReader } from './types.js';

const ADMIN_INTAKE_SOURCE_LISTS_API_PATH = '/api/admin/intake/source-lists';

const MAX_NOTE_CHARS = 512;

function parseMutationInput(
  value: unknown,
): { ok: true; value: AdminIntakeSourceListMutationInput } | { ok: false; error: string } {
  if (!isRecord(value)) {
    return { ok: false, error: 'Body must be a JSON object' };
  }
  const unknownKeys = Object.keys(value)
    .filter((key) => !['action', 'list', 'pattern', 'note'].includes(key));
  if (unknownKeys.length > 0) {
    return { ok: false, error: `Unknown source-list mutation fields: ${unknownKeys.join(', ')}` };
  }
  if (value.action !== 'add' && value.action !== 'remove') {
    return { ok: false, error: "action must be 'add' or 'remove'" };
  }
  if (!isIntakeSourceListName(value.list)) {
    return { ok: false, error: `list must be one of: ${INTAKE_SOURCE_LIST_NAMES.join(', ')}` };
  }
  if (typeof value.pattern !== 'string' || value.pattern.trim().length === 0) {
    return { ok: false, error: 'pattern must be a non-empty string' };
  }
  if (value.note !== undefined
    && (typeof value.note !== 'string' || value.note.length > MAX_NOTE_CHARS)) {
    return { ok: false, error: `note must be a string of at most ${String(MAX_NOTE_CHARS)} characters` };
  }
  return {
    ok: true,
    value: {
      action: value.action,
      list: value.list,
      pattern: value.pattern.trim(),
      ...(value.note !== undefined ? { note: value.note } : {}),
    },
  };
}

export function buildAdminIntakeSourceListRoutes(options: {
  settingsService: AdminSettingsService;
  appendAuditTimelineEntry?: AdminAuditTimelineAppender;
  withBody: AdminBodyReader;
}): AdminApiRoute[] {
  const { settingsService, appendAuditTimelineEntry, withBody } = options;

  const appendSourceListMutationAudit = (
    decision: AdminAuditDecision,
    narrative: string,
    details: Array<string | null | undefined> = [],
  ): void => {
    appendAuditTimelineEntry?.('settings_change', decision, narrative, details, 'operator');
  };

  return [
    {
      method: 'GET',
      match: exactPath(ADMIN_INTAKE_SOURCE_LISTS_API_PATH),
      handle: (_req, res) => {
        try {
          sendJson(res, 200, { lists: settingsService.getIntakeSourceLists() });
        } catch (error) {
          sendJson(res, 500, {
            error: toSanitizedMessage(error, 'Failed to load intake source lists'),
          });
        }
      },
    },
    {
      method: 'POST',
      match: exactPath(ADMIN_INTAKE_SOURCE_LISTS_API_PATH),
      handle: (req, res) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            appendSourceListMutationAudit(
              'denied',
              'Operator intake source-list mutation failed: invalid JSON payload.',
            );
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const input = parseMutationInput(parsed.value);
          if (!input.ok) {
            appendSourceListMutationAudit(
              'denied',
              'Operator intake source-list mutation failed: invalid fields.',
              [`error=${input.error}`],
            );
            sendJson(res, 400, { error: input.error });
            return;
          }

          const result = settingsService.mutateIntakeSourceList(input.value);
          if (!result.ok) {
            appendSourceListMutationAudit(
              'denied',
              'Operator intake source-list mutation failed validation.',
              [
                `action=${input.value.action}`,
                `list=${input.value.list}`,
                `pattern=${input.value.pattern}`,
                `message=${toSanitizedMessage(result.message, 'source-list mutation failed')}`,
              ],
            );
            sendJson(res, 400, { error: result.message });
            return;
          }

          appendSourceListMutationAudit(
            'allowed',
            input.value.action === 'add'
              ? 'Operator added an intake source-list entry via /api/admin/intake/source-lists.'
              : 'Operator removed an intake source-list entry via /api/admin/intake/source-lists.',
            [`list=${input.value.list}`, `pattern=${input.value.pattern}`],
          );
          sendJson(res, 200, {
            ok: true,
            message: result.message,
            lists: settingsService.getIntakeSourceLists(),
          });
        });
      },
    },
  ];
}
