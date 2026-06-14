import { apiGet } from '$lib/api/client';
import type {
  ModelUsageData,
  ModelUsageEvent,
  ModelUsageQuery,
  ModelUsageTotals,
  ModelUsageBreakdown,
} from '../../../../../src/shared/telemetry/model-usage.js';

export type AdminModelUsageData = ModelUsageData;
export type AdminModelUsageQuery = ModelUsageQuery;
export type {
  ModelUsageEvent,
  ModelUsageTotals,
  ModelUsageBreakdown,
};

export function getModelUsage(query: AdminModelUsageQuery = {}): Promise<AdminModelUsageData> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.sinceMs !== undefined) params.set('sinceMs', String(query.sinceMs));
  if (query.untilMs !== undefined) params.set('untilMs', String(query.untilMs));
  if (query.provider) params.set('provider', query.provider);
  if (query.model) params.set('model', query.model);
  if (query.toolName) params.set('toolName', query.toolName);
  if (query.callKind) params.set('callKind', query.callKind);
  if (query.runId) params.set('runId', query.runId);
  const suffix = params.toString();
  return apiGet<AdminModelUsageData>(`/api/admin/model-usage${suffix ? `?${suffix}` : ''}`);
}
