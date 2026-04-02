import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../http/primitives.js';
import { handleMultipartUpload, validateAndParseCharacterCardFile } from './multipart.js';
import { parseAdminJsonBody } from './request-body.js';
import { parseRequestUrl, resolveRequestOrigin } from './request-url.js';
import { buildAdminMemoryRoutes } from './api-routes-memory.js';
import { buildAdminContactRoutes } from './api-routes-contacts.js';
import {
  exactPath,
  paramWithSuffix,
  prefixedParamPath,
  type RouteMatcher,
  type RouteParams,
} from './route-matchers.js';
import type {
  AdminAdaptiveToolsService,
  AdminArtifactLifecycleService,
  AdminContactsService,
  AdminDashboardService,
  AdminIdentityService,
  AdminMemoryService,
  AdminResearchLibraryService,
  AdminPromptsService,
  AdminSessionService,
  AdminSettingsService,
} from './services/types.js';
import {
  isDashboardCostWindow,
  resolveDashboardCostWindow,
} from './services/dashboard-cost-windows.js';
import type { RecurringCadence, ScheduledTask, TaskType } from '../../scheduler/types.js';
import type { ManagedSkillOwnership, SkillSnapshot } from '../../skills/types.js';
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
import type { ShardManager } from '../../shards/manager.js';
import type { SubagentFaculty } from '../../subagents/faculty.js';

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
  getManagedOwnership(): ManagedSkillOwnership;
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

const ADMIN_SETTINGS_API_PATH = '/api/admin/settings';
const ADMIN_SETTINGS_MODELS_API_PATH = '/api/admin/settings/models';
const ADMIN_MODELS_API_PATH = '/api/admin/models';
const ADMIN_MODELS_REFRESH_API_PATH = '/api/admin/models/refresh';
const ADMIN_CHAT_BOOTSTRAP_API_PATH = '/api/admin/chat/bootstrap';
const ADMIN_CHAT_MODEL_ROOM_BOOTSTRAP_API_PATH = '/api/admin/chat/model-room/bootstrap';
const ADMIN_SHARDS_API_PATH = '/api/admin/shards';
const ADMIN_SUBAGENTS_API_PATH = '/api/admin/subagents';
const ADMIN_RESEARCH_LIBRARY_API_PATH = '/api/admin/research-library';
const ADMIN_ARTIFACT_LIFECYCLE_API_PATH = '/api/admin/artifact-lifecycle';
const MODEL_DISCOVERY_UNAVAILABLE_ERROR = 'Model discovery backend unavailable';

