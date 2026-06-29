import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../../channels/backplane/http/primitives.js';
import { VALID_MEMORY_TYPES, type MemoryRetentionClass, type MemoryType } from '../../faculties/memory/types.js';
import { VALID_SENSITIVITY_LEVELS, type SensitivityLevel } from '../../system/trust/types.js';
import { buildAdminEpisodicMemoryRoutes } from './api-routes-episodic-memory.js';
import { parseAdminJsonBody } from './request-body.js';
import { parseRequestUrl, resolveRequestOrigin } from './request-url.js';
import {
  exactPath,
  paramWithSuffix,
  prefixedParamPath,
} from './route-matchers.js';
import { buildAdminContactRoutes } from './routes/contact-routes.js';
import { buildAdminIdentityRoutes } from './routes/identity-routes.js';
import { buildAdminImageRoutes } from './routes/image-routes.js';
import { buildAdminOverviewRoutes } from './routes/overview-routes.js';
import { buildAdminPromptRoutes } from './routes/prompt-routes.js';
import { buildAdminSchedulerRoutes } from './routes/scheduler-routes.js';
import { buildAdminSessionRoutes } from './routes/session-routes.js';
import { ADMIN_DYNAMIC_JSON_HEADERS, toSanitizedMessage } from './routes/shared.js';
import { buildAdminSettingsRoutes } from './routes/settings-routes.js';
import type { AdminApiRoute } from './routes/types.js';
import type {
  AdminActionPipeService,
  AdminAdaptiveToolsService,
  AdminAuditHistoryService,
  AdminChargeLedgerService,
  AdminContactsService,
  AdminDashboardService,
  AdminEpisodicMemoryService,
  AdminGroupMemoryService,
  AdminImagesService,
  AdminIdentityService,
  AdminMemoryService,
  AdminModelUsageService,
  AdminPromptsService,
  AdminShardFoldReviewService,
  AdminSessionService,
  AdminSettingsService,
  AdminWikiService,
} from './services/types.js';
import type {
  AdminChatBootstrapApi,
  AdminModelDiscoveryApi,
  AdminSchedulerApi,
  AdminSkillsApi,
  AdminValuesJournalApi,
  ConfirmationQueueAdminApi,
} from './admin-contract.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type {
  AdminAuditActionType,
  AdminAuditActor,
  AdminAuditDecision,
} from './types.js';
import type { AdminChatBootstrapUpdateInput } from './chat/types.js';
import { isShardFoldReviewUnavailableError } from './services/shard-fold-review-service.js';
import type { AdminObserverEvalSidecarService } from './services/observer-eval-sidecar-service.js';
import { isRecord } from '../../shared/utils/types.js';
import type { GroupMemoryBackfillInput } from '../../faculties/memory/extraction/group-backfill.js';

export type { AdminApiRoute } from './routes/types.js';

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

function toMemoryRetentionClass(value: string | null): MemoryRetentionClass | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === 'standard' || normalized === 'durable'
    ? normalized
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

const ADMIN_MODELS_API_PATH = '/api/admin/models';
const ADMIN_MODELS_REFRESH_API_PATH = '/api/admin/models/refresh';
const ADMIN_CHAT_BOOTSTRAP_API_PATH = '/api/admin/chat/bootstrap';
const ADMIN_CHAT_MODEL_ROOM_BOOTSTRAP_API_PATH = '/api/admin/chat/model-room/bootstrap';
const MODEL_DISCOVERY_UNAVAILABLE_ERROR = 'Model discovery backend unavailable';
const WIKI_UNAVAILABLE_ERROR = 'Wiki backend unavailable';
const GROUP_MEMORY_UNAVAILABLE_ERROR = 'Group memory diagnostics backend unavailable';

function toPositiveIntegerQueryNumber(
  value: string | null,
  fieldName: string,
): { ok: true; value?: number } | { ok: false; error: string } {
  if (value === null) return { ok: true };
  const trimmed = value.trim();
  if (!trimmed) return { ok: true };
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return { ok: false, error: `Invalid ${fieldName} query parameter. Expected a positive integer.` };
  }
  return { ok: true, value: parsed };
}

