import { apiGet } from '$lib/api/client';
import type {
  ChargeCostReconciliationData,
  ChargeCostReconciliationQuery,
} from '../../../../../src/shared/telemetry/charge-cost-reconciliation-contracts.js';

export type AdminChargeCostData = ChargeCostReconciliationData;
export type AdminChargeCostQuery = ChargeCostReconciliationQuery;

const QUERY_FIELDS = [
  'sinceMs',
  'untilMs',
  'companionId',
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
  const suffix = params.toString();
  return `/api/admin/charge-costs${suffix ? `?${suffix}` : ''}`;
}

export function getChargeCosts(query: AdminChargeCostQuery = {}): Promise<AdminChargeCostData> {
  return apiGet<AdminChargeCostData>(buildChargeCostsPath(query));
}
