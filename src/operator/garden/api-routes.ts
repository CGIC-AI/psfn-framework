import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../../channels/backplane/http/primitives.js';
import { VALID_MEMORY_TYPES, type MemoryType } from '../../faculties/memory/types.js';
import { VALID_SENSITIVITY_LEVELS, type SensitivityLevel } from '../../system/trust/types.js';
import { handleMultipartUpload, validateAndParseCharacterCardFile } from './multipart.js';
import { buildAdminEpisodicMemoryRoutes } from './api-routes-episodic-memory.js';
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
  AdminActionPipeService,
  AdminAdaptiveToolsService,
  AdminAuditHistoryService,
  AdminChargeLedgerService,
  AdminContactsService,
  AdminDashboardService,
  AdminEpisodicMemoryService,
  AdminImagesService,
  AdminIdentityService,
  AdminMemoryService,
  AdminModelUsageService,
  AdminPromptsService,
  AdminShardFoldReviewService,
  AdminSessionService,
  AdminSettingsService,
} from './services/types.js';
import {
  isDashboardCostWindow,
  resolveDashboardCostWindow,
} from './services/dashboard-cost-windows.js';
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
  AdminAuditHistorySource,
  AdminAuditTimeRange,
} from './types.js';
import type { AdminChatBootstrapUpdateInput } from './chat/types.js';
import { isShardFoldReviewUnavailableError } from './services/shard-fold-review-service.js';
import { buildAdminSatelliteRegistryView } from './services/satellite-registry-service.js';
import {
  MODEL_USAGE_CALL_KINDS,
  type ModelUsageCallKind,
} from '../../shared/telemetry/model-usage.js';
import {
  ADMIN_AUDIT_ACTION_TYPES,
  ADMIN_AUDIT_DECISIONS,
  ADMIN_AUDIT_TIME_RANGES,
} from './audit-timeline.js';
import {
  isObserverEvalSidecarApiUnavailableError,
  type AdminObserverEvalSidecarService,
} from './services/observer-eval-sidecar-service.js';

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
const CHARGE_LEDGER_UNAVAILABLE_ERROR = 'Charge ledger backend unavailable';
const MODEL_USAGE_UNAVAILABLE_ERROR = 'Model usage telemetry backend unavailable';
const OBSERVER_EVAL_SIDECAR_UNAVAILABLE_ERROR = 'Observer eval sidecar backend unavailable';
const ACTION_PIPE_UNAVAILABLE_ERROR = 'Action pipe backend unavailable';
const AUDIT_HISTORY_UNAVAILABLE_ERROR = 'Audit history backend unavailable';
const ADMIN_AUDIT_HISTORY_SOURCES = ['garden', 'gateway', 'charge'] as const;
const OBSERVER_EVAL_PRIVACY_CLASSES = ['public', 'private', 'restricted', 'closed', 'fail_closed'] as const;
const OBSERVER_EVAL_OBSERVATION_STATUSES = ['ok', 'degraded', 'error'] as const;
const OBSERVER_EVAL_RUN_STATUSES = ['running', 'completed', 'degraded', 'failed'] as const;

function toFiniteQueryNumber(
  value: string | null,
  fieldName: string,
): { ok: true; value?: number } | { ok: false; error: string } {
  if (value === null) return { ok: true };
  const trimmed = value.trim();
  if (!trimmed) return { ok: true };
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return { ok: false, error: `Invalid ${fieldName} query parameter. Expected a finite number >= 0.` };
  }
  return { ok: true, value: parsed };
}

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

function parseAuditActionTypeQuery(
  value: string | null,
): { ok: true; value?: AdminAuditActionType | 'all' } | { ok: false; error: string } {
  if (value === null || value.trim() === '') return { ok: true };
  const normalized = value.trim();
  if (normalized === 'all' || ADMIN_AUDIT_ACTION_TYPES.includes(normalized as AdminAuditActionType)) {
    return { ok: true, value: normalized as AdminAuditActionType | 'all' };
  }
  return {
    ok: false,
    error: `Invalid actionType query parameter. Expected all or one of: ${ADMIN_AUDIT_ACTION_TYPES.join(', ')}.`,
  };
}

function parseAuditDecisionQuery(
  value: string | null,
): { ok: true; value?: AdminAuditDecision | 'all' } | { ok: false; error: string } {
  if (value === null || value.trim() === '') return { ok: true };
  const normalized = value.trim();
  if (normalized === 'all' || ADMIN_AUDIT_DECISIONS.includes(normalized as AdminAuditDecision)) {
    return { ok: true, value: normalized as AdminAuditDecision | 'all' };
  }
  return {
    ok: false,
    error: `Invalid decision query parameter. Expected all or one of: ${ADMIN_AUDIT_DECISIONS.join(', ')}.`,
  };
}