const GROUP_MEMORY_BACKFILL_KEYS = new Set<string>([
  'mode',
  'dryRun',
  'startMessageId',
  'endMessageId',
  'startTimestamp',
  'endTimestamp',
  'resume',
  'maxMessagesPerRun',
  'maxChunksPerRun',
  'maxLlmCallsPerRun',
]);

function parseGroupMemoryBackfillInput(
  value: unknown,
): { ok: true; value: GroupMemoryBackfillInput } | { ok: false; error: string } {
  if (!isRecord(value)) {
    return { ok: false, error: 'Expected JSON object body' };
  }
  for (const key of Object.keys(value)) {
    if (!GROUP_MEMORY_BACKFILL_KEYS.has(key)) {
      return { ok: false, error: `Unknown group-memory backfill field: ${key}` };
    }
  }

  const input: GroupMemoryBackfillInput = {};
  if (value.mode !== undefined) {
    if (value.mode !== 'dry_run' && value.mode !== 'live') {
      return { ok: false, error: 'mode must be dry_run or live' };
    }
    input.mode = value.mode;
  }
  if (value.dryRun !== undefined) {
    if (typeof value.dryRun !== 'boolean') {
      return { ok: false, error: 'dryRun must be boolean' };
    }
    input.dryRun = value.dryRun;
  }
  if (value.resume !== undefined) {
    if (typeof value.resume !== 'boolean') {
      return { ok: false, error: 'resume must be boolean' };
    }
    input.resume = value.resume;
  }

  const integerFields = [
    'startMessageId',
    'endMessageId',
    'maxMessagesPerRun',
    'maxChunksPerRun',
    'maxLlmCallsPerRun',
  ] as const;
  for (const field of integerFields) {
    const parsed = parseOptionalPositiveInteger(value[field], field);
    if (!parsed.ok) return parsed;
    if (parsed.value !== undefined) input[field] = parsed.value;
  }

  const timestampFields = ['startTimestamp', 'endTimestamp'] as const;
  for (const field of timestampFields) {
    const parsed = parseOptionalNonNegativeNumber(value[field], field);
    if (!parsed.ok) return parsed;
    if (parsed.value !== undefined) input[field] = parsed.value;
  }

  return { ok: true, value: input };
}

function parseOptionalPositiveInteger(
  value: unknown,
  field: string,
): { ok: true; value?: number } | { ok: false; error: string } {
  if (value === undefined) return { ok: true };
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return { ok: false, error: `${field} must be a positive integer` };
  }
  return { ok: true, value };
}

function parseOptionalNonNegativeNumber(
  value: unknown,
  field: string,
): { ok: true; value?: number } | { ok: false; error: string } {
  if (value === undefined) return { ok: true };
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return { ok: false, error: `${field} must be a non-negative number` };
  }
  return { ok: true, value };
}

