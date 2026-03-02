import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseJsonBody, sendJson } from '../http/primitives.js';
import { VALID_MEMORY_TYPES, type MemoryType } from '../../memory/types.js';
import { handleMultipartUpload, validateAndParseJsonFile } from './multipart.js';
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
import type { ScheduledTask, TaskType } from '../../scheduler/types.js';
import type { SkillSnapshot } from '../../skills/types.js';
import type {
  AdminAuditActionType,
  AdminAuditActor,
  AdminAuditDecision,
  ConfirmationQueueAdminApi,
} from './types.js';
import type { ValuesJournalEntry } from '../../values/store.js';
import type { ReflectionTemplate } from '../../scheduler/heartbeat-policy.js';

/** Wire-safe task shape (no handler function). */
export interface AdminScheduledTaskView {
  id: string;
  name: string;
  type: TaskType;
  intervalMs: number;
  runAt?: number;
  state: string;
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
  }): { ok: boolean; message: string };
  /** Extended: create a new task. */
  createTask?(input: {
    id: string;
    name: string;
    type: TaskType;
    intervalMs?: number;
    runAt?: number;
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

type RouteParams = Record<string, string>;
type RouteMatcher = (path: string) => RouteParams | null;

export interface AdminApiRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
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

function paramWithSuffix(prefix: string, paramName: string, suffix: string): RouteMatcher {
  return (path) => {
    if (!path.startsWith(prefix) || !path.endsWith(suffix)) return null;
    const raw = path.slice(prefix.length, path.length - suffix.length);
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
  adaptiveToolsService?: AdminAdaptiveToolsService | null;
  memoryService: AdminMemoryService;
  sessionService: AdminSessionService;
  contactsService: AdminContactsService;
  settingsService: AdminSettingsService;
  identityService: AdminIdentityService;
  promptsService: AdminPromptsService;
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
    dashboardService,
    adaptiveToolsService,
    memoryService,
    sessionService,
    contactsService,
    settingsService,
    identityService,
    promptsService,
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
      match: exactPath('/api/admin/tools/adaptive'),
      handle: (_req, res) => {
        if (!adaptiveToolsService) {
          sendJson(res, 200, {
            state: null,
            recentTelemetry: [],
          });
          return;
        }
        sendJson(res, 200, adaptiveToolsService.getAdaptiveToolsData());
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
            sendJson(res, result.message?.includes('not found') ? 404 : 400, { error: result.message });
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
            sendJson(res, result.message?.includes('not found') ? 404 : 400, { error: result.message });
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
        sendJson(res, 200, detail);
      },
    },
    {
      method: 'DELETE',
      match: prefixedParamPath('/api/admin/contacts/', 'id'),
      handle: (_req, res, { id }) => {
        const result = contactsService.deleteContact(id);
        if (!result.ok) {
          sendJson(res, result.message?.includes('not found') ? 404 : 400, { error: result.message });
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
              if (!result.ok) {
                appendIdentityMutationAudit(
                  'denied',
                  `Operator identity import via /api/admin/identity/import failed: ${result.message}`,
                  [rawPath ? `path=${rawPath}` : null],
                );
                sendJson(res, 400, { error: result.message });
                return;
              }
              appendIdentityMutationAudit(
                'allowed',
                'Operator imported identity card via /api/admin/identity/import.',
                [
                  rawPath ? `path=${rawPath}` : null,
                  result.message || null,
                ],
              );
              sendJson(res, 201, result);
            },
            error => {
              appendIdentityMutationAudit(
                'denied',
                `Operator identity import via /api/admin/identity/import failed: ${String(error)}`,
                [rawPath ? `path=${rawPath}` : null],
              );
              sendJson(res, 500, { error: String(error) });
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
              appendIdentityMutationAudit(
                'denied',
                `Operator identity upload via /api/admin/identity/upload failed: ${uploadResult.error}`,
              );
              sendJson(res, uploadResult.status, { error: uploadResult.error });
              return;
            }
            const jsonResult = validateAndParseJsonFile(uploadResult.file);
            if (!jsonResult.ok) {
              appendIdentityMutationAudit(
                'denied',
                `Operator identity upload via /api/admin/identity/upload failed: ${jsonResult.error}`,
                [`filename=${uploadResult.file.filename}`],
              );
              sendJson(res, 400, { error: jsonResult.error });
              return;
            }
            // Pass the parsed card data as a JSON string to the import service
            identityService.importIdentityCard(JSON.stringify({ cardData: jsonResult.data })).then(
              result => {
                if (!result.ok) {
                  appendIdentityMutationAudit(
                    'denied',
                    `Operator identity upload via /api/admin/identity/upload failed: ${result.message}`,
                    [`filename=${jsonResult.filename}`],
                  );
                  sendJson(res, 400, { error: result.message });
                  return;
                }
                appendIdentityMutationAudit(
                  'allowed',
                  'Operator imported identity card via /api/admin/identity/upload.',
                  [`filename=${jsonResult.filename}`, result.message || null],
                );
                sendJson(res, 201, { ...result, filename: jsonResult.filename });
              },
              error => {
                appendIdentityMutationAudit(
                  'denied',
                  `Operator identity upload via /api/admin/identity/upload failed: ${String(error)}`,
                  [`filename=${jsonResult.filename}`],
                );
                sendJson(res, 500, { error: String(error) });
              },
            );
          },
          (error) => {
            appendIdentityMutationAudit(
              'denied',
              `Operator identity upload via /api/admin/identity/upload failed: ${String(error)}`,
            );
            sendJson(res, 500, { error: String(error) });
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
          const updates = parsed.value as { intervalMs?: number; enabled?: boolean; name?: string };
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
            if (!name?.trim()) {
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
