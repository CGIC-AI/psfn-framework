import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../http/primitives.js';
import { VALID_MEMORY_TYPES, type MemoryType } from '../../memory/types.js';
import { VALID_SENSITIVITY_LEVELS, type SensitivityLevel } from '../../trust/types.js';
import { handleMultipartUpload, validateAndParseCharacterCardFile } from './multipart.js';
import { parseAdminJsonBody } from './request-body.js';
import { parseRequestUrl, resolveRequestOrigin } from './request-url.js';
import {
  exactPath,
  paramWithSuffix,
  prefixedParamPath,
  type RouteMatcher,
  type RouteParams,
} from './route-matchers.js';
import type {
  AdminAdaptiveToolsService,
  AdminContactsService,
  AdminDashboardService,
  AdminIdentityService,
  AdminMemoryService,
  AdminPromptsService,
  AdminSessionService,
  AdminSettingsService,
} from './services/types.js';
import {
  isDashboardCostWindow,
  resolveDashboardCostWindow,
} from './services/dashboard-cost-windows.js';
import type { RecurringCadence, ScheduledTask, TaskType } from '../../scheduler/types.js';
import type { SkillSnapshot } from '../../skills/types.js';
import type { SubstrateConfig } from '../../types.js';
import type {
  AdminAuditActionType,
  AdminAuditActor,
  AdminAuditDecision,
  ConfirmationQueueAdminApi,
} from './types.js';
import type { ValuesJournalEntry } from '../../values/store.js';
import type { ReflectionTemplate } from '../../scheduler/heartbeat-policy.js';
import type { AdminChatBootstrapUpdateInput } from './chat/types.js';
import { applyAdminModelsConfigMutation } from './services/settings-service.js';
import { loadModelsConfig } from '../../config/models-config.js';

export type AdminTaskCadence = RecurringCadence;

type ScheduledTaskWithCadence = ScheduledTask & { cadence?: AdminTaskCadence };

/** Wire-safe task shape (no handler function). */
export interface AdminScheduledTaskView {
  id: string;
  name: string;
  type: TaskType;
  intervalMs: number;
  runAt?: number;
  state: string;
  cadence?: AdminTaskCadence;
}

/** Minimal scheduler interface for JSON API routes. */
export interface AdminSchedulerApi {
  listTasks(): ScheduledTask[];
  /** Extended: full data with reflections. */
  getFullData?(): {
    tasks: AdminScheduledTaskView[];
    reflections: ReflectionTemplate[];
  };
  /** Extended: update a scheduler task. */
  updateTask?(id: string, updates: {
    intervalMs?: number;
    enabled?: boolean;
    name?: string;
    cadence?: unknown;
  }): { ok: boolean; message: string };
  /** Extended: create a new task. */
  createTask?(input: {
    id: string;
    name: string;
    type: TaskType;
    intervalMs?: number;
    runAt?: number;
    cadence?: unknown;
  }): { ok: boolean; message: string };
  /** Extended: remove a task. */
  removeTask?(id: string): { ok: boolean; message: string };
  /** Extended: update a reflection template. */
  updateReflection?(id: string, updates: Partial<ReflectionTemplate>): { ok: boolean; message: string };
}

/** Managed skill record shape returned by the store. */
export interface ManagedSkillRecord {
  name: string;
  description: string;
  category: string;
  version: number;
  content: string;
  createdAt: string;
  updatedAt: string;
}

/** Minimal skills runtime interface for JSON API routes. */
export interface AdminSkillsApi {
  getSnapshot(): SkillSnapshot;
  listManaged(): ManagedSkillRecord[];
  createSkill(input: { name: string; category: string; content: string; description?: string }): ManagedSkillRecord;
  updateSkill(input: { name: string; content: string; description?: string }): ManagedSkillRecord;
  deleteSkill(name: string): void;
  toggleSkill(name: string): boolean;
  getDisabledSkills(): string[];
  invalidate(): void;
}

/** Minimal values journal interface for JSON API routes. */
export interface AdminValuesJournalApi {
  list(options?: { limit?: number }): ValuesJournalEntry[];
}

export interface AdminModelDiscoveryApi {
  getAvailableModels(): Promise<unknown[]>;
  invalidateCache(): void;
}

export interface AdminChatBootstrapApi {
  buildBootstrap(options?: { requestOrigin?: string; settingsApiBaseUrl?: string }): unknown;
  updateSelection(
    input: AdminChatBootstrapUpdateInput,
    options?: { requestOrigin?: string; settingsApiBaseUrl?: string },
  ): unknown;
  buildModelRoomBootstrap(
    config: SubstrateConfig,
    options?: { requestOrigin?: string; settingsApiBaseUrl?: string },
  ): unknown;
}

export interface AdminApiRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  match: RouteMatcher;
  handle: (req: IncomingMessage, res: ServerResponse, params: RouteParams) => void;
}

function escapeHtmlPayloadText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&#39;');
}

function toSanitizedMessage(value: unknown, fallback: string): string {
  const normalized = typeof value === 'string'
    ? value.trim()
    : (value instanceof Error ? value.message.trim() : String(value ?? '').trim());
  return escapeHtmlPayloadText(normalized || fallback);
}

function toMemoryType(value: string | null): MemoryType | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  return VALID_MEMORY_TYPES.includes(normalized as MemoryType)
    ? normalized as MemoryType
    : undefined;
}

