import { apiGet } from '$lib/api/client';
import type {
  RunChargeLedgerData,
  RunChargeLedgerEntry,
  RunChargeLedgerMetadata,
  RunChargeLedgerQuery,
  RunChargeRunSummary,
} from '../../../../../src/shared/telemetry/charge-ledger.js';
import type { RunChargeEvent, RunChargeLineage } from '../../../../../src/shared/contracts/runtime.js';

export type ChargeLedgerQuery = RunChargeLedgerQuery;
export type AdminChargeLedgerData = RunChargeLedgerData;
export type {
  RunChargeEvent,
  RunChargeLedgerEntry,
  RunChargeLedgerMetadata,
  RunChargeLineage,
  RunChargeRunSummary,
};

export function getCharges(query: ChargeLedgerQuery = {}): Promise<AdminChargeLedgerData> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.sinceMs !== undefined) params.set('sinceMs', String(query.sinceMs));
  if (query.untilMs !== undefined) params.set('untilMs', String(query.untilMs));
  if (query.runId) params.set('runId', query.runId);
  const suffix = params.toString();
  return apiGet<AdminChargeLedgerData>(`/api/admin/charges${suffix ? `?${suffix}` : ''}`);
}