export function buildAdminApiRoutes(options: {
  config: SubstrateConfig;
  dashboardService: AdminDashboardService;
  imagesService: AdminImagesService;
  auditHistoryService?: AdminAuditHistoryService | null;
  chargeLedgerService?: AdminChargeLedgerService | null;
  modelUsageService?: AdminModelUsageService | null;
  observerEvalSidecarService?: AdminObserverEvalSidecarService | null;
  actionPipeService?: AdminActionPipeService | null;
  shardFoldReviewService: AdminShardFoldReviewService;
  adaptiveToolsService?: AdminAdaptiveToolsService | null;
  wikiService?: AdminWikiService | null;
  episodicMemoryService?: AdminEpisodicMemoryService | null;
  groupMemoryService?: AdminGroupMemoryService | null;
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
    imagesService,
    auditHistoryService,
    chargeLedgerService,
    modelUsageService,
    observerEvalSidecarService,
    actionPipeService,
    shardFoldReviewService,
    adaptiveToolsService,
    wikiService,
    episodicMemoryService,
    groupMemoryService,
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
        chatBootstrapService.updateSelection(
          (parsed.value ?? {}) as AdminChatBootstrapUpdateInput,
          { requestOrigin: resolveRequestOrigin(req) },
        ).then(
          (bootstrap) => {
            sendJson(res, 200, { ok: true, bootstrap });
          },
          (error) => {
            sendJson(res, 400, {
              error: toSanitizedMessage(error, 'Failed to update chat bootstrap'),
            });
          },
        );
      } catch (error) {
        sendJson(res, 400, {
          error: toSanitizedMessage(error, 'Failed to update chat bootstrap'),
        });
      }
    });
  };

  return [
    ...buildAdminOverviewRoutes({
      config,
      dashboardService,
      auditHistoryService,
      chargeLedgerService,
      modelUsageService,
      observerEvalSidecarService,
      actionPipeService,
      withBody,
    }),
    ...buildAdminImageRoutes({
      imagesService,
      appendAuditTimelineEntry,
      withBody,
    }),
    {
      method: 'GET',
      match: exactPath('/api/admin/shards'),
      handle: (_req, res) => {
        shardFoldReviewService.listShardFoldReviews().then(
          (payload) => {
            sendJson(res, 200, payload, ADMIN_DYNAMIC_JSON_HEADERS);
          },
          (error) => {
            const status = isShardFoldReviewUnavailableError(error) ? 503 : 500;
            sendJson(res, status, {
              error: toSanitizedMessage(error, 'Failed to list shard fold reviews'),
            });
          },
        );
      },
    },
    {
      method: 'POST',
      match: paramWithSuffix('/api/admin/shards/', 'shardId', '/review'),
      handle: (req, res, { shardId }) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          if (
            parsed.value === null
            || typeof parsed.value !== 'object'
            || Array.isArray(parsed.value)
          ) {
            sendJson(res, 400, { error: 'Shard fold review payload must be a JSON object' });
            return;
          }

          const payload = parsed.value as Record<string, unknown>;
          const decision = typeof payload.decision === 'string' ? payload.decision.trim().toLowerCase() : '';
          if (decision !== 'approve' && decision !== 'deny') {
            sendJson(res, 400, { error: 'decision must be approve or deny' });
            return;
          }

          const actor = typeof payload.actor === 'string' ? payload.actor.trim() : undefined;
          const note = typeof payload.note === 'string' ? payload.note.trim() : undefined;
          shardFoldReviewService.resolveShardFoldReview({
            shardId,
            decision,
            actor,
            note,
          }).then(
            (result) => {
              if (!result.ok) {
                const status = result.message === 'Shard fold review not found' ? 404 : 400;
                sendJson(res, status, { error: result.message ?? 'Failed to resolve shard fold review' });
                return;
              }
              sendJson(res, 200, result, ADMIN_DYNAMIC_JSON_HEADERS);
            },
            (error) => {
              const status = isShardFoldReviewUnavailableError(error) ? 503 : 500;
              sendJson(res, status, {
                error: toSanitizedMessage(error, 'Failed to resolve shard fold review'),
              });
            },
          );
        });
      },
    },
    {
      method: 'GET',
      match: prefixedParamPath('/api/admin/shards/', 'shardId'),
      handle: (_req, res, { shardId }) => {
        shardFoldReviewService.getShardFoldReview(shardId).then(
          (review) => {
            if (!review) {
              sendJson(res, 404, { error: 'Shard fold review not found' });
              return;
            }
            sendJson(res, 200, review, ADMIN_DYNAMIC_JSON_HEADERS);
          },
          (error) => {
            const status = isShardFoldReviewUnavailableError(error) ? 503 : 500;
            sendJson(res, status, {
              error: toSanitizedMessage(error, 'Failed to load shard fold review'),
            });
          },
        );
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
            inventory: [],
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
        chatBootstrapService.buildBootstrap({
          requestOrigin: resolveRequestOrigin(req),
        }).then(
          (payload) => sendJson(res, 200, payload),
          (error) => {
            sendJson(res, 500, {
              error: toSanitizedMessage(error, 'Failed to build chat bootstrap'),
            });
          },
        );
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
        chatBootstrapService.buildModelRoomBootstrap(config, {
          requestOrigin: resolveRequestOrigin(req),
        }).then(
          (payload) => sendJson(res, 200, payload),
          (error) => {
            sendJson(res, 500, {
              error: toSanitizedMessage(error, 'Failed to build model room bootstrap'),
            });
          },
        );
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
        const retentionFilter = toMemoryRetentionClass(url.searchParams.get('retention'));
        if (url.searchParams.get('retention') && !retentionFilter) {
          sendJson(res, 400, { error: 'Invalid memory retention filter' });
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
        memoryService.listMemories(url.searchParams).then(
          (data) => {
            sendJson(res, 200, {
              ...data,
              contactsById: Object.fromEntries(data.contactsById.entries()),
            });
          },
          (error) => {
            sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to list memories') });
          },
        );
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
        memoryService.listManagedScopes(url.searchParams).then(
          (payload) => {
            sendJson(res, 200, payload);
          },
          (error) => {
            sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to list managed scopes') });
          },
        );
      },
    },
    {
      method: 'GET',
      match: paramWithSuffix('/api/admin/memory/scopes/', 'scopeKey', '/detail'),
      handle: (_req, res, { scopeKey }) => {
        const separator = scopeKey.indexOf(':');
        const kind = separator >= 0 ? scopeKey.slice(0, separator) : '';
        const id = separator >= 0 ? scopeKey.slice(separator + 1) : '';
        memoryService.getManagedScopeDetail(kind, id).then(
          (detail) => {
            if (!detail) {
              sendJson(res, 404, { error: 'Managed memory scope not found' });
              return;
            }
            sendJson(res, 200, detail);
          },
          (error) => {
            sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to load managed scope detail') });
          },
        );
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
            : (typeof rawScopeRef === 'object'
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

          memoryService.updateMemoryScope(id, { scopeRef, scopeTags, repair }).then(
            (result) => {
              if (!result.ok) {
                const status = result.message === 'Memory not found' ? 404 : 400;
                sendJson(res, status, { error: result.message ?? 'Failed to update memory scope' });
                return;
              }
              sendJson(res, 200, result);
            },
            (error) => {
              sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to update memory scope') });
            },
          );
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

          memoryService.linkMemories(id1, id2, linkType).then(
            (result) => {
              if (!result.ok) {
                sendJson(res, 400, { error: result.message ?? 'Failed to create link' });
                return;
              }
              sendJson(res, 201, result);
            },
            (error) => {
              sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to create memory link') });
            },
          );
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

          memoryService.unlinkMemories(id1, id2).then(
            (result) => {
              if (!result.ok) {
                sendJson(res, 404, { error: result.message ?? 'Link not found' });
                return;
              }
              sendJson(res, 200, { ok: true });
            },
            (error) => {
              sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to remove memory link') });
            },
          );
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

          memoryService.bulkDelete(ids).then(
            (result) => {
              if (!result.ok) {
                sendJson(res, 400, { error: result.message ?? 'Bulk delete failed' });
                return;
              }
              sendJson(res, 200, result);
            },
            (error) => {
              sendJson(res, 500, { error: toSanitizedMessage(error, 'Bulk delete failed') });
            },
          );
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
          const retentionClass = typeof fields.retentionClass === 'string' ? fields.retentionClass : undefined;

          if (!memoryType && !sensitivity && !retentionClass) {
            sendJson(res, 400, { error: 'At least one field (memoryType, sensitivity, retentionClass) is required' });
            return;
          }

          memoryService.bulkUpdate(ids, { memoryType, sensitivity, retentionClass }).then(
            (result) => {
              if (!result.ok) {
                sendJson(res, 400, { error: result.message ?? 'Bulk update failed' });
                return;
              }
              sendJson(res, 200, result);
            },
            (error) => {
              sendJson(res, 500, { error: toSanitizedMessage(error, 'Bulk update failed') });
            },
          );
        });
      },
    },
    // Sub-path route MUST come before generic prefixed param route
    {
      method: 'GET',
      match: paramWithSuffix('/api/admin/memory/', 'id', '/links'),
      handle: (_req, res, { id }) => {
        memoryService.getMemoryLinks(id).then(
          (links) => {
            sendJson(res, 200, { links });
          },
          (error) => {
            sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to load memory links') });
          },
        );
      },
    },
    {
      method: 'GET',
      match: prefixedParamPath('/api/admin/memory/', 'id'),
      handle: (_req, res, { id }) => {
        memoryService.getMemoryDetail(id).then(
          (detail) => {
            if (!detail) {
              sendJson(res, 404, { error: 'Memory not found' });
              return;
            }
            sendJson(res, 200, detail);
          },
          (error) => {
            sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to load memory detail') });
          },
        );
      },
    },
    {
      method: 'DELETE',
      match: prefixedParamPath('/api/admin/memory/', 'id'),
      handle: (_req, res, { id }) => {
        memoryService.supersedeMemory(id).then(
          (result) => {
            if (!result.ok) {
              sendJson(res, 404, { error: result.message ?? 'Memory not found' });
              return;
            }
            sendJson(res, 200, { ok: true });
          },
          (error) => {
            sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to supersede memory') });
          },
        );
      },
    },
    ...buildAdminEpisodicMemoryRoutes({ episodicMemoryService }),
    {
      method: 'GET',
      match: exactPath('/api/admin/group-memory'),
      handle: (_req, res) => {
        if (!groupMemoryService) {
          sendJson(res, 503, { error: GROUP_MEMORY_UNAVAILABLE_ERROR });
          return;
        }
        groupMemoryService.listGroupMemoryDiagnostics().then(
          payload => sendJson(res, 200, payload, ADMIN_DYNAMIC_JSON_HEADERS),
          error => sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to load group memory diagnostics') }),
        );
      },
    },
    {
      method: 'POST',
      match: paramWithSuffix('/api/admin/group-memory/', 'channelId', '/backfill'),
      handle: (req, res, { channelId }) => {
        if (!groupMemoryService) {
          sendJson(res, 503, { error: GROUP_MEMORY_UNAVAILABLE_ERROR });
          return;
        }
        withBody(req, res, (body) => {
          const parsedBody = parseAdminJsonBody(body);
          if (!parsedBody.ok) {
            sendJson(res, 400, { error: parsedBody.error });
            return;
          }
          const parsedInput = parseGroupMemoryBackfillInput(parsedBody.value);
          if (!parsedInput.ok) {
            sendJson(res, 400, { error: parsedInput.error });
            return;
          }
          groupMemoryService.runGroupMemoryBackfill(channelId, parsedInput.value).then(
            payload => sendJson(res, 200, payload, ADMIN_DYNAMIC_JSON_HEADERS),
            error => sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to run group memory backfill') }),
          );
        });
      },
    },
    {
      method: 'GET',
      match: prefixedParamPath('/api/admin/group-memory/', 'channelId'),
      handle: (_req, res, { channelId }) => {
        if (!groupMemoryService) {
          sendJson(res, 503, { error: GROUP_MEMORY_UNAVAILABLE_ERROR });
          return;
        }
        groupMemoryService.getGroupMemoryChannelDiagnostics(channelId).then(
          (diagnostics) => {
            if (!diagnostics) {
              sendJson(res, 404, { error: 'Group memory channel diagnostics not found' });
              return;
            }
            sendJson(res, 200, diagnostics, ADMIN_DYNAMIC_JSON_HEADERS);
          },
          error => sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to load group memory channel diagnostics') }),
        );
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/admin/wiki'),
      handle: (_req, res) => {
        if (!wikiService) {
          sendJson(res, 503, { error: WIKI_UNAVAILABLE_ERROR });
          return;
        }
        wikiService.listWikiDocuments().then(
          payload => sendJson(res, 200, payload, ADMIN_DYNAMIC_JSON_HEADERS),
          error => sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to list wiki documents') }),
        );
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/admin/wiki/search'),
      handle: (req, res) => {
        if (!wikiService) {
          sendJson(res, 503, { error: WIKI_UNAVAILABLE_ERROR });
          return;
        }
        const url = parseRequestUrl(req, '/api/admin/wiki/search');
        const query = url.searchParams.get('query')?.trim() ?? '';
        if (!query) {
          sendJson(res, 400, { error: 'query is required' });
          return;
        }
        const limit = toPositiveIntegerQueryNumber(url.searchParams.get('limit'), 'limit');
        if (!limit.ok) {
          sendJson(res, 400, { error: limit.error });
          return;
        }
        wikiService.searchWikiDocuments({
          query,
          ...(limit.value !== undefined ? { limit: limit.value } : {}),
        }).then(
          payload => sendJson(res, 200, payload, ADMIN_DYNAMIC_JSON_HEADERS),
          error => sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to search wiki documents') }),
        );
      },
    },
    {
      method: 'GET',
      match: prefixedParamPath('/api/admin/wiki/', 'id'),
      handle: (_req, res, { id }) => {
        if (!wikiService) {
          sendJson(res, 503, { error: WIKI_UNAVAILABLE_ERROR });
          return;
        }
        wikiService.getWikiDocument(id).then(
          (document) => {
            if (!document) {
              sendJson(res, 404, { error: 'Wiki document not found' });
              return;
            }
            sendJson(res, 200, document, ADMIN_DYNAMIC_JSON_HEADERS);
          },
          error => sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to load wiki document') }),
        );
      },
    },
    ...buildAdminSessionRoutes({ sessionService }),
    ...buildAdminContactRoutes({ contactsService, withBody }),
    ...buildAdminSettingsRoutes({ settingsService, appendAuditTimelineEntry, withBody }),
    ...buildAdminIdentityRoutes({ identityService, appendAuditTimelineEntry, withBody }),
    ...buildAdminPromptRoutes({ promptsService, withBody }),
    ...buildAdminSchedulerRoutes({ scheduler, withBody }),
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
          appendAuditTimelineEntry?.(
            'confirmation',
            'denied',
            'Operator confirmation resolve failed: confirmation queue unavailable.',
            [],
            'operator',
          );
          sendJson(res, 400, { ok: false, message: 'Confirmation queue is unavailable' });
          return;
        }
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            appendAuditTimelineEntry?.(
              'confirmation',
              'denied',
              'Operator confirmation resolve failed: invalid JSON payload.',
              [],
              'operator',
            );
            sendJson(res, 400, { ok: false, message: parsed.error });
            return;
          }
          const payload = parsed.value as Record<string, unknown>;
          const id = (typeof payload.id === 'string' ? payload.id : '').trim();
          const decision = (typeof payload.decision === 'string' ? payload.decision : '').trim();

          if (!id) {
            appendAuditTimelineEntry?.(
              'confirmation',
              'denied',
              'Operator confirmation resolve failed: missing confirmation ID.',
              [],
              'operator',
            );
            sendJson(res, 400, { ok: false, message: 'Confirmation ID is required' });
            return;
          }
          if (decision !== 'approve' && decision !== 'deny' && decision !== 'modify') {
            appendAuditTimelineEntry?.(
              'confirmation',
              'denied',
              'Operator confirmation resolve failed: invalid decision.',
              [`id=${id}`, `decision=${decision || 'missing'}`],
              'operator',
            );
            sendJson(res, 400, { ok: false, message: 'Invalid decision (must be approve, deny, or modify)' });
            return;
          }

          const resolveParams: { id: string; decision: 'approve' | 'deny' | 'modify'; modifiedParams?: Record<string, unknown> } = { id, decision };
          if (decision === 'modify' && payload.modifiedParams && typeof payload.modifiedParams === 'object') {
            resolveParams.modifiedParams = payload.modifiedParams as Record<string, unknown>;
          }

          confirmationQueueApi!.resolveConfirmationQueue(resolveParams).then(
            (result) => {
              appendAuditTimelineEntry?.(
                'confirmation',
                result.status === 'approved' || result.status === 'modified'
                  ? 'allowed'
                  : 'denied',
                `Operator resolved confirmation ${id}: ${result.status}.`,
                [
                  `decision=${decision}`,
                  `executed=${result.executed}`,
                  result.message ? `message=${result.message}` : null,
                ],
                'operator',
              );
              sendJson(res, 200, {
                ok: result.status === 'approved' || result.status === 'modified',
                message: result.message,
                status: result.status,
                executed: result.executed,
              });
            },
            (error) => {
              appendAuditTimelineEntry?.(
                'confirmation',
                'denied',
                `Operator confirmation resolve failed for ${id}.`,
                [`decision=${decision}`, `error=${toSanitizedMessage(error, 'unknown error')}`],
                'operator',
              );
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