function toSensitivityLevel(value: string | null): SensitivityLevel | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  return VALID_SENSITIVITY_LEVELS.includes(normalized as SensitivityLevel)
    ? normalized as SensitivityLevel
    : undefined;
}

function toDateFilter(value: string | null, boundary: 'start' | 'end'): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dateOnly) {
    const year = Number.parseInt(dateOnly[1], 10);
    const monthIndex = Number.parseInt(dateOnly[2], 10) - 1;
    const day = Number.parseInt(dateOnly[3], 10);
    const validatedDate = new Date(Date.UTC(year, monthIndex, day));
    if (
      validatedDate.getUTCFullYear() !== year
      || validatedDate.getUTCMonth() !== monthIndex
      || validatedDate.getUTCDate() !== day
    ) {
      return undefined;
    }
    if (boundary === 'start') {
      return Date.UTC(year, monthIndex, day, 0, 0, 0, 0);
    }
    return Date.UTC(year, monthIndex, day, 23, 59, 59, 999);
  }

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return undefined;
  return parsed;
}

const ADMIN_SETTINGS_API_PATH = '/api/admin/settings';
const ADMIN_SETTINGS_MODELS_API_PATH = '/api/admin/settings/models';
const ADMIN_MODELS_API_PATH = '/api/admin/models';
const ADMIN_MODELS_REFRESH_API_PATH = '/api/admin/models/refresh';
const ADMIN_CHAT_BOOTSTRAP_API_PATH = '/api/admin/chat/bootstrap';
const ADMIN_CHAT_MODEL_ROOM_BOOTSTRAP_API_PATH = '/api/admin/chat/model-room/bootstrap';
const MODEL_DISCOVERY_UNAVAILABLE_ERROR = 'Model discovery backend unavailable';
const ADMIN_DYNAMIC_JSON_HEADERS = { 'Cache-Control': 'no-store' } as const;