export function buildAdminApiRoutes(options: {
  config: SubstrateConfig;
  dashboardService: AdminDashboardService;
  shardManager: ShardManager;
  subagentFaculty: SubagentFaculty;
  adaptiveToolsService?: AdminAdaptiveToolsService | null;
  artifactLifecycleService?: AdminArtifactLifecycleService | null;
  memoryService: AdminMemoryService;
  researchLibraryService?: AdminResearchLibraryService | null;
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
    shardManager,
    subagentFaculty,
    adaptiveToolsService,
    artifactLifecycleService,
    memoryService,
    researchLibraryService,
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
      match: exactPath(ADMIN_SHARDS_API_PATH),
      handle: (req, res) => {
        const url = parseRequestUrl(req, ADMIN_SHARDS_API_PATH);
        const shardLimit = parsePositiveIntegerParam(url.searchParams.get('limit'), 10);
        if (shardLimit === null) {
          sendJson(res, 400, { error: 'Invalid limit query parameter. Expected a positive integer.' });
          return;
        }
        const transcriptLimit = parsePositiveIntegerParam(url.searchParams.get('transcriptLimit'), 8);
        if (transcriptLimit === null) {
          sendJson(res, 400, { error: 'Invalid transcriptLimit query parameter. Expected a positive integer.' });
          return;
        }
        sendJson(res, 200, shardManager.getRuntimeSnapshot({ shardLimit, transcriptLimit }));
      },
    },
    {
      method: 'GET',
      match: prefixedParamPath(`${ADMIN_SHARDS_API_PATH}/`, 'shardId'),
      handle: (req, res, { shardId }) => {
        const url = parseRequestUrl(req, `${ADMIN_SHARDS_API_PATH}/${shardId}`);
        const transcriptLimit = parsePositiveIntegerParam(url.searchParams.get('transcriptLimit'), 8);
        if (transcriptLimit === null) {
          sendJson(res, 400, { error: 'Invalid transcriptLimit query parameter. Expected a positive integer.' });
          return;
        }
        const shard = shardManager.getRuntimeShardView(shardId, { transcriptLimit });
        if (!shard) {
          sendJson(res, 404, { error: 'Shard runtime not found' });
          return;
        }
        sendJson(res, 200, shard);
      },
    },
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
      match: exactPath(ADMIN_SUBAGENTS_API_PATH),
      handle: (req, res) => {
        const url = parseRequestUrl(req, ADMIN_SUBAGENTS_API_PATH);
        const taskLimit = parsePositiveIntegerParam(url.searchParams.get('limit'), 10);
        if (taskLimit === null) {
          sendJson(res, 400, { error: 'Invalid limit query parameter. Expected a positive integer.' });
          return;
        }
        const transcriptLimit = parsePositiveIntegerParam(url.searchParams.get('transcriptLimit'), 8);
        if (transcriptLimit === null) {
          sendJson(res, 400, { error: 'Invalid transcriptLimit query parameter. Expected a positive integer.' });
          return;
        }
        sendJson(res, 200, subagentFaculty.getRuntimeSnapshot({ taskLimit, transcriptLimit }));
      },
    },
    {
      method: 'GET',
      match: prefixedParamPath(`${ADMIN_SUBAGENTS_API_PATH}/`, 'subagentId'),
      handle: (req, res, { subagentId }) => {
        const url = parseRequestUrl(req, `${ADMIN_SUBAGENTS_API_PATH}/${subagentId}`);
        const transcriptLimit = parsePositiveIntegerParam(url.searchParams.get('transcriptLimit'), 8);
        if (transcriptLimit === null) {
          sendJson(res, 400, { error: 'Invalid transcriptLimit query parameter. Expected a positive integer.' });
          return;
        }
        const task = subagentFaculty.getRuntimeTaskView(subagentId, { transcriptLimit });
        if (!task) {
          sendJson(res, 404, { error: 'Subagent task not found' });
          return;
        }
        sendJson(res, 200, task);
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
      match: exactPath(ADMIN_RESEARCH_LIBRARY_API_PATH),
      handle: (_req, res) => {
        if (!researchLibraryService) {
          sendJson(res, 503, { error: 'Research library service unavailable' });
          return;
        }
        sendJson(res, 200, researchLibraryService.listEntries());
      },
    },
    {
      method: 'GET',
      match: prefixedParamPath(`${ADMIN_RESEARCH_LIBRARY_API_PATH}/`, 'entryId'),
      handle: (_req, res, { entryId }) => {
        if (!researchLibraryService) {
          sendJson(res, 503, { error: 'Research library service unavailable' });
          return;
        }
        const entry = researchLibraryService.getEntry(entryId);
        if (!entry) {
          sendJson(res, 404, { error: 'Research library entry not found' });
          return;
        }
        sendJson(res, 200, entry);
      },
    },
    {
      method: 'GET',
      match: exactPath(ADMIN_ARTIFACT_LIFECYCLE_API_PATH),
      handle: (_req, res) => {
        if (!artifactLifecycleService) {
          sendJson(res, 503, { error: 'Artifact lifecycle service unavailable' });
          return;
        }
        sendJson(res, 200, artifactLifecycleService.getArtifactLifecycleData());
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
    ...buildAdminMemoryRoutes({ memoryService, withBody }),
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
    ...buildAdminContactRoutes({ contactsService, withBody }),
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
        const managedOwnership = skillsRuntime.getManagedOwnership();
        const managed = skillsRuntime.listManaged();
        const disabledSkills = skillsRuntime.getDisabledSkills();
        sendJson(res, 200, { snapshot, managedOwnership, managed, disabledSkills });
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

function parsePositiveIntegerParam(rawValue: string | null, fallback: number): number | null {
  if (rawValue === null) return fallback;
  const trimmed = rawValue.trim();
  if (!trimmed) return fallback;
  if (!/^[1-9]\d*$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
