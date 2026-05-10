import { apiGet } from '$lib/api/client';

export interface ChargeLedgerQuery {
  limit?: number;
  sinceMs?: number;
  untilMs?: number;
  runId?: string;
}

export interface RunChargeLedgerMetadata {
  provider?: string;
  model?: string;
  modality?: string;
  referenceModelClass?: string;
  shardId?: string;
  subagentId?: string;
}

export interface RunChargeLineage {
  runId: string;
  rootRunId: string;
  parentRunId?: string;
}

export interface RunChargeEvent {
  timestampMs: number;
  lane: string;
  surface: string;
  amount: number;
  quota: number;
  spentAfter: number;
  remainingAfter: number;
  lineage: RunChargeLineage;
  details?: Record<string, unknown>;
}

export interface RunChargeLedgerEntry {
  schemaVersion: 1;
  recordType: 'charge_event';
  eventId: string;
  recordedAtMs: number;
  event: RunChargeEvent;
  metadata?: RunChargeLedgerMetadata;
}

export interface RunChargeBreakdown {
  key: string;
  amount: number;
  eventCount: number;
}

export interface RunChargeRunSummary {
  runId: string;
  rootRunId: string;
  parentRunId?: string;
  startedAtMs: number;
  updatedAtMs: number;
  eventCount: number;
  amount: number;
  spentByLane: Record<string, number | undefined>;
  spentBySurface: Record<string, number | undefined>;
  lineageDepth: number;
  shardIds: string[];
  subagentIds: string[];
  models: string[];
  lastQuotaByLane: Record<string, number | undefined>;
  lastSpentAfterByLane: Record<string, number | undefined>;
  lastRemainingAfterByLane: Record<string, number | undefined>;
}

export interface RunChargeLedgerAggregates {
  amount: number;
  eventCount: number;
  byLane: RunChargeBreakdown[];
  bySurface: RunChargeBreakdown[];
  byLineage: RunChargeBreakdown[];
}

export interface AdminChargeLedgerData {
  activeRun: RunChargeRunSummary | null;
  recentRuns: RunChargeRunSummary[];
  aggregates: RunChargeLedgerAggregates;
  events: RunChargeLedgerEntry[];
}

export function getCharges(query: ChargeLedgerQuery = {}): Promise<AdminChargeLedgerData> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.sinceMs !== undefined) params.set('sinceMs', String(query.sinceMs));
  if (query.untilMs !== undefined) params.set('untilMs', String(query.untilMs));
  if (query.runId) params.set('runId', query.runId);
  const suffix = params.toString();
  return apiGet<AdminChargeLedgerData>(`/api/admin/charges${suffix ? `?${suffix}` : ''}`);
}
