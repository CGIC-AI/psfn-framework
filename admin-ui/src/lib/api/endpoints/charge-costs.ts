import { apiGet } from '$lib/api/client';
import { withQuery } from '$lib/api/query';
import type {
  ChargeCostReconciliationData,
  ChargeCostReconciliationQuery,
} from '../../../../../src/shared/telemetry/charge-cost-reconciliation-contracts.js';

export type AdminChargeCostData = ChargeCostReconciliationData;
export type AdminChargeCostQuery = ChargeCostReconciliationQuery;

const QUERY_FIELDS = [
  'sinceMs',
  'untilMs',
  // Companion authority comes from the authenticated Garden route, never a browser query.
  'channelId',
  'lane',
  'surface',
  'runId',
  'rootRunId',
] as const satisfies ReadonlyArray<keyof ChargeCostReconciliationQuery>;

export function buildChargeCostsPath(query: AdminChargeCostQuery = {}): string {
  const params = new URLSearchParams();
  for (const field of QUERY_FIELDS) {
    const value = query[field];
    if (value !== undefined) params.set(field, String(value));
  }
  return withQuery('/api/admin/charge-costs', params);
}

export function getChargeCosts(query: AdminChargeCostQuery = {}): Promise<AdminChargeCostData> {
  return apiGet<AdminChargeCostData>(buildChargeCostsPath(query));
}