function parseAuditTimeRangeQuery(
  value: string | null,
): { ok: true; value?: AdminAuditTimeRange } | { ok: false; error: string } {
  if (value === null || value.trim() === '') return { ok: true };
  const normalized = value.trim();
  if (ADMIN_AUDIT_TIME_RANGES.includes(normalized as AdminAuditTimeRange)) {
    return { ok: true, value: normalized as AdminAuditTimeRange };
  }
  return {
    ok: false,
    error: `Invalid timeRange query parameter. Expected one of: ${ADMIN_AUDIT_TIME_RANGES.join(', ')}.`,
  };
}

function parseAuditSourceQuery(
  value: string | null,
): { ok: true; value?: AdminAuditHistorySource | 'all' } | { ok: false; error: string } {
  if (value === null || value.trim() === '') return { ok: true };
  const normalized = value.trim();
  if (normalized === 'all' || ADMIN_AUDIT_HISTORY_SOURCES.includes(normalized as AdminAuditHistorySource)) {
    return { ok: true, value: normalized as AdminAuditHistorySource | 'all' };
  }
  return {
    ok: false,
    error: `Invalid source query parameter. Expected all or one of: ${ADMIN_AUDIT_HISTORY_SOURCES.join(', ')}.`,
  };
}

function parseModelUsageCallKindQuery(
  value: string | null,
): { ok: true; value?: ModelUsageCallKind } | { ok: false; error: string } {
  if (value === null || value.trim() === '') return { ok: true };
  const normalized = value.trim();
  if (MODEL_USAGE_CALL_KINDS.includes(normalized as ModelUsageCallKind)) {
    return { ok: true, value: normalized as ModelUsageCallKind };
  }
  return {
    ok: false,
    error: `Invalid callKind query parameter. Expected one of: ${MODEL_USAGE_CALL_KINDS.join(', ')}.`,
  };
}

function parseObserverEvalPrivacyClassQuery(
  value: string | null,
): { ok: true; value?: typeof OBSERVER_EVAL_PRIVACY_CLASSES[number] } | { ok: false; error: string } {
  if (value === null || value.trim() === '') return { ok: true };
  const normalized = value.trim();
  if (OBSERVER_EVAL_PRIVACY_CLASSES.includes(normalized as typeof OBSERVER_EVAL_PRIVACY_CLASSES[number])) {
    return { ok: true, value: normalized as typeof OBSERVER_EVAL_PRIVACY_CLASSES[number] };
  }
  return {
    ok: false,
    error: `Invalid privacyClass query parameter. Expected one of: ${OBSERVER_EVAL_PRIVACY_CLASSES.join(', ')}.`,
  };
}

function parseObserverEvalObservationStatusQuery(
  value: string | null,
): { ok: true; value?: typeof OBSERVER_EVAL_OBSERVATION_STATUSES[number] } | { ok: false; error: string } {
  if (value === null || value.trim() === '') return { ok: true };
  const normalized = value.trim();
  if (OBSERVER_EVAL_OBSERVATION_STATUSES.includes(normalized as typeof OBSERVER_EVAL_OBSERVATION_STATUSES[number])) {
    return { ok: true, value: normalized as typeof OBSERVER_EVAL_OBSERVATION_STATUSES[number] };
  }
  return {
    ok: false,
    error: `Invalid status query parameter. Expected one of: ${OBSERVER_EVAL_OBSERVATION_STATUSES.join(', ')}.`,
  };
}

