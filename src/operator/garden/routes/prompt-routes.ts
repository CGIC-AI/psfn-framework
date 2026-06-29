import { sendJson } from '../../../channels/backplane/http/primitives.js';
import { parseAdminJsonBody } from '../request-body.js';
import { exactPath, paramWithSuffix, prefixedParamPath } from '../route-matchers.js';
import type { AdminPromptsService } from '../services/types.js';
import type { AdminApiRoute, AdminBodyReader } from './types.js';

export function buildAdminPromptRoutes(options: {
  promptsService: AdminPromptsService;
  withBody: AdminBodyReader;
}): AdminApiRoute[] {
  const { promptsService, withBody } = options;

  return [
    {
      method: 'GET',
      match: exactPath('/api/admin/prompts'),
      handle: (_req, res) => {
        sendJson(res, 200, promptsService.listPrompts());
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/admin/prompts'),
      handle: (req, res) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const result = promptsService.createPromptLayer(JSON.stringify(parsed.value));
          if (!result.ok) {
            sendJson(res, 400, { error: result.message });
            return;
          }
          sendJson(res, 201, result);
        });
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/admin/prompts/reorder'),
      handle: (req, res) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }

          const reorderablePromptsService = promptsService as AdminPromptsService & {
            reorderPromptLayers?: (payload: string) => { ok: boolean; message: string };
          };
          if (typeof reorderablePromptsService.reorderPromptLayers !== 'function') {
            sendJson(res, 400, { error: 'Prompt reorder not available' });
            return;
          }

          const result = reorderablePromptsService.reorderPromptLayers(JSON.stringify(parsed.value));
          if (!result.ok) {
            sendJson(res, 400, { error: result.message });
            return;
          }
          sendJson(res, 200, result);
        });
      },
    },
    {
      method: 'PUT',
      match: exactPath('/api/admin/prompts/runtime-blocks'),
      handle: (req, res) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }

          const runtimeBlocksService = promptsService as AdminPromptsService & {
            saveRuntimePromptBlocks?: (payload: string) => { ok: boolean; message: string };
          };
          if (typeof runtimeBlocksService.saveRuntimePromptBlocks !== 'function') {
            sendJson(res, 400, { error: 'Runtime prompt block editing not available' });
            return;
          }

          const result = runtimeBlocksService.saveRuntimePromptBlocks(JSON.stringify(parsed.value));
          if (!result.ok) {
            sendJson(res, 400, { error: result.message });
            return;
          }
          sendJson(res, 200, result);
        });
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/admin/prompts/foundation'),
      handle: (_req, res) => {
        const snapshot = promptsService.getFoundationSnapshot();
        if (!snapshot) {
          sendJson(res, 400, { error: 'Character Foundation is not configured' });
          return;
        }
        sendJson(res, 200, snapshot);
      },
    },
    {
      method: 'PUT',
      match: exactPath('/api/admin/prompts/foundation'),
      handle: (req, res) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const result = promptsService.saveFoundationSections(JSON.stringify(parsed.value));
          if (!result.ok) {
            sendJson(res, 400, { error: result.message });
            return;
          }
          sendJson(res, 200, result);
        });
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/admin/prompts/constitution'),
      handle: (_req, res) => {
        sendJson(res, 200, promptsService.getConstitutionSnapshot());
      },
    },
    {
      method: 'PUT',
      match: exactPath('/api/admin/prompts/constitution'),
      handle: (req, res) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const result = promptsService.saveConstitutionMutableLayers(JSON.stringify(parsed.value));
          if (!result.ok) {
            sendJson(res, 400, { error: result.message });
            return;
          }
          sendJson(res, 200, result);
        });
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/admin/prompts/north-star'),
      handle: (_req, res) => {
        const snapshot = promptsService.getNorthStarSnapshot();
        if (!snapshot) {
          sendJson(res, 400, { error: 'North Star store not configured' });
          return;
        }
        sendJson(res, 200, snapshot);
      },
    },
    {
      method: 'PUT',
      match: exactPath('/api/admin/prompts/north-star'),
      handle: (req, res) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const result = promptsService.saveNorthStarItems(JSON.stringify(parsed.value));
          if (!result.ok) {
            sendJson(res, 400, { error: result.message });
            return;
          }
          sendJson(res, 200, result);
        });
      },
    },
    // Sub-path routes MUST be before generic prefixed param routes
    {
      method: 'POST',
      match: paramWithSuffix('/api/admin/prompts/', 'layerId', '/toggle'),
      handle: (_req, res, { layerId }) => {
        const result = promptsService.togglePromptLayer(JSON.stringify({ layerId }));
        if (!result.ok) {
          sendJson(res, 400, { error: result.message });
          return;
        }
        sendJson(res, 200, result);
      },
    },
    {
      method: 'POST',
      match: paramWithSuffix('/api/admin/prompts/', 'layerId', '/rollback'),
      handle: (req, res, { layerId }) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const payload = parsed.value && typeof parsed.value === 'object'
            ? { ...(parsed.value as Record<string, unknown>), layerId }
            : { layerId };
          const result = promptsService.rollbackPromptLayer(JSON.stringify(payload));
          if (!result.ok) {
            sendJson(res, 400, { error: result.message });
            return;
          }
          sendJson(res, 200, result);
        });
      },
    },
    {
      method: 'GET',
      match: paramWithSuffix('/api/admin/prompts/', 'layerId', '/diff'),
      handle: (_req, res, { layerId }) => {
        const result = promptsService.previewPromptLayerDiff(JSON.stringify({ layerId }));
        if (!result) {
          sendJson(res, 404, { error: 'Prompt layer not found or no previous version' });
          return;
        }
        sendJson(res, 200, result);
      },
    },
    {
      method: 'GET',
      match: prefixedParamPath('/api/admin/prompts/', 'layerId'),
      handle: (_req, res, { layerId }) => {
        const detail = promptsService.getPromptDetail(layerId);
        if (!detail) {
          sendJson(res, 404, { error: 'Prompt layer not found' });
          return;
        }
        sendJson(res, 200, detail);
      },
    },
    {
      method: 'PATCH',
      match: prefixedParamPath('/api/admin/prompts/', 'layerId'),
      handle: (req, res, { layerId }) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const payload = parsed.value && typeof parsed.value === 'object'
            ? { ...(parsed.value as Record<string, unknown>), layerId }
            : { layerId };
          const result = promptsService.updatePromptLayer(JSON.stringify(payload));
          if (!result.ok) {
            sendJson(res, 400, { error: result.message });
            return;
          }
          sendJson(res, 200, result);
        });
      },
    },
  ];
}
