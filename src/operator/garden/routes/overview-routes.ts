import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, sendText } from '../../../channels/backplane/http/primitives.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import { parseRequestUrl } from '../request-url.js';
import { exactPath, paramWithSuffix } from '../route-matchers.js';
import { buildAdminSatelliteRegistryView } from '../services/satellite-registry-service.js';
import {
  isDashboardCostWindow,
  resolveDashboardCostWindow,
} from '../services/dashboard-cost-windows.js';
import {
  isObserverEvalSidecarApiUnavailableError,
  type AdminObserverEvalSidecarService,
} from '../services/observer-eval-sidecar-service.js';
import type {
  AdminActionPipeService,
  AdminAuditHistoryService,
  AdminChargeCostReconciliationService,
  AdminChargeLedgerService,
  AdminDashboardService,
  AdminModelUsageService,
} from '../services/types.js';
import { AdminAuditHistoryEntryNotFoundError } from '../services/audit-history-service.js';
import {
  ADMIN_AUDIT_ACTION_TYPES,
  ADMIN_AUDIT_DECISIONS,
  ADMIN_AUDIT_TIME_RANGES,
} from '../audit-timeline.js';
import type {
  AdminAuditActionType,
  AdminAuditDecision,
  AdminAuditHistorySource,
  AdminAuditTimeRange,
} from '../types.js';
import { parseAdminJsonBody } from '../request-body.js';
import { ADMIN_DYNAMIC_JSON_HEADERS, toSanitizedMessage } from './shared.js';
import type { AdminApiRoute, AdminBodyReader } from './types.js';
import { parseModelUsageQuery } from './model-usage-query.js';
import { parseChargeCostQuery } from './charge-cost-query.js';

const AUDIT_HISTORY_UNAVAILABLE_ERROR = 'Audit history backend unavailable';
const CHARGE_LEDGER_UNAVAILABLE_ERROR = 'Charge ledger backend unavailable';
const CHARGE_COST_UNAVAILABLE_ERROR = 'Charge-cost reconciliation unavailable';
const MODEL_USAGE_UNAVAILABLE_ERROR = 'Model usage telemetry backend unavailable';
const OBSERVER_EVAL_SIDECAR_UNAVAILABLE_ERROR = 'Observer eval sidecar backend unavailable';
const ACTION_PIPE_UNAVAILABLE_ERROR = 'Action pipe backend unavailable';
const ADMIN_AUDIT_HISTORY_SOURCES = ['garden', 'gateway', 'charge'] as const;
const OBSERVER_EVAL_PRIVACY_CLASSES = ['public', 'private', 'restricted', 'closed', 'fail_closed'] as const;
const OBSERVER_EVAL_OBSERVATION_STATUSES = ['ok', 'degraded', 'error'] as const;
const OBSERVER_EVAL_RUN_STATUSES = ['running', 'completed', 'degraded', 'failed'] as const;
const OBSERVER_EVAL_LEVER_NAMES = ['would_message', 'would_check_in', 'would_rest', 'rumination_watch'] as const;

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