function parseObserverEvalRunStatusQuery(
  value: string | null,
): { ok: true; value?: typeof OBSERVER_EVAL_RUN_STATUSES[number] } | { ok: false; error: string } {
  if (value === null || value.trim() === '') return { ok: true };
  const normalized = value.trim();
  if (OBSERVER_EVAL_RUN_STATUSES.includes(normalized as typeof OBSERVER_EVAL_RUN_STATUSES[number])) {
    return { ok: true, value: normalized as typeof OBSERVER_EVAL_RUN_STATUSES[number] };
  }
  return {
    ok: false,
    error: `Invalid status query parameter. Expected one of: ${OBSERVER_EVAL_RUN_STATUSES.join(', ')}.`,
  };
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
  episodicMemoryService?: AdminEpisodicMemoryService | null;
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
    episodicMemoryService,
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
      contactsService.updateContact(id, JSON.stringify(parsed.value)).then(
        (result) => {
          if (!result.ok) {
            sendJson(res, result.message === 'Contact not found' ? 404 : 400, { error: result.message });
            return;
          }
          sendJson(res, 200, result);
        },
        (error) => {
          sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to update contact') });
        },
      );
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

  const sendImageBlob = (
    res: ServerResponse,
    blob: { fileName: string; contentType: string; data: Buffer },
  ): void => {
    res.writeHead(200, {
      'Content-Type': blob.contentType,
      'Content-Length': blob.data.length,
      'Cache-Control': 'private, max-age=60',
      'Content-Disposition': `inline; filename="${blob.fileName.replaceAll('"', '')}"`,
    });
    res.end(blob.data);
  };

  const parseReferenceTagsQuery = (value: string | null): string[] => (
    value?.split(',').map((tag) => tag.trim()).filter(Boolean) ?? []
  );

  const parseSetDefaultQuery = (value: string | null): boolean => (
    value === '1' || value === 'true' || value === 'yes'
  );

  const statusFromReferenceError = (error: unknown): number => {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('not found') ? 404 : 400;
  };

  const handleObserverEvalError = (
    res: ServerResponse,
    error: unknown,
    fallback: string,
  ): void => {
    const status = isObserverEvalSidecarApiUnavailableError(error) ? 503 : 500;
    sendJson(res, status, {
      error: toSanitizedMessage(error, fallback),
    });
  };

  const parseObserverEvalObservationQuery = (
    req: IncomingMessage,
    routePath: string,
  ): {
    ok: true;
    value: Parameters<NonNullable<AdminObserverEvalSidecarService>['queryObservations']>[0];
  } | { ok: false; error: string } => {
    const url = parseRequestUrl(req, routePath);
    const limit = toPositiveIntegerQueryNumber(url.searchParams.get('limit'), 'limit');
    if (!limit.ok) return { ok: false, error: limit.error };
    const sinceMs = toFiniteQueryNumber(url.searchParams.get('sinceMs'), 'sinceMs');
    if (!sinceMs.ok) return { ok: false, error: sinceMs.error };
    const untilMs = toFiniteQueryNumber(url.searchParams.get('untilMs'), 'untilMs');
    if (!untilMs.ok) return { ok: false, error: untilMs.error };
    const minDivergenceScore = toFiniteQueryNumber(
      url.searchParams.get('minDivergenceScore'),
      'minDivergenceScore',
    );
    if (!minDivergenceScore.ok) return { ok: false, error: minDivergenceScore.error };
    const privacyClass = parseObserverEvalPrivacyClassQuery(url.searchParams.get('privacyClass'));
    if (!privacyClass.ok) return { ok: false, error: privacyClass.error };
    const status = parseObserverEvalObservationStatusQuery(url.searchParams.get('status'));
    if (!status.ok) return { ok: false, error: status.error };
    return {
      ok: true,
      value: {
        ...(limit.value !== undefined ? { limit: limit.value } : {}),
        ...(sinceMs.value !== undefined ? { sinceMs: sinceMs.value } : {}),
        ...(untilMs.value !== undefined ? { untilMs: untilMs.value } : {}),
        ...(minDivergenceScore.value !== undefined ? { minDivergenceScore: minDivergenceScore.value } : {}),
        ...(privacyClass.value !== undefined ? { privacyClass: privacyClass.value } : {}),
        ...(status.value !== undefined ? { status: status.value } : {}),
        ...(url.searchParams.get('runId')?.trim() ? { runId: url.searchParams.get('runId')!.trim() } : {}),
        ...(url.searchParams.get('evalSessionId')?.trim()
          ? { evalSessionId: url.searchParams.get('evalSessionId')!.trim() }
          : {}),
        ...(url.searchParams.get('scenarioId')?.trim()
          ? { scenarioId: url.searchParams.get('scenarioId')!.trim() }
          : {}),
        ...(url.searchParams.get('testRunId')?.trim()
          ? { testRunId: url.searchParams.get('testRunId')!.trim() }
          : {}),
        ...(url.searchParams.get('turnId')?.trim() ? { turnId: url.searchParams.get('turnId')!.trim() } : {}),
      },
    };
  };

  const parseObserverEvalRunQuery = (
    req: IncomingMessage,
    routePath: string,
  ): {
    ok: true;
    value: Parameters<NonNullable<AdminObserverEvalSidecarService>['queryRuns']>[0];
  } | { ok: false; error: string } => {
    const url = parseRequestUrl(req, routePath);
    const limit = toPositiveIntegerQueryNumber(url.searchParams.get('limit'), 'limit');
    if (!limit.ok) return { ok: false, error: limit.error };
    const sinceMs = toFiniteQueryNumber(url.searchParams.get('sinceMs'), 'sinceMs');
    if (!sinceMs.ok) return { ok: false, error: sinceMs.error };
    const untilMs = toFiniteQueryNumber(url.searchParams.get('untilMs'), 'untilMs');
    if (!untilMs.ok) return { ok: false, error: untilMs.error };
    const status = parseObserverEvalRunStatusQuery(url.searchParams.get('status'));
    if (!status.ok) return { ok: false, error: status.error };
    return {
      ok: true,
      value: {
        ...(limit.value !== undefined ? { limit: limit.value } : {}),
        ...(sinceMs.value !== undefined ? { sinceMs: sinceMs.value } : {}),
        ...(untilMs.value !== undefined ? { untilMs: untilMs.value } : {}),
        ...(status.value !== undefined ? { status: status.value } : {}),
        ...(url.searchParams.get('evalSessionId')?.trim()
          ? { evalSessionId: url.searchParams.get('evalSessionId')!.trim() }
          : {}),
        ...(url.searchParams.get('scenarioId')?.trim()
          ? { scenarioId: url.searchParams.get('scenarioId')!.trim() }
          : {}),
        ...(url.searchParams.get('testRunId')?.trim()
          ? { testRunId: url.searchParams.get('testRunId')!.trim() }
          : {}),
      },
    };
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
        dashboardService.getDashboardData({ costWindow }).then(
          (payload) => {
            sendJson(res, 200, payload);
          },
          (error) => {
            sendJson(res, 500, {
              error: `Failed to load dashboard data: ${toSanitizedMessage(error, 'unknown error')}`,
            });
          },
        );
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/admin/audit/history'),
      handle: (req, res) => {
        if (!auditHistoryService) {
          sendJson(res, 503, { error: AUDIT_HISTORY_UNAVAILABLE_ERROR });
          return;
        }

        const url = parseRequestUrl(req, '/api/admin/audit/history');
        const limit = toPositiveIntegerQueryNumber(url.searchParams.get('limit'), 'limit');
        if (!limit.ok) {
          sendJson(res, 400, { error: limit.error });
          return;
        }
        const offset = toFiniteQueryNumber(url.searchParams.get('offset'), 'offset');
        if (!offset.ok) {
          sendJson(res, 400, { error: offset.error });
          return;
        }
        const actionType = parseAuditActionTypeQuery(url.searchParams.get('actionType'));
        if (!actionType.ok) {
          sendJson(res, 400, { error: actionType.error });
          return;
        }
        const decision = parseAuditDecisionQuery(url.searchParams.get('decision'));
        if (!decision.ok) {
          sendJson(res, 400, { error: decision.error });
          return;
        }
        const timeRange = parseAuditTimeRangeQuery(url.searchParams.get('timeRange'));
        if (!timeRange.ok) {
          sendJson(res, 400, { error: timeRange.error });
          return;
        }
        const source = parseAuditSourceQuery(url.searchParams.get('source'));
        if (!source.ok) {
          sendJson(res, 400, { error: source.error });
          return;
        }

        auditHistoryService.getAuditHistory({
          ...(limit.value !== undefined ? { limit: limit.value } : {}),
          ...(offset.value !== undefined ? { offset: offset.value } : {}),
          ...(actionType.value !== undefined ? { actionType: actionType.value } : {}),
          ...(decision.value !== undefined ? { decision: decision.value } : {}),
          ...(timeRange.value !== undefined ? { timeRange: timeRange.value } : {}),
          ...(source.value !== undefined ? { source: source.value } : {}),
          ...(url.searchParams.get('query')?.trim() ? { query: url.searchParams.get('query')!.trim() } : {}),
        }).then(
          payload => sendJson(res, 200, payload, ADMIN_DYNAMIC_JSON_HEADERS),
          error => sendJson(res, 500, {
            error: toSanitizedMessage(error, 'Failed to load audit history'),
          }),
        );
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/admin/charges'),
      handle: (req, res) => {
        if (!chargeLedgerService) {
          sendJson(res, 503, { error: CHARGE_LEDGER_UNAVAILABLE_ERROR });
          return;
        }

        const url = parseRequestUrl(req, '/api/admin/charges');
        const limit = toPositiveIntegerQueryNumber(url.searchParams.get('limit'), 'limit');
        if (!limit.ok) {
          sendJson(res, 400, { error: limit.error });
          return;
        }
        const sinceMs = toFiniteQueryNumber(url.searchParams.get('sinceMs'), 'sinceMs');
        if (!sinceMs.ok) {
          sendJson(res, 400, { error: sinceMs.error });
          return;
        }
        const untilMs = toFiniteQueryNumber(url.searchParams.get('untilMs'), 'untilMs');
        if (!untilMs.ok) {
          sendJson(res, 400, { error: untilMs.error });
          return;
        }
        const runId = url.searchParams.get('runId')?.trim() || undefined;

        chargeLedgerService.getChargeLedgerData({
          ...(limit.value !== undefined ? { limit: limit.value } : {}),
          ...(sinceMs.value !== undefined ? { sinceMs: sinceMs.value } : {}),
          ...(untilMs.value !== undefined ? { untilMs: untilMs.value } : {}),
          ...(runId ? { runId } : {}),
        }).then(
          payload => sendJson(res, 200, payload, ADMIN_DYNAMIC_JSON_HEADERS),
          error => sendJson(res, 500, {
            error: toSanitizedMessage(error, 'Failed to load charge ledger data'),
          }),
        );
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/admin/model-usage'),
      handle: (req, res) => {
        if (!modelUsageService) {
          sendJson(res, 503, { error: MODEL_USAGE_UNAVAILABLE_ERROR });
          return;
        }

        const url = parseRequestUrl(req, '/api/admin/model-usage');
        const limit = toPositiveIntegerQueryNumber(url.searchParams.get('limit'), 'limit');
        if (!limit.ok) {
          sendJson(res, 400, { error: limit.error });
          return;
        }
        const sinceMs = toFiniteQueryNumber(url.searchParams.get('sinceMs'), 'sinceMs');
        if (!sinceMs.ok) {
          sendJson(res, 400, { error: sinceMs.error });
          return;
        }
        const untilMs = toFiniteQueryNumber(url.searchParams.get('untilMs'), 'untilMs');
        if (!untilMs.ok) {
          sendJson(res, 400, { error: untilMs.error });
          return;
        }
        const callKind = parseModelUsageCallKindQuery(url.searchParams.get('callKind'));
        if (!callKind.ok) {
          sendJson(res, 400, { error: callKind.error });
          return;
        }
        const provider = url.searchParams.get('provider')?.trim() || undefined;
        const model = url.searchParams.get('model')?.trim() || undefined;
        const toolName = url.searchParams.get('toolName')?.trim() || undefined;
        const runId = url.searchParams.get('runId')?.trim() || undefined;

        modelUsageService.getModelUsageData({
          ...(limit.value !== undefined ? { limit: limit.value } : {}),
          ...(sinceMs.value !== undefined ? { sinceMs: sinceMs.value } : {}),
          ...(untilMs.value !== undefined ? { untilMs: untilMs.value } : {}),
          ...(provider ? { provider } : {}),
          ...(model ? { model } : {}),
          ...(toolName ? { toolName } : {}),
          ...(callKind.value !== undefined ? { callKind: callKind.value } : {}),
          ...(runId ? { runId } : {}),
        }).then(
          payload => sendJson(res, 200, payload, ADMIN_DYNAMIC_JSON_HEADERS),
          error => sendJson(res, 500, {
            error: toSanitizedMessage(error, 'Failed to load model usage telemetry'),
          }),
        );
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/admin/evals/observer-sidecar/health'),
      handle: (_req, res) => {
        if (!observerEvalSidecarService) {
          sendJson(res, 503, { error: OBSERVER_EVAL_SIDECAR_UNAVAILABLE_ERROR });
          return;
        }
        observerEvalSidecarService.getHealth().then(
          payload => sendJson(res, 200, payload, ADMIN_DYNAMIC_JSON_HEADERS),
          error => handleObserverEvalError(res, error, 'Failed to load observer eval sidecar health'),
        );
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/admin/evals/observer-sidecar/latest'),
      handle: (req, res) => {
        if (!observerEvalSidecarService) {
          sendJson(res, 503, { error: OBSERVER_EVAL_SIDECAR_UNAVAILABLE_ERROR });
          return;
        }
        const parsed = parseObserverEvalObservationQuery(req, '/api/admin/evals/observer-sidecar/latest');
        if (!parsed.ok) {
          sendJson(res, 400, { error: parsed.error });
          return;
        }
        const { limit: _limit, ...filters } = parsed.value ?? {};
        observerEvalSidecarService.getLatestObservation(filters).then(
          payload => sendJson(res, 200, payload, ADMIN_DYNAMIC_JSON_HEADERS),
          error => handleObserverEvalError(res, error, 'Failed to load observer eval latest observation'),
        );
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/admin/evals/observer-sidecar/observations'),
      handle: (req, res) => {
        if (!observerEvalSidecarService) {
          sendJson(res, 503, { error: OBSERVER_EVAL_SIDECAR_UNAVAILABLE_ERROR });
          return;
        }
        const parsed = parseObserverEvalObservationQuery(req, '/api/admin/evals/observer-sidecar/observations');
        if (!parsed.ok) {
          sendJson(res, 400, { error: parsed.error });
          return;
        }
        observerEvalSidecarService.queryObservations(parsed.value).then(
          payload => sendJson(res, 200, payload, ADMIN_DYNAMIC_JSON_HEADERS),
          error => handleObserverEvalError(res, error, 'Failed to load observer eval observations'),
        );
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/admin/evals/observer-sidecar/runs'),
      handle: (req, res) => {
        if (!observerEvalSidecarService) {
          sendJson(res, 503, { error: OBSERVER_EVAL_SIDECAR_UNAVAILABLE_ERROR });
          return;
        }
        const parsed = parseObserverEvalRunQuery(req, '/api/admin/evals/observer-sidecar/runs');
        if (!parsed.ok) {
          sendJson(res, 400, { error: parsed.error });
          return;
        }
        observerEvalSidecarService.queryRuns(parsed.value).then(
          payload => sendJson(res, 200, payload, ADMIN_DYNAMIC_JSON_HEADERS),
          error => handleObserverEvalError(res, error, 'Failed to load observer eval runs'),
        );
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/admin/evals/observer-sidecar/export'),
      handle: (req, res) => {
        if (!observerEvalSidecarService) {
          sendJson(res, 503, { error: OBSERVER_EVAL_SIDECAR_UNAVAILABLE_ERROR });
          return;
        }
        const parsed = parseObserverEvalObservationQuery(req, '/api/admin/evals/observer-sidecar/export');
        if (!parsed.ok) {
          sendJson(res, 400, { error: parsed.error });
          return;
        }
        observerEvalSidecarService.exportObservations(parsed.value).then(
          payload => sendJson(res, 200, payload, ADMIN_DYNAMIC_JSON_HEADERS),
          error => handleObserverEvalError(res, error, 'Failed to export observer eval observations'),
        );
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/admin/action-pipe'),
      handle: (_req, res) => {
        if (!actionPipeService) {
          sendJson(res, 503, { error: ACTION_PIPE_UNAVAILABLE_ERROR });
          return;
        }
        actionPipeService.getActionPipeStatus().then(
          payload => sendJson(res, 200, payload, ADMIN_DYNAMIC_JSON_HEADERS),
          error => sendJson(res, 500, {
            error: toSanitizedMessage(error, 'Failed to load action pipe status'),
          }),
        );
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/admin/satellites'),
      handle: (_req, res) => {
        sendJson(
          res,
          200,
          buildAdminSatelliteRegistryView(config.satelliteRegistry),
          ADMIN_DYNAMIC_JSON_HEADERS,
        );
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/admin/images/generated'),
      handle: (_req, res) => {
        imagesService.listGeneratedImages().then(
          payload => sendJson(res, 200, payload, ADMIN_DYNAMIC_JSON_HEADERS),
          error => sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to list generated images') }),
        );
      },
    },
    {
      method: 'GET',
      match: paramWithSuffix('/api/admin/images/generated/', 'id', '/blob'),
      handle: (_req, res, { id }) => {
        imagesService.getGeneratedImageBlob(id).then(
          (blob) => {
            if (!blob) {
              sendJson(res, 404, { error: 'Generated image not found' });
              return;
            }
            sendImageBlob(res, blob);
          },
          error => sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to load generated image') }),
        );
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/admin/image-references'),
      handle: (_req, res) => {
        imagesService.listReferencePhotos().then(
          payload => sendJson(res, 200, payload, ADMIN_DYNAMIC_JSON_HEADERS),
          error => sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to list reference photos') }),
        );
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/admin/image-references/upload'),
      handle: (req, res) => {
        const url = parseRequestUrl(req, '/api/admin/image-references/upload');
        handleMultipartUpload(req, res, { maxBytes: 12 * 1024 * 1024 }).then(
          (uploadResult) => {
            if (!uploadResult.ok) {
              const safeError = toSanitizedMessage(uploadResult.error, 'Reference photo upload failed');
              appendIdentityMutationAudit(
                'denied',
                `Operator reference photo upload failed: ${safeError}`,
              );
              sendJson(res, uploadResult.status, { error: safeError });
              return;
            }
            imagesService.addReferencePhoto({
              filename: uploadResult.file.filename,
              contentType: uploadResult.file.contentType,
              data: uploadResult.file.data,
              description: url.searchParams.get('description') ?? undefined,
              tags: parseReferenceTagsQuery(url.searchParams.get('tags')),
              setDefault: parseSetDefaultQuery(url.searchParams.get('setDefault')),
            }).then(
              reference => {
                appendIdentityMutationAudit(
                  'allowed',
                  'Operator uploaded identity reference photo.',
                  [
                    `referenceId=${reference.id}`,
                    reference.isDefault ? 'default=true' : null,
                    reference.tags.length ? `tags=${reference.tags.join(',')}` : null,
                  ],
                );
                sendJson(res, 201, { ok: true, reference }, ADMIN_DYNAMIC_JSON_HEADERS);
              },
              error => {
                const safeError = toSanitizedMessage(error, 'Reference photo upload failed');
                appendIdentityMutationAudit(
                  'denied',
                  `Operator reference photo upload failed: ${safeError}`,
                  [`filename=${uploadResult.file.filename}`],
                );
                sendJson(res, statusFromReferenceError(error), { error: safeError });
              },
            );
          },
          (error) => {
            const safeError = toSanitizedMessage(error, 'Reference photo upload failed unexpectedly');
            appendIdentityMutationAudit(
              'denied',
              `Operator reference photo upload failed: ${safeError}`,
            );
            sendJson(res, 500, { error: safeError });
          },
        );
      },
    },
    {
      method: 'GET',
      match: paramWithSuffix('/api/admin/image-references/', 'id', '/blob'),
      handle: (_req, res, { id }) => {
        imagesService.getReferencePhotoBlob(id).then(
          (blob) => {
            if (!blob) {
              sendJson(res, 404, { error: 'Reference photo not found' });
              return;
            }
            sendImageBlob(res, blob);
          },
          error => sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to load reference photo') }),
        );
      },
    },
    {
      method: 'POST',
      match: paramWithSuffix('/api/admin/image-references/', 'id', '/default'),
      handle: (_req, res, { id }) => {
        imagesService.setDefaultReferencePhoto(id).then(
          reference => {
            appendIdentityMutationAudit(
              'allowed',
              'Operator set default identity reference photo.',
              [`referenceId=${reference.id}`],
            );
            sendJson(res, 200, { ok: true, reference }, ADMIN_DYNAMIC_JSON_HEADERS);
          },
          error => {
            const safeError = toSanitizedMessage(error, 'Failed to set default reference photo');
            appendIdentityMutationAudit(
              'denied',
              `Operator default reference photo update failed: ${safeError}`,
              [`referenceId=${id}`],
            );
            sendJson(res, statusFromReferenceError(error), { error: safeError });
          },
        );
      },
    },
    {
      method: 'PATCH',
      match: prefixedParamPath('/api/admin/image-references/', 'id'),
      handle: (req, res, { id }) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          if (parsed.value === null || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
            sendJson(res, 400, { error: 'Reference photo update payload must be a JSON object' });
            return;
          }
          const payload = parsed.value as Record<string, unknown>;
          imagesService.updateReferencePhoto(id, {
            ...(typeof payload.description === 'string' ? { description: payload.description } : {}),
            ...(Array.isArray(payload.tags)
              ? { tags: payload.tags.filter((tag): tag is string => typeof tag === 'string') }
              : {}),
            ...(typeof payload.setDefault === 'boolean' ? { setDefault: payload.setDefault } : {}),
          }).then(
            reference => {
              appendIdentityMutationAudit(
                'allowed',
                'Operator updated identity reference photo.',
                [`referenceId=${reference.id}`],
              );
              sendJson(res, 200, { ok: true, reference }, ADMIN_DYNAMIC_JSON_HEADERS);
            },
            error => {
              const safeError = toSanitizedMessage(error, 'Failed to update reference photo');
              appendIdentityMutationAudit(
                'denied',
                `Operator reference photo update failed: ${safeError}`,
                [`referenceId=${id}`],
              );
              sendJson(res, statusFromReferenceError(error), { error: safeError });
            },
          );
        });
      },
    },
    {
      method: 'DELETE',
      match: prefixedParamPath('/api/admin/image-references/', 'id'),
      handle: (_req, res, { id }) => {
        imagesService.deleteReferencePhoto(id).then(
          () => {
            appendIdentityMutationAudit(
              'allowed',
              'Operator deleted identity reference photo.',
              [`referenceId=${id}`],
            );
            sendJson(res, 200, { ok: true }, ADMIN_DYNAMIC_JSON_HEADERS);
          },
          error => {
            const safeError = toSanitizedMessage(error, 'Failed to delete reference photo');
            appendIdentityMutationAudit(
              'denied',
              `Operator reference photo deletion failed: ${safeError}`,
              [`referenceId=${id}`],
            );
            sendJson(res, statusFromReferenceError(error), { error: safeError });
          },
        );
      },
    },
    {
      method: 'POST',
      match: paramWithSuffix('/api/admin/action-pipe/actions/', 'actionRef', '/cancel'),
      handle: (req, res, { actionRef }) => {
        if (!actionPipeService) {
          sendJson(res, 503, { ok: false, message: ACTION_PIPE_UNAVAILABLE_ERROR });
          return;
        }
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { ok: false, message: parsed.error });
            return;
          }
          const payload = parsed.value as Record<string, unknown>;
          const reason = typeof payload.reason === 'string' ? payload.reason : undefined;
          actionPipeService.cancelAction({ actionRef, reason }).then(
            result => sendJson(res, result.ok ? 200 : 400, result, ADMIN_DYNAMIC_JSON_HEADERS),
            error => sendJson(res, 500, {
              ok: false,
              message: toSanitizedMessage(error, 'Failed to cancel action'),
            }),
          );
        });
      },
    },
    {
      method: 'POST',
      match: paramWithSuffix('/api/admin/action-pipe/actions/', 'actionRef', '/acknowledge'),
      handle: (req, res, { actionRef }) => {
        if (!actionPipeService) {
          sendJson(res, 503, { ok: false, message: ACTION_PIPE_UNAVAILABLE_ERROR });
          return;
        }
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { ok: false, message: parsed.error });
            return;
          }
          const payload = parsed.value as Record<string, unknown>;
          const detail = typeof payload.detail === 'string' ? payload.detail : undefined;
          actionPipeService.acknowledgeAction({ actionRef, detail }).then(
            result => sendJson(res, result.ok ? 200 : 400, result, ADMIN_DYNAMIC_JSON_HEADERS),
            error => sendJson(res, 500, {
              ok: false,
              message: toSanitizedMessage(error, 'Failed to acknowledge action'),
            }),
          );
        });
      },
    },
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

          if (!memoryType && !sensitivity) {
            sendJson(res, 400, { error: 'At least one field (memoryType, sensitivity) is required' });
            return;
          }

          memoryService.bulkUpdate(ids, { memoryType, sensitivity }).then(
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
      match: exactPath('/api/admin/sessions'),
      handle: (_req, res) => {
        sessionService.listSessions().then(
          (payload) => {
            sendJson(res, 200, payload);
          },
          (error) => {
            sendJson(res, 500, {
              error: toSanitizedMessage(error, 'Failed to load sessions'),
            });
          },
        );
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
        contactsService.listContacts(url.searchParams).then(
          (data) => {
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
          (error) => {
            sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to list contacts') });
          },
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
        contactsService.createContact(JSON.stringify(parsed.value)).then(
          (result) => {
            if (!result.ok) {
              sendJson(res, 400, { error: result.message });
              return;
            }
            sendJson(res, 201, result);
          },
          (error) => {
            sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to create contact') });
          },
        );
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
          contactsService.mergeContacts(id, JSON.stringify(parsed.value)).then(
            (result) => {
              if (!result.ok) {
                sendJson(res, result.message.includes('not found') ? 404 : 400, { error: result.message });
                return;
              }
              sendJson(res, 200, result);
            },
            (error) => {
              sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to merge contacts') });
            },
          );
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
          contactsService.unlinkChannelIdentity(id, JSON.stringify(parsed.value)).then(
            (result) => {
              if (!result.ok) {
                sendJson(res, result.message.includes('not found') ? 404 : 400, { error: result.message });
                return;
              }
              sendJson(res, 200, result);
            },
            (error) => {
              sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to unlink contact identity') });
            },
          );
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
          contactsService.deleteConversationChannel(id, JSON.stringify(parsed.value)).then(
            (result) => {
              if (!result.ok) {
                sendJson(res, result.message.includes('not found') ? 404 : 400, { error: result.message });
                return;
              }
              sendJson(res, 200, result);
            },
            (error) => {
              sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to delete conversation channel') });
            },
          );
        });
      },
    },
    {
      method: 'GET',
      match: prefixedParamPath('/api/admin/contacts/', 'id'),
      handle: (_req, res, { id }) => {
        contactsService.getContactDetail(id).then(
          (detail) => {
            if (!detail) {
              sendJson(res, 404, { error: 'Contact not found' });
              return;
            }
            sendJson(res, 200, detail, ADMIN_DYNAMIC_JSON_HEADERS);
          },
          (error) => {
            sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to load contact detail') });
          },
        );
      },
    },
    {
      method: 'DELETE',
      match: prefixedParamPath('/api/admin/contacts/', 'id'),
      handle: (_req, res, { id }) => {
        contactsService.deleteContact(id).then(
          (result) => {
            if (!result.ok) {
              sendJson(res, result.message.includes('not found') ? 404 : 400, { error: result.message });
              return;
            }
            sendJson(res, 200, result);
          },
          (error) => {
            sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to delete contact') });
          },
        );
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
            lastRunAt: task.lastRunAt,
            lastFinishedAt: task.lastFinishedAt,
            lastOutcome: task.lastOutcome,
            lastError: task.lastError,
            lastErrorAt: task.lastErrorAt,
            lastDeniedReason: task.lastDeniedReason,
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
