import { sendJson } from '../../../channels/backplane/http/primitives.js';
import { parseAdminJsonBody } from '../request-body.js';
import { exactPath, prefixedParamPath } from '../route-matchers.js';
import type { AdminSettingsService } from '../services/types.js';
import type { AdminAuditDecision } from '../types.js';
import { toSanitizedMessage } from './shared.js';
import type { AdminApiRoute, AdminAuditTimelineAppender, AdminBodyReader } from './types.js';

const ADMIN_SETTINGS_API_PATH = '/api/admin/settings';
const ADMIN_SETTINGS_MODELS_API_PATH = '/api/admin/settings/models';

export function buildAdminSettingsRoutes(options: {
  settingsService: AdminSettingsService;
  appendAuditTimelineEntry?: AdminAuditTimelineAppender;
  withBody: AdminBodyReader;
}): AdminApiRoute[] {
  const { settingsService, appendAuditTimelineEntry, withBody } = options;

  const appendSettingsMutationAudit = (
    decision: AdminAuditDecision,
    narrative: string,
    details: Array<string | null | undefined> = [],
  ): void => {
    appendAuditTimelineEntry?.('settings_change', decision, narrative, details, 'operator');
  };

  return [
    {
      method: 'GET',
      match: exactPath(ADMIN_SETTINGS_API_PATH),
      handle: (_req, res) => {
        settingsService.getSettingsData().then(
          data => sendJson(res, 200, data),
          error => sendJson(res, 500, { error: String(error) }),
        );
      },
    },
    {
      method: 'GET',
      match: exactPath(`${ADMIN_SETTINGS_API_PATH}/schema`),
      handle: (_req, res) => {
        sendJson(res, 200, settingsService.getSettingsContractData());
      },
    },
    {
      method: 'GET',
      match: exactPath(ADMIN_SETTINGS_MODELS_API_PATH),
      handle: (_req, res) => {
        const modelsJson = settingsService.getSubConfigJson('models');
        if (modelsJson === null) {
          sendJson(res, 500, { error: 'models.json config store unavailable' });
          return;
        }
        try {
          const models = JSON.parse(modelsJson);
          const registry = typeof models === 'object' && models !== null && 'modelRegistry' in models
            ? (models as { modelRegistry: unknown }).modelRegistry
            : models;
          sendJson(res, 200, registry);
        } catch (error) {
          sendJson(res, 500, { error: String(error) });
        }
      },
    },
    {
      method: 'POST',
      match: exactPath(ADMIN_SETTINGS_MODELS_API_PATH),
      handle: (req, res) => {
        withBody(req, res, (body) => {
          const params = new URLSearchParams(body);
          const configJson = params.get('configJson');
          if (typeof configJson !== 'string' || configJson.trim().length === 0) {
            sendJson(res, 400, { error: 'Missing configJson form field' });
            return;
          }

          try {
            JSON.parse(configJson);
          } catch {
            sendJson(res, 400, { error: 'configJson must be valid JSON' });
            return;
          }

          const result = settingsService.saveSubConfigJson('models', configJson);
          if (!result.ok) {
            appendSettingsMutationAudit(
              'denied',
              'Operator models.json update failed.',
              [`message=${toSanitizedMessage(result.message, 'models.json save failed')}`],
            );
            sendJson(res, 400, {
              error: result.message,
              ...result,
            });
            return;
          }

          appendSettingsMutationAudit(
            'allowed',
            'Operator updated models.json via /api/admin/settings/models.',
          );
          sendJson(res, 200, { ok: true, message: 'models.json saved' });
        });
      },
    },
    {
      method: 'PATCH',
      match: exactPath(ADMIN_SETTINGS_API_PATH),
      handle: (req, res) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            appendSettingsMutationAudit(
              'denied',
              'Operator settings update via /api/admin/settings failed: invalid JSON payload.',
            );
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const changedFields = parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value)
            ? Object.keys(parsed.value as Record<string, unknown>).sort()
            : [];
          const result = settingsService.updateSettings(JSON.stringify(parsed.value));
          if (!result.ok) {
            const safeMessage = toSanitizedMessage(result.message, 'Settings update failed');
            appendSettingsMutationAudit(
              'denied',
              `Operator settings update via /api/admin/settings failed: ${safeMessage}`,
              [changedFields.length > 0 ? `fields=${changedFields.join(',')}` : null],
            );
            sendJson(res, 400, {
              error: safeMessage,
              ...result,
              message: safeMessage,
            });
            return;
          }
          appendSettingsMutationAudit(
            'allowed',
            'Operator updated runtime settings via /api/admin/settings.',
            [changedFields.length > 0 ? `fields=${changedFields.join(',')}` : null],
          );
          sendJson(res, 200, result);
        });
      },
    },
    // ── Canonical settings subsystem raw-config editors ──
    {
      method: 'GET',
      match: prefixedParamPath(`${ADMIN_SETTINGS_API_PATH}/`, 'key'),
      handle: (_req, res, params) => {
        const raw = settingsService.getSubConfigJson(params.key);
        if (raw === null) {
          sendJson(res, 404, { error: `Unknown settings subsystem: ${params.key}` });
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(raw);
      },
    },
    {
      method: 'POST',
      match: prefixedParamPath(`${ADMIN_SETTINGS_API_PATH}/`, 'key'),
      handle: (req, res, params) => {
        withBody(req, res, (body) => {
          const formParams = new URLSearchParams(body);
          const configJson = formParams.get('configJson');
          if (typeof configJson !== 'string' || configJson.trim().length === 0) {
            sendJson(res, 400, { error: 'Missing configJson form field' });
            return;
          }
          const result = settingsService.saveSubConfigJson(params.key, configJson);
          if (!result.ok) {
            appendSettingsMutationAudit(
              'denied',
              `Operator ${params.key} owner-file update failed.`,
              [`message=${toSanitizedMessage(result.message, 'owner-file save failed')}`],
            );
            sendJson(res, 400, { error: result.message });
            return;
          }
          appendSettingsMutationAudit(
            'allowed',
            `Operator updated ${params.key} owner file via /api/admin/settings/${params.key}.`,
          );
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(result.message);
        });
      },
    },
    // ── Settings subsystem raw-config editors ──
    {
      method: 'GET',
      match: prefixedParamPath('/api/settings/', 'key'),
      handle: (_req, res, params) => {
        const raw = settingsService.getSubConfigJson(params.key);
        if (raw === null) {
          sendJson(res, 404, { error: `Unknown settings subsystem: ${params.key}` });
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(raw);
      },
    },
    {
      method: 'POST',
      match: prefixedParamPath('/api/settings/', 'key'),
      handle: (req, res, params) => {
        withBody(req, res, (body) => {
          const formParams = new URLSearchParams(body);
          const configJson = formParams.get('configJson');
          if (typeof configJson !== 'string' || configJson.trim().length === 0) {
            sendJson(res, 400, { error: 'Missing configJson form field' });
            return;
          }
          const result = settingsService.saveSubConfigJson(params.key, configJson);
          if (!result.ok) {
            appendSettingsMutationAudit(
              'denied',
              `Operator ${params.key} owner-file update failed.`,
              [`message=${toSanitizedMessage(result.message, 'owner-file save failed')}`],
            );
            sendJson(res, 400, { error: result.message });
            return;
          }
          appendSettingsMutationAudit(
            'allowed',
            `Operator updated ${params.key} owner file via /api/settings/${params.key}.`,
          );
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(result.message);
        });
      },
    },
  ];
}