function parseObserverEvalLeverQuery(
  value: string | null,
): { ok: true; value?: typeof OBSERVER_EVAL_LEVER_NAMES[number] } | { ok: false; error: string } {
  if (value === null || value.trim() === '') return { ok: true };
  const normalized = value.trim();
  if (OBSERVER_EVAL_LEVER_NAMES.includes(normalized as typeof OBSERVER_EVAL_LEVER_NAMES[number])) {
    return { ok: true, value: normalized as typeof OBSERVER_EVAL_LEVER_NAMES[number] };
  }
  return {
    ok: false,
    error: `Invalid lever query parameter. Expected one of: ${OBSERVER_EVAL_LEVER_NAMES.join(', ')}.`,
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

export function buildAdminOverviewRoutes(options: {
  config: SubstrateConfig;
  dashboardService: AdminDashboardService;
  auditHistoryService?: AdminAuditHistoryService | null;
  chargeLedgerService?: AdminChargeLedgerService | null;
  chargeCostReconciliationService?: AdminChargeCostReconciliationService | null;
  modelUsageService?: AdminModelUsageService | null;
  observerEvalSidecarService?: AdminObserverEvalSidecarService | null;
  actionPipeService?: AdminActionPipeService | null;
  withBody: AdminBodyReader;
}): AdminApiRoute[] {
  const {
    config,
    dashboardService,
    auditHistoryService,
    chargeLedgerService,
    chargeCostReconciliationService,
    modelUsageService,
    observerEvalSidecarService,
    actionPipeService,
    withBody,
  } = options;

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

  const parseObserverEvalLeverEventQuery = (
    req: IncomingMessage,
    routePath: string,
  ): {
    ok: true;
    value: Parameters<NonNullable<AdminObserverEvalSidecarService>['queryLeverEvents']>[0];
  } | { ok: false; error: string } => {
    const url = parseRequestUrl(req, routePath);
    const limit = toPositiveIntegerQueryNumber(url.searchParams.get('limit'), 'limit');
    if (!limit.ok) return { ok: false, error: limit.error };
    const sinceMs = toFiniteQueryNumber(url.searchParams.get('sinceMs'), 'sinceMs');
    if (!sinceMs.ok) return { ok: false, error: sinceMs.error };
    const untilMs = toFiniteQueryNumber(url.searchParams.get('untilMs'), 'untilMs');
    if (!untilMs.ok) return { ok: false, error: untilMs.error };
    const lever = parseObserverEvalLeverQuery(url.searchParams.get('lever'));
    if (!lever.ok) return { ok: false, error: lever.error };
    return {
      ok: true,
      value: {
        ...(limit.value !== undefined ? { limit: limit.value } : {}),
        ...(sinceMs.value !== undefined ? { sinceMs: sinceMs.value } : {}),
        ...(untilMs.value !== undefined ? { untilMs: untilMs.value } : {}),
        ...(lever.value !== undefined ? { lever: lever.value } : {}),
        ...(url.searchParams.get('runId')?.trim() ? { runId: url.searchParams.get('runId')!.trim() } : {}),
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
          sendJson(
            res,
            400,
            { error: 'Invalid costWindow query parameter. Expected today, week, or month.' },
            ADMIN_DYNAMIC_JSON_HEADERS,
          );
          return;
        }
        const costWindow = resolveDashboardCostWindow(costWindowParam);
        dashboardService.getDashboardData({ costWindow }).then(
          (payload) => {
            sendJson(res, 200, payload, ADMIN_DYNAMIC_JSON_HEADERS);
          },
          (error) => {
            sendJson(res, 500, {
              error: `Failed to load dashboard data: ${toSanitizedMessage(error, 'unknown error')}`,
            }, ADMIN_DYNAMIC_JSON_HEADERS);
          },
        );
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/admin/dashboard/analysis-workbench-traces'),
      handle: (_req, res) => {
        try {
          sendJson(
            res,
            200,
            { traces: dashboardService.listAnalysisWorkbenchTraces() },
            ADMIN_DYNAMIC_JSON_HEADERS,
          );
        } catch (error) {
          sendJson(res, 500, {
            error: `Failed to load analysis workbench traces: ${toSanitizedMessage(error, 'unknown error')}`,
          }, ADMIN_DYNAMIC_JSON_HEADERS);
        }
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
      match: paramWithSuffix('/api/admin/audit/history/', 'entryId', ''),
      handle: (_req, res, params) => {
        if (!auditHistoryService) {
          sendJson(res, 503, { error: AUDIT_HISTORY_UNAVAILABLE_ERROR });
          return;
        }
        auditHistoryService.getAuditHistoryDetail(params.entryId).then(
          payload => sendJson(res, 200, payload, ADMIN_DYNAMIC_JSON_HEADERS),
          error => {
            if (error instanceof AdminAuditHistoryEntryNotFoundError) {
              sendJson(res, 404, { error: 'Audit history entry not found' }, ADMIN_DYNAMIC_JSON_HEADERS);
              return;
            }
            sendJson(res, 500, {
              error: toSanitizedMessage(error, 'Failed to load audit history detail'),
            }, ADMIN_DYNAMIC_JSON_HEADERS);
          },
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
        // E7.3: per-room / per-peer fatigue read surface. These filters flow to
        // the fatigue ledger (FatigueLedgerQuery) so an operator can inspect a
        // single companion room's conversation-fatigue state and scope summaries.
        const channelId = url.searchParams.get('channelId')?.trim() || undefined;
        const peerContactId = url.searchParams.get('peerContactId')?.trim() || undefined;
        const localCompanionId = url.searchParams.get('localCompanionId')?.trim() || undefined;
        const dayKey = url.searchParams.get('dayKey')?.trim() || undefined;

        chargeLedgerService.getChargeLedgerData({
          ...(limit.value !== undefined ? { limit: limit.value } : {}),
          ...(sinceMs.value !== undefined ? { sinceMs: sinceMs.value } : {}),
          ...(untilMs.value !== undefined ? { untilMs: untilMs.value } : {}),
          ...(runId ? { runId } : {}),
          ...(channelId ? { channelId } : {}),
          ...(peerContactId ? { peerContactId } : {}),
          ...(localCompanionId ? { localCompanionId } : {}),
          ...(dayKey ? { dayKey } : {}),
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
      match: exactPath('/api/admin/charge-costs'),
      handle: (req, res) => {
        if (!chargeCostReconciliationService) {
          sendJson(res, 503, { error: CHARGE_COST_UNAVAILABLE_ERROR });
          return;
        }
        const url = parseRequestUrl(req, '/api/admin/charge-costs');
        const query = parseChargeCostQuery(url.searchParams);
        if (!query.ok) {
          sendJson(res, 400, { error: query.error });
          return;
        }
        if (
          query.value.companionId
          && config.companionId
          && query.value.companionId !== config.companionId
        ) {
          sendJson(res, 403, { error: 'Charge-cost query is outside this Garden tenant.' });
          return;
        }
        chargeCostReconciliationService.getChargeCostReconciliation(query.value).then(
          payload => sendJson(res, 200, payload, ADMIN_DYNAMIC_JSON_HEADERS),
          error => sendJson(res, 500, {
            error: toSanitizedMessage(error, 'Failed to reconcile charge and model-usage telemetry'),
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
        const query = parseModelUsageQuery(url.searchParams);
        if (!query.ok) {
          sendJson(res, 400, { error: query.error });
          return;
        }
        if (
          query.value.companionId
          && config.companionId
          && query.value.companionId !== config.companionId
        ) {
          sendJson(res, 403, { error: 'Model usage query is outside this Garden tenant.' });
          return;
        }

        modelUsageService.getModelUsageData(query.value).then(
          payload => sendJson(res, 200, payload, ADMIN_DYNAMIC_JSON_HEADERS),
          error => sendJson(res, 500, {
            error: toSanitizedMessage(error, 'Failed to load model usage telemetry'),
          }),
        );
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/admin/model-usage/export'),
      handle: (req, res) => {
        if (!modelUsageService?.exportModelUsageData) {
          sendJson(res, 503, { error: MODEL_USAGE_UNAVAILABLE_ERROR });
          return;
        }
        const url = parseRequestUrl(req, '/api/admin/model-usage/export');
        const formats = url.searchParams.getAll('format');
        if (formats.length !== 1 || (formats[0] !== 'csv' && formats[0] !== 'json')) {
          sendJson(res, 400, { error: 'format query parameter must be exactly one of: csv, json.' });
          return;
        }
        const queryParams = new URLSearchParams(url.searchParams);
        queryParams.delete('format');
        const query = parseModelUsageQuery(queryParams);
        if (!query.ok) {
          sendJson(res, 400, { error: query.error });
          return;
        }
        if (
          query.value.companionId
          && config.companionId
          && query.value.companionId !== config.companionId
        ) {
          sendJson(res, 403, { error: 'Model usage export is outside this Garden tenant.' });
          return;
        }
        modelUsageService.exportModelUsageData(query.value, formats[0]).then(
          payload => sendText(res, 200, payload.body, {
            ...ADMIN_DYNAMIC_JSON_HEADERS,
            'Content-Type': payload.contentType,
            'Content-Disposition': `attachment; filename="${payload.filename}"`,
            'X-Model-Usage-Row-Count': String(payload.rowCount),
          }),
          error => sendJson(res, 500, {
            error: toSanitizedMessage(error, 'Failed to export model usage telemetry'),
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
      match: exactPath('/api/admin/evals/observer-sidecar/lever-events'),
      handle: (req, res) => {
        if (!observerEvalSidecarService) {
          sendJson(res, 503, { error: OBSERVER_EVAL_SIDECAR_UNAVAILABLE_ERROR });
          return;
        }
        const parsed = parseObserverEvalLeverEventQuery(req, '/api/admin/evals/observer-sidecar/lever-events');
        if (!parsed.ok) {
          sendJson(res, 400, { error: parsed.error });
          return;
        }
        observerEvalSidecarService.queryLeverEvents(parsed.value).then(
          payload => sendJson(res, 200, payload, ADMIN_DYNAMIC_JSON_HEADERS),
          error => handleObserverEvalError(res, error, 'Failed to load observer eval lever events'),
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
  ];
}
