import { apiDownload, apiGet, type ApiDownload } from '$lib/api/client';
import type {
  ModelUsageData,
  ModelUsageEvent,
  ModelUsageQuery,
  ModelUsageTotals,
  ModelUsageBreakdown,
  ModelUsageDimensionTimeBucket,
} from '../../../../../src/shared/telemetry/model-usage.js';

export type AdminModelUsageData = ModelUsageData;
export type AdminModelUsageQuery = ModelUsageQuery;
export type {
  ModelUsageEvent,
  ModelUsageTotals,
  ModelUsageBreakdown,
  ModelUsageDimensionTimeBucket,
};

const MODEL_USAGE_QUERY_FIELDS = [
  'range', 'timezone', 'sinceMs', 'untilMs', 'bucket', 'limit', 'cursor', 'eventOrder',
  'topN', 'sortBy', 'sortDirection', 'provider', 'model', 'toolName', 'callKind', 'callType',
  'purpose', 'originType', 'originStage', 'service', 'process', 'companionId', 'sessionId',
  'channelId', 'channelType', 'turnId', 'requestId', 'toolCallId', 'chargeLane', 'chargeSurface',
  'chargeEventId',
  'chargeRunId', 'chargeRootRunId', 'chargeParentRunId', 'shardId', 'subagentId', 'conversationId',
  'rootInitiationId', 'workloadType', 'workloadId', 'slotKey', 'requestedProvider',
  'requestedModel', 'status', 'costSource', 'runId',
] as const satisfies ReadonlyArray<keyof ModelUsageQuery>;

export function modelUsageSearchParams(query: AdminModelUsageQuery): URLSearchParams {
  const params = new URLSearchParams();
  for (const field of MODEL_USAGE_QUERY_FIELDS) {
    const value = query[field];
    if (value !== undefined) params.set(field, String(value));
  }
  if (query.groupBy?.length) params.set('groupBy', query.groupBy.join(','));
  return params;
}

export function getModelUsage(query: AdminModelUsageQuery = {}): Promise<AdminModelUsageData> {
  return apiGet<AdminModelUsageData>(buildModelUsagePath(query));
}

export function buildModelUsagePath(query: AdminModelUsageQuery = {}): string {
  const suffix = modelUsageSearchParams(query).toString();
  return `/api/admin/model-usage${suffix ? `?${suffix}` : ''}`;
}

export function buildModelUsageExportPath(
  format: 'csv' | 'json',
  query: AdminModelUsageQuery = {},
): string {
  const params = modelUsageSearchParams(query);
  params.set('format', format);
  return `/api/admin/model-usage/export?${params.toString()}`;
}

export const getModelUsageExportUrl = buildModelUsageExportPath;

export function downloadModelUsageExport(
  format: 'csv' | 'json',
  query: AdminModelUsageQuery = {},
): Promise<ApiDownload> {
  return apiDownload(buildModelUsageExportPath(format, query));
}
