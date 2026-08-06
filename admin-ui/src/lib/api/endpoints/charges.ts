import { apiGet } from '$lib/api/client';
import { withQuery } from '$lib/api/query';
import type {
  RunChargeLedgerData,
  RunChargeLedgerEntry,
  RunChargeLedgerMetadata,
  RunChargeLedgerQuery,
  RunChargeRunSummary,
} from '../../../../../src/shared/telemetry/charge-ledger.js';
import type { RunChargeEvent, RunChargeLineage } from '../../../../../src/shared/contracts/runtime.js';
import type { FatigueLedgerData } from '../../../../../src/shared/telemetry/fatigue-ledger.js';
import type { FatigueTuningReport } from '../../../../../src/core/agent/fatigue/adaptive-tuning.js';
import type { FatiguePolicyConfig } from '../../../../../src/shared/contracts/charge-policy.js';
import type { HumanAttentionPressureLedgerData } from '../../../../../src/core/agent/fatigue/human-attention-ledger.js';

export type ChargeLedgerQuery = RunChargeLedgerQuery;
export type AdminChargeLedgerData = RunChargeLedgerData & {
  fatigue?: FatigueLedgerData;
  fatigueTuning?: FatigueTuningReport;
  fatigueSocialPolicy?: FatiguePolicyConfig['socialRegulation'];
  humanAttention?: HumanAttentionPressureLedgerData;
  humanAttentionPolicy?: FatiguePolicyConfig['humanAttention'];
};
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
  return apiGet<AdminChargeLedgerData>(withQuery('/api/admin/charges', params));
}
