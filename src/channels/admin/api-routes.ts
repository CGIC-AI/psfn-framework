import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseJsonBody, sendJson } from '../http/primitives.js';
import { VALID_MEMORY_TYPES, type MemoryType } from '../../memory/types.js';
import type {
  AdminContactsService,
  AdminDashboardService,
  AdminIdentityService,
  AdminMemoryService,
  AdminPromptsService,
  AdminSessionService,
  AdminSettingsService,
} from './services/types.js';

type RouteParams = Record<string, string>;
type RouteMatcher = (path: string) => RouteParams | null;

export interface AdminApiRoute {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  match: RouteMatcher;
  handle: (req: IncomingMessage, res: ServerResponse, params: RouteParams) => void;
}

function exactPath(expected: string): RouteMatcher {
  return (path) => (path === expected ? {} : null);
}

function prefixedParamPath(prefix: string, paramName: string): RouteMatcher {
  return (path) => {
    if (!path.startsWith(prefix)) return null;
    const raw = path.slice(prefix.length);
    if (!raw) return null;
    return { [paramName]: decodeURIComponent(raw) };
  };
}

function parseAdminJsonBody(body: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = body.trim();
  if (!trimmed) return { ok: true, value: {} };
  const result = parseJsonBody(trimmed);
  if (!result.ok) return { ok: false, error: 'Invalid JSON payload' };
  return { ok: true, value: result.value };
}

function toMemoryType(value: string | null): MemoryType | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  return VALID_MEMORY_TYPES.includes(normalized as MemoryType)
    ? normalized as MemoryType
    : undefined;
}

export function buildAdminApiRoutes(options: {
  dashboardService: AdminDashboardService;
  memoryService: AdminMemoryService;
  sessionService: AdminSessionService;
  contactsService: AdminContactsService;
  settingsService: AdminSettingsService;
  identityService: AdminIdentityService;
  promptsService: AdminPromptsService;
  withBody: (req: IncomingMessage, res: ServerResponse, cb: (body: string) => void) => void;
}): AdminApiRoute[] {
  const {
    dashboardService,
    memoryService,
    sessionService,
    contactsService,
    settingsService,
    identityService,
    promptsService,
    withBody,
  } = options;

  return [
    {
      method: 'GET',
      match: exactPath('/api/admin/dashboard'),
      handle: (_req, res) => {
        sendJson(res, 200, dashboardService.getDashboardData());
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/admin/memory'),
      handle: (req, res) => {
        const url = new URL(req.url ?? '/api/admin/memory', `http://${req.headers.host ?? 'localhost'}`);
        const typeFilter = toMemoryType(url.searchParams.get('type'));
        if (url.searchParams.get('type') && !typeFilter) {
          sendJson(res, 400, { error: 'Invalid memory type filter' });
          return;
        }
        const data = memoryService.listMemories(url.searchParams);
        const memories = typeFilter
          ? data.memories.filter(memory => memory.type === typeFilter)
          : data.memories;
        sendJson(res, 200, {
          ...data,
          memories,
          contactsById: Object.fromEntries(data.contactsById.entries()),
        });
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/admin/memory/search'),
      handle: (req, res) => {
        const url = new URL(req.url ?? '/api/admin/memory/search', `http://${req.headers.host ?? 'localhost'}`);
        const query = url.searchParams.get('q')?.trim() ?? '';
        if (!query) {
          sendJson(res, 400, { error: 'Missing q query parameter' });
          return;
        }
        memoryService.searchMemories(query).then(
          result => sendJson(res, 200, {
            ...result,
            contactsById: Object.fromEntries(result.contactsById.entries()),
          }),
          error => sendJson(res, 500, { error: String(error) }),
        );
      },
    },
    {
      method: 'GET',
      match: prefixedParamPath('/api/admin/memory/', 'id'),
      handle: (_req, res, { id }) => {
        const detail = memoryService.getMemoryDetail(id);
        if (!detail) {
          sendJson(res, 404, { error: 'Memory not found' });
          return;
        }
        sendJson(res, 200, detail);
      },
    },
    {
      method: 'DELETE',
      match: prefixedParamPath('/api/admin/memory/', 'id'),
      handle: (_req, res, { id }) => {
        const result = memoryService.supersedeMemory(id);
        if (!result.ok) {
          sendJson(res, 404, { error: result.message ?? 'Memory not found' });
          return;
        }
        sendJson(res, 200, { ok: true });
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/admin/sessions'),
      handle: (_req, res) => {
        sendJson(res, 200, sessionService.listSessions());
      },
    },
    {
      method: 'GET',
      match: prefixedParamPath('/api/admin/sessions/', 'channelId'),
      handle: (_req, res, { channelId }) => {
        sendJson(res, 200, sessionService.getSessionMessages(channelId));
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/admin/contacts'),
      handle: (req, res) => {
        const url = new URL(req.url ?? '/api/admin/contacts', `http://${req.headers.host ?? 'localhost'}`);
        const data = contactsService.listContacts(url.searchParams);
        sendJson(res, 200, {
          ...data,
          profileMap: Object.fromEntries(data.profileMap.entries()),
          relatedChannelMap: Object.fromEntries(data.relatedChannelMap.entries()),
        });
      },
    },
    {
      method: 'GET',
      match: prefixedParamPath('/api/admin/contacts/', 'id'),
      handle: (_req, res, { id }) => {
        const detail = contactsService.getContactDetail(id);
        if (!detail) {
          sendJson(res, 404, { error: 'Contact not found' });
          return;
        }
        sendJson(res, 200, detail);
      },
    },
    {
      method: 'PATCH',
      match: prefixedParamPath('/api/admin/contacts/', 'id'),
      handle: (req, res, { id }) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const result = contactsService.updateContact(id, JSON.stringify(parsed.value));
          if (!result.ok) {
            sendJson(res, result.message === 'Contact not found' ? 404 : 400, { error: result.message });
            return;
          }
          sendJson(res, 200, result);
        });
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/admin/settings'),
      handle: (_req, res) => {
        settingsService.getSettingsData().then(
          data => sendJson(res, 200, data),
          error => sendJson(res, 500, { error: String(error) }),
        );
      },
    },
    {
      method: 'PATCH',
      match: exactPath('/api/admin/settings'),
      handle: (req, res) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const result = settingsService.updateSettings(JSON.stringify(parsed.value));
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
      match: exactPath('/api/admin/identity'),
      handle: (_req, res) => {
        sendJson(res, 200, identityService.getIdentityData());
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/admin/identity/import'),
      handle: (req, res) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          identityService.importIdentityCard(JSON.stringify(parsed.value)).then(
            result => {
              if (!result.ok) {
                sendJson(res, 400, { error: result.message });
                return;
              }
              sendJson(res, 201, result);
            },
            error => sendJson(res, 500, { error: String(error) }),
          );
        });
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/admin/prompts'),
      handle: (_req, res) => {
        sendJson(res, 200, promptsService.listPrompts());
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