export function buildAdminApiRoutes(options: {
  config: SubstrateConfig;
  dashboardService: AdminDashboardService;
  adaptiveToolsService?: AdminAdaptiveToolsService | null;
  memoryService: AdminMemoryService;
  sessionService: AdminSessionService;
  contactsService: AdminContactsService;
  settingsService: AdminSettingsService;
  identityService: AdminIdentityService;
  promptsService: AdminPromptsService;
  modelDiscovery?: AdminModelDiscoveryApi | null;
  chatBootstrapService: AdminChatBootstrapApi;
  scheduler?: AdminSchedulerApi | null;
  skillsRuntime?: AdminSkillsApi | null;
  confirmationQueueApi?: ConfirmationQueueAdminApi | null;
  valuesJournal?: AdminValuesJournalApi | null;
  appendAuditTimelineEntry?: (
    actionType: AdminAuditActionType,
    decision: AdminAuditDecision,
    narrative: string,
    details?: Array<string | null | undefined>,
    actor?: AdminAuditActor,
  ) => void;
  withBody: (req: IncomingMessage, res: ServerResponse, cb: (body: string) => void) => void;
}): AdminApiRoute[] {
  const {
    config,
    dashboardService,
    adaptiveToolsService,
    memoryService,
    sessionService,
    contactsService,
    settingsService,
    identityService,
    promptsService,
    modelDiscovery,
    chatBootstrapService,
    scheduler,
    skillsRuntime,
    confirmationQueueApi,
    valuesJournal,
    appendAuditTimelineEntry,
    withBody,
  } = options;

  const appendIdentityMutationAudit = (
    decision: AdminAuditDecision,
    narrative: string,
    details: Array<string | null | undefined> = [],
  ): void => {
    appendAuditTimelineEntry?.('identity_edit', decision, narrative, details, 'operator');
  };

  const appendSettingsMutationAudit = (
    decision: AdminAuditDecision,
    narrative: string,
    details: Array<string | null | undefined> = [],
  ): void => {
    appendAuditTimelineEntry?.('settings_change', decision, narrative, details, 'operator');
  };

  const handleContactUpdate = (req: IncomingMessage, res: ServerResponse, id: string): void => {
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
  };

  const handleDiscoveredModels = (res: ServerResponse, refresh: boolean): void => {
    if (!modelDiscovery) {
      sendJson(res, 503, { error: MODEL_DISCOVERY_UNAVAILABLE_ERROR });
      return;
    }

    if (refresh) {
      modelDiscovery.invalidateCache();
    }

    modelDiscovery.getAvailableModels().then(
      models => sendJson(res, 200, models),
      error => sendJson(res, 502, {
        error: toSanitizedMessage(error, 'Model discovery failed'),
      }),
    );
  };

  const handleChatBootstrapUpdate = (req: IncomingMessage, res: ServerResponse): void => {
    withBody(req, res, (body) => {
      const parsed = parseAdminJsonBody(body);
      if (!parsed.ok) {
        sendJson(res, 400, { error: parsed.error });
        return;
      }
      if (
        parsed.value !== null
        && (typeof parsed.value !== 'object' || Array.isArray(parsed.value))
      ) {
        sendJson(res, 400, { error: 'Chat bootstrap payload must be a JSON object' });
        return;
      }

      try {
        const bootstrap = chatBootstrapService.updateSelection(
          (parsed.value ?? {}) as AdminChatBootstrapUpdateInput,
          { requestOrigin: resolveRequestOrigin(req) },
        );
        sendJson(res, 200, { ok: true, bootstrap });
      } catch (error) {
        sendJson(res, 400, {
          error: toSanitizedMessage(error, 'Failed to update chat bootstrap'),
        });
      }
    });
  };

  return [
    {
      method: 'GET',
      match: exactPath('/api/admin/dashboard'),
      handle: (req, res) => {
        const url = parseRequestUrl(req, '/api/admin/dashboard');
        const costWindowParam = url.searchParams.get('costWindow');
        if (costWindowParam !== null && !isDashboardCostWindow(costWindowParam)) {
          sendJson(res, 400, { error: 'Invalid costWindow query parameter. Expected today, week, or month.' });
          return;
        }
        const costWindow = resolveDashboardCostWindow(costWindowParam);
        sendJson(res, 200, dashboardService.getDashboardData({ costWindow }));
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/admin/tools/adaptive'),
      handle: (_req, res) => {
        if (!adaptiveToolsService) {
          sendJson(res, 200, {
            state: null,
            catalog: null,
            serviceHealth: [],
            toolHealth: [],
            recentFailures: [],
            recentTelemetry: [],
          });
          return;
        }
        adaptiveToolsService.getAdaptiveToolsData().then(
          (payload) => {
            sendJson(res, 200, payload);
          },
          (error) => {
            sendJson(res, 500, {
              error: `Failed to load adaptive tools data: ${toSanitizedMessage(error, 'unknown error')}`,
            });
          },
        );
      },
    },
    {
      method: 'GET',
      match: exactPath(ADMIN_CHAT_BOOTSTRAP_API_PATH),
      handle: (req, res) => {
        try {
          sendJson(res, 200, chatBootstrapService.buildBootstrap({
            requestOrigin: resolveRequestOrigin(req),
          }));
        } catch (error) {
          sendJson(res, 500, {
            error: toSanitizedMessage(error, 'Failed to build chat bootstrap'),
          });
        }
      },
    },
    {
      method: 'PATCH',
      match: exactPath(ADMIN_CHAT_BOOTSTRAP_API_PATH),
      handle: (req, res) => {
        handleChatBootstrapUpdate(req, res);
      },
    },
    {
      method: 'POST',
      match: exactPath(ADMIN_CHAT_BOOTSTRAP_API_PATH),
      handle: (req, res) => {
        handleChatBootstrapUpdate(req, res);
      },
    },
    {
      method: 'GET',
      match: exactPath(ADMIN_CHAT_MODEL_ROOM_BOOTSTRAP_API_PATH),
      handle: (req, res) => {
        try {
          sendJson(res, 200, chatBootstrapService.buildModelRoomBootstrap(config, {
            requestOrigin: resolveRequestOrigin(req),
          }));
        } catch (error) {
          sendJson(res, 500, {
            error: toSanitizedMessage(error, 'Failed to build model room bootstrap'),
          });
        }
      },
    },
    {
      method: 'GET',
      match: exactPath(ADMIN_MODELS_API_PATH),
      handle: (_req, res) => {
        handleDiscoveredModels(res, false);
      },
    },
    {
      method: 'POST',
      match: exactPath(ADMIN_MODELS_REFRESH_API_PATH),
      handle: (_req, res) => {
        handleDiscoveredModels(res, true);
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/admin/memory'),
      handle: (req, res) => {
        const url = parseRequestUrl(req, '/api/admin/memory');
        const typeFilter = toMemoryType(url.searchParams.get('type'));
        if (url.searchParams.get('type') && !typeFilter) {
          sendJson(res, 400, { error: 'Invalid memory type filter' });
          return;
        }
        const sensitivityFilter = toSensitivityLevel(url.searchParams.get('sensitivity'));
        if (url.searchParams.get('sensitivity') && !sensitivityFilter) {
          sendJson(res, 400, { error: 'Invalid memory sensitivity filter' });
          return;
        }
        const startDate = toDateFilter(url.searchParams.get('startDate'), 'start');
        if (url.searchParams.get('startDate') && startDate === undefined) {
          sendJson(res, 400, { error: 'Invalid startDate filter' });
          return;
        }
        const endDate = toDateFilter(url.searchParams.get('endDate'), 'end');
        if (url.searchParams.get('endDate') && endDate === undefined) {
          sendJson(res, 400, { error: 'Invalid endDate filter' });
          return;
        }
        if (startDate !== undefined && endDate !== undefined && startDate > endDate) {
          sendJson(res, 400, { error: 'startDate must be before or equal to endDate' });
          return;
        }
        const data = memoryService.listMemories(url.searchParams);
        sendJson(res, 200, {
          ...data,
          contactsById: Object.fromEntries(data.contactsById.entries()),
        });
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/admin/memory/search'),
      handle: (req, res) => {
        const url = parseRequestUrl(req, '/api/admin/memory/search');
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
      match: exactPath('/api/admin/memory/scopes'),
      handle: (req, res) => {
        const url = parseRequestUrl(req, '/api/admin/memory/scopes');
        const kind = url.searchParams.get('kind');
        if (kind && !['project', 'north_star'].includes(kind.trim().toLowerCase())) {
          sendJson(res, 400, { error: 'Invalid managed memory scope kind' });
          return;
        }
        sendJson(res, 200, memoryService.listManagedScopes(url.searchParams));
      },
    },
    {
      method: 'GET',
      match: paramWithSuffix('/api/admin/memory/scopes/', 'scopeKey', '/detail'),
      handle: (_req, res, { scopeKey }) => {
        const separator = scopeKey.indexOf(':');
        const kind = separator >= 0 ? scopeKey.slice(0, separator) : '';
        const id = separator >= 0 ? scopeKey.slice(separator + 1) : '';
        const detail = memoryService.getManagedScopeDetail(kind, id);
        if (!detail) {
          sendJson(res, 404, { error: 'Managed memory scope not found' });
          return;
        }
        sendJson(res, 200, detail);
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/admin/memory/scope-update'),
      handle: (req, res) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const payload = parsed.value as Record<string, unknown>;
          const id = typeof payload.id === 'string' ? payload.id.trim() : '';
          const rawScopeRef = payload.scopeRef;
          const scopeRef = rawScopeRef === null
            ? null
            : (typeof rawScopeRef === 'object' && rawScopeRef !== null
              ? rawScopeRef as { kind?: string; id?: string; label?: string }
              : undefined);
          const scopeTags = Array.isArray(payload.scopeTags)
            ? payload.scopeTags.filter((value): value is string => typeof value === 'string')
            : undefined;
          const repair = payload.repair === true;

          if (!id) {
            sendJson(res, 400, { error: 'Memory id is required' });
            return;
          }
          if (scopeRef === undefined && scopeTags === undefined && !repair) {
            sendJson(res, 400, { error: 'scopeRef, scopeTags, or repair=true is required' });
            return;
          }

          const result = memoryService.updateMemoryScope(id, { scopeRef, scopeTags, repair });
          if (!result.ok) {
            const status = result.message === 'Memory not found' ? 404 : 400;
            sendJson(res, status, { error: result.message ?? 'Failed to update memory scope' });
            return;
          }
          sendJson(res, 200, result);
        });
      },
    },
    // ── Memory Linking ──
    {
      method: 'POST',
      match: exactPath('/api/admin/memory/link'),
      handle: (req, res) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const payload = parsed.value as Record<string, unknown>;
          const id1 = typeof payload.id1 === 'string' ? payload.id1.trim() : '';
          const id2 = typeof payload.id2 === 'string' ? payload.id2.trim() : '';
          const linkType = typeof payload.linkType === 'string' ? payload.linkType.trim() : undefined;

          if (!id1 || !id2) {
            sendJson(res, 400, { error: 'Both id1 and id2 are required' });
            return;
          }

          const result = memoryService.linkMemories(id1, id2, linkType);
          if (!result.ok) {
            sendJson(res, 400, { error: result.message ?? 'Failed to create link' });
            return;
          }
          sendJson(res, 201, result);
        });
      },
    },
    {
      method: 'DELETE',
      match: exactPath('/api/admin/memory/link'),
      handle: (req, res) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const payload = parsed.value as Record<string, unknown>;
          const id1 = typeof payload.id1 === 'string' ? payload.id1.trim() : '';
          const id2 = typeof payload.id2 === 'string' ? payload.id2.trim() : '';

          if (!id1 || !id2) {
            sendJson(res, 400, { error: 'Both id1 and id2 are required' });
            return;
          }

          const result = memoryService.unlinkMemories(id1, id2);
          if (!result.ok) {
            sendJson(res, 404, { error: result.message ?? 'Link not found' });
            return;
          }
          sendJson(res, 200, { ok: true });
        });
      },
    },
    // ── Bulk Operations ──
    {
      method: 'POST',
      match: exactPath('/api/admin/memory/bulk-delete'),
      handle: (req, res) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const payload = parsed.value as Record<string, unknown>;
          const ids = Array.isArray(payload.ids)
            ? payload.ids.filter((v): v is string => typeof v === 'string')
            : [];

          if (!ids.length) {
            sendJson(res, 400, { error: 'ids array is required and must not be empty' });
            return;
          }

          const result = memoryService.bulkDelete(ids);
          if (!result.ok) {
            sendJson(res, 400, { error: result.message ?? 'Bulk delete failed' });
            return;
          }
          sendJson(res, 200, result);
        });
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/admin/memory/bulk-update'),
      handle: (req, res) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const payload = parsed.value as Record<string, unknown>;
          const ids = Array.isArray(payload.ids)
            ? payload.ids.filter((v): v is string => typeof v === 'string')
            : [];
          const fields = typeof payload.fields === 'object' && payload.fields !== null
            ? payload.fields as Record<string, unknown>
            : {};

          if (!ids.length) {
            sendJson(res, 400, { error: 'ids array is required and must not be empty' });
            return;
          }

          const memoryType = typeof fields.memoryType === 'string' ? fields.memoryType : undefined;
          const sensitivity = typeof fields.sensitivity === 'string' ? fields.sensitivity : undefined;

          if (!memoryType && !sensitivity) {
            sendJson(res, 400, { error: 'At least one field (memoryType, sensitivity) is required' });
            return;
          }

          const result = memoryService.bulkUpdate(ids, { memoryType, sensitivity });
          if (!result.ok) {
            sendJson(res, 400, { error: result.message ?? 'Bulk update failed' });
            return;
          }
          sendJson(res, 200, result);
        });
      },
    },
    // Sub-path route MUST come before generic prefixed param route
    {
      method: 'GET',
      match: paramWithSuffix('/api/admin/memory/', 'id', '/links'),
      handle: (_req, res, { id }) => {
        const links = memoryService.getMemoryLinks(id);
        sendJson(res, 200, { links });
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
        const url = parseRequestUrl(req, '/api/admin/contacts');
        const data = contactsService.listContacts(url.searchParams);
        sendJson(
          res,
          200,
          {
            ...data,
            profileMap: Object.fromEntries(data.profileMap.entries()),
            relatedChannelMap: Object.fromEntries(data.relatedChannelMap.entries()),
            socialGraphMap: Object.fromEntries(data.socialGraphMap.entries()),
          },
          ADMIN_DYNAMIC_JSON_HEADERS,
        );
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/admin/contacts'),
      handle: (req, res) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const result = contactsService.createContact(JSON.stringify(parsed.value));
          if (!result.ok) {
            sendJson(res, 400, { error: result.message });
            return;
          }
          sendJson(res, 201, result);
        });
      },
    },
    // Sub-path routes MUST come before generic prefixed param route for contacts
    {
      method: 'POST',
      match: paramWithSuffix('/api/admin/contacts/', 'id', '/merge'),
      handle: (req, res, { id }) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const result = contactsService.mergeContacts(id, JSON.stringify(parsed.value));
          if (!result.ok) {
            sendJson(res, result.message.includes('not found') ? 404 : 400, { error: result.message });
            return;
          }
          sendJson(res, 200, result);
        });
      },
    },
    {
      method: 'POST',
      match: paramWithSuffix('/api/admin/contacts/', 'id', '/unlink'),
      handle: (req, res, { id }) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const result = contactsService.unlinkChannelIdentity(id, JSON.stringify(parsed.value));
          if (!result.ok) {
            sendJson(res, result.message.includes('not found') ? 404 : 400, { error: result.message });
            return;
          }
          sendJson(res, 200, result);
        });
      },
    },
    {
      method: 'POST',
      match: paramWithSuffix('/api/admin/contacts/', 'id', '/conversation-channel/delete'),
      handle: (req, res, { id }) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const deleteConversationChannel = (
            contactsService as AdminContactsService & {
              deleteConversationChannel?: (contactId: string, requestBody: string) => { ok: boolean; message: string };
            }
          ).deleteConversationChannel;
          if (typeof deleteConversationChannel !== 'function') {
            sendJson(res, 400, { error: 'Conversation channel deletion is not available' });
            return;
          }
          const result = deleteConversationChannel(id, JSON.stringify(parsed.value));
          if (!result.ok) {
            sendJson(res, result.message.includes('not found') ? 404 : 400, { error: result.message });
            return;
          }
          sendJson(res, 200, result);
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
        sendJson(res, 200, detail, ADMIN_DYNAMIC_JSON_HEADERS);
      },
    },
    {
      method: 'DELETE',
      match: prefixedParamPath('/api/admin/contacts/', 'id'),
      handle: (_req, res, { id }) => {
        const result = contactsService.deleteContact(id);
        if (!result.ok) {
          sendJson(res, result.message.includes('not found') ? 404 : 400, { error: result.message });
          return;
        }
        sendJson(res, 200, result);
      },
    },
    {
      method: 'PUT',
      match: prefixedParamPath('/api/admin/contacts/', 'id'),
      handle: (req, res, { id }) => {
        handleContactUpdate(req, res, id);
      },
    },
    {
      method: 'PATCH',
      match: prefixedParamPath('/api/admin/contacts/', 'id'),
      handle: (req, res, { id }) => {
        handleContactUpdate(req, res, id);
      },
    },
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
        try {
          const models = loadModelsConfig(config.dataDir, {
            defaultContextWindow: config.defaultContextWindow,
          });
          sendJson(res, 200, models.modelRegistry);
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

          let payload: unknown;
          try {
            payload = JSON.parse(configJson);
          } catch {
            sendJson(res, 400, { error: 'configJson must be valid JSON' });
            return;
          }

          const result = applyAdminModelsConfigMutation({ config, payload });
          if (!result.ok) {
            sendJson(res, 400, {
              error: result.message,
              ...result,
            });
            return;
          }

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
            sendJson(res, 400, { error: result.message });
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(result.message);
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
            appendIdentityMutationAudit(
              'denied',
              'Operator identity import via /api/admin/identity/import failed: invalid JSON payload.',
            );
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const payload = parsed.value as Record<string, unknown>;
          const rawPath = typeof payload.path === 'string' ? payload.path.trim() : '';
          identityService.importIdentityCard(JSON.stringify(parsed.value)).then(
            result => {
              const safeMessage = toSanitizedMessage(result.message, 'Identity import failed');
              if (!result.ok) {
                appendIdentityMutationAudit(
                  'denied',
                  `Operator identity import via /api/admin/identity/import failed: ${safeMessage}`,
                  [rawPath ? `path=${rawPath}` : null],
                );
                sendJson(res, 400, { error: safeMessage });
                return;
              }
              appendIdentityMutationAudit(
                'allowed',
                'Operator imported identity card via /api/admin/identity/import.',
                [
                  rawPath ? `path=${rawPath}` : null,
                  safeMessage,
                ],
              );
              sendJson(res, 201, { ...result, message: safeMessage });
            },
            error => {
              const safeError = toSanitizedMessage(error, 'Identity import failed unexpectedly');
              appendIdentityMutationAudit(
                'denied',
                `Operator identity import via /api/admin/identity/import failed: ${safeError}`,
                [rawPath ? `path=${rawPath}` : null],
              );
              sendJson(res, 500, { error: safeError });
            },
          );
        });
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/admin/identity/upload'),
      handle: (req, res) => {
        handleMultipartUpload(req, res).then(
          (uploadResult) => {
            if (!uploadResult.ok) {
              const safeError = toSanitizedMessage(uploadResult.error, 'Identity upload failed');
              appendIdentityMutationAudit(
                'denied',
                `Operator identity upload via /api/admin/identity/upload failed: ${safeError}`,
              );
              sendJson(res, uploadResult.status, { error: safeError });
              return;
            }
            const cardResult = validateAndParseCharacterCardFile(uploadResult.file);
            if (!cardResult.ok) {
              const safeError = toSanitizedMessage(cardResult.error, 'Identity upload failed');
              appendIdentityMutationAudit(
                'denied',
                `Operator identity upload via /api/admin/identity/upload failed: ${safeError}`,
                [`filename=${uploadResult.file.filename}`],
              );
              sendJson(res, 400, { error: safeError });
              return;
            }
            // Pass the parsed card data as a JSON string to the import service
            identityService.importIdentityCard(JSON.stringify({ cardData: cardResult.cardData })).then(
              result => {
                const safeMessage = toSanitizedMessage(result.message, 'Identity upload import failed');
                if (!result.ok) {
                  appendIdentityMutationAudit(
                    'denied',
                    `Operator identity upload via /api/admin/identity/upload failed: ${safeMessage}`,
                    [`filename=${cardResult.filename}`],
                  );
                  sendJson(res, 400, { error: safeMessage });
                  return;
                }
                appendIdentityMutationAudit(
                  'allowed',
                  'Operator imported identity card via /api/admin/identity/upload.',
                  [
                    `filename=${cardResult.filename}`,
                    `container=${cardResult.containerFormat}`,
                    `source=${cardResult.sourceFormat}`,
                    `spec=${cardResult.spec}`,
                    safeMessage,
                  ],
                );
                sendJson(res, 201, {
                  ...result,
                  message: safeMessage,
                  filename: cardResult.filename,
                  containerFormat: cardResult.containerFormat,
                  sourceFormat: cardResult.sourceFormat,
                  spec: cardResult.spec,
                  warnings: cardResult.warnings,
                });
              },
              error => {
                const safeError = toSanitizedMessage(error, 'Identity upload import failed unexpectedly');
                appendIdentityMutationAudit(
                  'denied',
                  `Operator identity upload via /api/admin/identity/upload failed: ${safeError}`,
                  [`filename=${cardResult.filename}`],
                );
                sendJson(res, 500, { error: safeError });
              },
            );
          },
          (error) => {
            const safeError = toSanitizedMessage(error, 'Identity upload failed unexpectedly');
            appendIdentityMutationAudit(
              'denied',
              `Operator identity upload via /api/admin/identity/upload failed: ${safeError}`,
            );
            sendJson(res, 500, { error: safeError });
          },
        );
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/admin/identity/rollback'),
      handle: (req, res) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            appendIdentityMutationAudit(
              'denied',
              'Operator identity rollback via /api/admin/identity/rollback failed: invalid JSON payload.',
            );
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const payload = parsed.value as Record<string, unknown>;
          const rawVersion = typeof payload.version === 'number' || typeof payload.version === 'string'
            ? String(payload.version)
            : '';
          const result = identityService.rollbackIdentityCard(JSON.stringify(parsed.value));
          if (!result.ok) {
            appendIdentityMutationAudit(
              'denied',
              `Operator identity rollback via /api/admin/identity/rollback failed: ${result.message}`,
              [rawVersion ? `version=${rawVersion}` : null],
            );
            sendJson(res, 400, { error: result.message });
            return;
          }
          appendIdentityMutationAudit(
            'allowed',
            'Operator rolled identity card back via /api/admin/identity/rollback.',
            [
              rawVersion ? `targetVersion=${rawVersion}` : null,
              result.snapshot ? `currentVersion=${result.snapshot.version}` : null,
            ],
          );
          sendJson(res, 200, result);
        });
      },
    },
    {
      method: 'PATCH',
      match: exactPath('/api/admin/identity/fields'),
      handle: (req, res) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            appendIdentityMutationAudit(
              'denied',
              'Operator identity field update via /api/admin/identity/fields failed: invalid JSON payload.',
            );
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const payload = parsed.value as Record<string, unknown>;
          const field = typeof payload.field === 'string' ? payload.field.trim() : '';
          const result = identityService.updateIdentityField(JSON.stringify(parsed.value));
          if (!result.ok) {
            appendIdentityMutationAudit(
              'denied',
              `Operator identity field update via /api/admin/identity/fields failed: ${result.message}`,
              [field ? `field=${field}` : null],
            );
            sendJson(res, 400, { error: result.message });
            return;
          }
          appendIdentityMutationAudit(
            'allowed',
            'Operator updated identity field via /api/admin/identity/fields.',
            [
              field ? `field=${field}` : null,
              result.message || null,
            ],
          );
          sendJson(res, 200, result);
        });
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/admin/identity/onboarding'),
      handle: (req, res) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            appendIdentityMutationAudit(
              'denied',
              'Operator onboarding setup via /api/admin/identity/onboarding failed: invalid JSON payload.',
            );
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const payload = parsed.value as Record<string, unknown>;
          const action = typeof payload.action === 'string' ? payload.action.trim() : '';
          identityService.applyOnboardingAction(JSON.stringify(parsed.value)).then(
            result => {
              const safeMessage = toSanitizedMessage(result.message, 'Identity onboarding action failed');
              if (!result.ok) {
                appendIdentityMutationAudit(
                  'denied',
                  `Operator onboarding setup via /api/admin/identity/onboarding failed: ${safeMessage}`,
                  [action ? `action=${action}` : null],
                );
                sendJson(res, 400, { error: safeMessage, onboardingRequired: result.onboardingRequired });
                return;
              }
              appendIdentityMutationAudit(
                'allowed',
                'Operator completed identity onboarding action via /api/admin/identity/onboarding.',
                [
                  action ? `action=${action}` : null,
                  safeMessage,
                ],
              );
              sendJson(res, 200, { ...result, message: safeMessage });
            },
            error => {
              const safeError = toSanitizedMessage(error, 'Identity onboarding action failed unexpectedly');
              appendIdentityMutationAudit(
                'denied',
                `Operator onboarding setup via /api/admin/identity/onboarding failed: ${safeError}`,
                [action ? `action=${action}` : null],
              );
              sendJson(res, 500, { error: safeError });
            },
          );
        });
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/admin/identity/diff'),
      handle: (req, res) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const result = identityService.previewIdentityCardDiff(JSON.stringify(parsed.value));
          sendJson(res, 200, result);
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
      method: 'GET',
      match: exactPath('/api/admin/prompts/constitution'),
      handle: (_req, res) => {
        const snapshot = promptsService.getConstitutionSnapshot();
        if (!snapshot) {
          sendJson(res, 400, { error: 'Prompt store not configured' });
          return;
        }
        sendJson(res, 200, snapshot);
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
    // ── Scheduler ──
    {
      method: 'GET',
      match: exactPath('/api/admin/scheduler'),
      handle: (_req, res) => {
        if (!scheduler) {
          sendJson(res, 200, { tasks: [], reflections: [] });
          return;
        }
        if (scheduler.getFullData) {
          sendJson(res, 200, scheduler.getFullData());
        } else {
          const tasks = scheduler.listTasks().map(task => ({
            id: task.id,
            name: task.name,
            type: task.type,
            intervalMs: task.intervalMs,
            runAt: task.runAt,
            state: task.state,
            cadence: task.type === 'every'
              ? (task as ScheduledTaskWithCadence).cadence
              : undefined,
          }));
          sendJson(res, 200, { tasks, reflections: [] });
        }
      },
    },
    {
      method: 'PATCH',
      match: prefixedParamPath('/api/admin/scheduler/tasks/', 'taskId'),
      handle: (req, res, { taskId }) => {
        if (!scheduler?.updateTask) {
          sendJson(res, 400, { ok: false, message: 'Scheduler mutation not available' });
          return;
        }
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { ok: false, message: parsed.error });
            return;
          }
          const updates = parsed.value as {
            intervalMs?: number;
            enabled?: boolean;
            name?: string;
            cadence?: unknown;
          };
          const result = scheduler.updateTask!(taskId, updates);
          sendJson(res, result.ok ? 200 : 400, result);
        });
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/admin/scheduler/tasks'),
      handle: (req, res) => {
        if (!scheduler?.createTask) {
          sendJson(res, 400, { ok: false, message: 'Scheduler mutation not available' });
          return;
        }
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { ok: false, message: parsed.error });
            return;
          }
          const input = parsed.value as {
            id: string;
            name: string;
            type: TaskType;
            intervalMs?: number;
            runAt?: number;
            cadence?: unknown;
          };
          const result = scheduler.createTask!(input);
          sendJson(res, result.ok ? 201 : 400, result);
        });
      },
    },
    {
      method: 'DELETE',
      match: prefixedParamPath('/api/admin/scheduler/tasks/', 'taskId'),
      handle: (_req, res, { taskId }) => {
        if (!scheduler?.removeTask) {
          sendJson(res, 400, { ok: false, message: 'Scheduler mutation not available' });
          return;
        }
        const result = scheduler.removeTask!(taskId);
        sendJson(res, result.ok ? 200 : 400, result);
      },
    },
    {
      method: 'PATCH',
      match: prefixedParamPath('/api/admin/scheduler/reflections/', 'reflectionId'),
      handle: (req, res, { reflectionId }) => {
        if (!scheduler?.updateReflection) {
          sendJson(res, 400, { ok: false, message: 'Reflection mutation not available' });
          return;
        }
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { ok: false, message: parsed.error });
            return;
          }
          const updates = parsed.value as Partial<ReflectionTemplate>;
          const result = scheduler.updateReflection!(reflectionId, updates);
          sendJson(res, result.ok ? 200 : 400, result);
        });
      },
    },
    // ── Skills ──
    {
      method: 'GET',
      match: exactPath('/api/admin/skills'),
      handle: (_req, res) => {
        if (!skillsRuntime) {
          sendJson(res, 200, { snapshot: null, managed: [], disabledSkills: [] });
          return;
        }
        const snapshot = skillsRuntime.getSnapshot();
        const managed = skillsRuntime.listManaged();
        const disabledSkills = skillsRuntime.getDisabledSkills();
        sendJson(res, 200, { snapshot, managed, disabledSkills });
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/admin/skills'),
      handle: (req, res) => {
        if (!skillsRuntime) {
          sendJson(res, 400, { error: 'Skills runtime not available' });
          return;
        }
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          try {
            const input = parsed.value as { name: string; category: string; content: string; description?: string };
            const result = skillsRuntime!.createSkill(input);
            skillsRuntime!.invalidate();
            sendJson(res, 201, { ok: true, skill: result });
          } catch (e) {
            sendJson(res, 400, { error: String(e instanceof Error ? e.message : e) });
          }
        });
      },
    },
    {
      method: 'PATCH',
      match: exactPath('/api/admin/skills'),
      handle: (req, res) => {
        if (!skillsRuntime) {
          sendJson(res, 400, { error: 'Skills runtime not available' });
          return;
        }
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          try {
            const input = parsed.value as { name: string; content: string; description?: string };
            const result = skillsRuntime!.updateSkill(input);
            skillsRuntime!.invalidate();
            sendJson(res, 200, { ok: true, skill: result });
          } catch (e) {
            sendJson(res, 400, { error: String(e instanceof Error ? e.message : e) });
          }
        });
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/admin/skills/toggle'),
      handle: (req, res) => {
        if (!skillsRuntime) {
          sendJson(res, 400, { error: 'Skills runtime not available' });
          return;
        }
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          try {
            const { name } = parsed.value as { name: string };
            if (!name.trim()) {
              sendJson(res, 400, { error: 'Skill name is required' });
              return;
            }
            const nowEnabled = skillsRuntime!.toggleSkill(name);
            sendJson(res, 200, { ok: true, name: name.trim(), enabled: nowEnabled });
          } catch (e) {
            sendJson(res, 400, { error: String(e instanceof Error ? e.message : e) });
          }
        });
      },
    },
    {
      method: 'DELETE',
      match: prefixedParamPath('/api/admin/skills/', 'name'),
      handle: (_req, res, { name }) => {
        if (!skillsRuntime) {
          sendJson(res, 400, { error: 'Skills runtime not available' });
          return;
        }
        try {
          skillsRuntime.deleteSkill(name);
          sendJson(res, 200, { ok: true });
        } catch (e) {
          sendJson(res, 400, { error: String(e instanceof Error ? e.message : e) });
        }
      },
    },
    // ── Confirmations ──
    {
      method: 'GET',
      match: exactPath('/api/admin/confirmations'),
      handle: (_req, res) => {
        if (!confirmationQueueApi) {
          sendJson(res, 200, {
            entries: [],
            available: false,
            message: 'Confirmation queue is unavailable (gateway integration not configured).',
          });
          return;
        }
        confirmationQueueApi.listConfirmationQueue().then(
          (result) => {
            sendJson(res, 200, {
              entries: result.entries,
              available: true,
            });
          },
          (error) => {
            sendJson(res, 200, {
              entries: [],
              available: true,
              message: `Unable to load confirmation queue: ${String(error)}`,
            });
          },
        );
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/admin/confirmations/resolve'),
      handle: (req, res) => {
        if (!confirmationQueueApi) {
          sendJson(res, 400, { ok: false, message: 'Confirmation queue is unavailable' });
          return;
        }
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { ok: false, message: parsed.error });
            return;
          }
          const payload = parsed.value as Record<string, unknown>;
          const id = (typeof payload.id === 'string' ? payload.id : '').trim();
          const decision = (typeof payload.decision === 'string' ? payload.decision : '').trim();

          if (!id) {
            sendJson(res, 400, { ok: false, message: 'Confirmation ID is required' });
            return;
          }
          if (decision !== 'approve' && decision !== 'deny' && decision !== 'modify') {
            sendJson(res, 400, { ok: false, message: 'Invalid decision (must be approve, deny, or modify)' });
            return;
          }

          const resolveParams: { id: string; decision: 'approve' | 'deny' | 'modify'; modifiedParams?: Record<string, unknown> } = { id, decision };
          if (decision === 'modify' && payload.modifiedParams && typeof payload.modifiedParams === 'object') {
            resolveParams.modifiedParams = payload.modifiedParams as Record<string, unknown>;
          }

          confirmationQueueApi!.resolveConfirmationQueue(resolveParams).then(
            (result) => {
              sendJson(res, 200, {
                ok: result.status === 'approved' || result.status === 'modified',
                message: result.message,
                status: result.status,
                executed: result.executed,
              });
            },
            (error) => {
              sendJson(res, 500, { ok: false, message: `Confirmation resolve failed: ${String(error)}` });
            },
          );
        });
      },
    },
    // ── Values Timeline ──
    {
      method: 'GET',
      match: exactPath('/api/admin/values'),
      handle: (_req, res) => {
        if (!valuesJournal) {
          sendJson(res, 200, { entries: [] });
          return;
        }
        const entries = valuesJournal.list({ limit: 250 });
        sendJson(res, 200, { entries });
      },
    },
  ];
}
