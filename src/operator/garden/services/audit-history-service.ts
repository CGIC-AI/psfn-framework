import { existsSync, readFileSync } from 'node:fs';
import { appendJsonLine } from '../../../persistence/jsonl.js';
import type {
  AdminAuditActionType,
  AdminAuditActor,
  AdminAuditDecision,
  AdminAuditHistoryData,
  AdminAuditHistoryEntry,
  AdminAuditHistoryFilters,
  AdminAuditHistorySource,
  AdminAuditTimeRange,
} from '../types.js';
import type { AuditEntry } from '../../../boundary/gateway/audit-port.js';
import type {
  GatewayAuditHistoryPage,
  GatewayAuditHistoryQuery,
} from '../../../boundary/gateway/audit.js';
import type {
  RunChargeLedger,
  RunChargeLedgerEntry,
} from '../../../shared/telemetry/charge-ledger.js';

const GARDEN_AUDIT_SCHEMA_VERSION = 1;
const DEFAULT_HISTORY_LIMIT = 100;
const MAX_HISTORY_LIMIT = 500;
const MAX_SOURCE_SCAN = 2_000;

const TIME_RANGE_MS: Record<Exclude<AdminAuditTimeRange, 'all'>, number> = {
  '15m': 15 * 60 * 1_000,
  '1h': 60 * 60 * 1_000,
  '24h': 24 * 60 * 60 * 1_000,
  '7d': 7 * 24 * 60 * 60_000,
  '30d': 30 * 24 * 60 * 60_000,
};

interface GardenAuditJsonlRecord {
  schemaVersion: 1;
  recordType: 'garden_audit_history';
  entry: AdminAuditHistoryEntry;
}

export interface AdminAuditHistoryQuery {
  actionType?: AdminAuditActionType | 'all';
  decision?: AdminAuditDecision | 'all';
  timeRange?: AdminAuditTimeRange;
  source?: AdminAuditHistorySource | 'all';
  query?: string;
  limit?: number;
  offset?: number;
}

export interface AdminAuditHistoryService {
  appendGardenEntry(input: {
    actionType: AdminAuditActionType;
    decision: AdminAuditDecision;
    narrative: string;
    details?: string;
    actor?: AdminAuditActor;
    timestamp?: number;
    raw?: Record<string, unknown>;
  }): AdminAuditHistoryEntry;
  getAuditHistory(query?: AdminAuditHistoryQuery): Promise<AdminAuditHistoryData>;
}

export type GatewayAuditHistoryReader = (query: GatewayAuditHistoryQuery) => GatewayAuditHistoryPage;

export class GardenAuditHistoryJsonlStore {
  constructor(private readonly path: string) {}

  append(entry: AdminAuditHistoryEntry): void {
    appendJsonLine(this.path, {
      schemaVersion: GARDEN_AUDIT_SCHEMA_VERSION,
      recordType: 'garden_audit_history',
      entry,
    } satisfies GardenAuditJsonlRecord);
  }

  list(): AdminAuditHistoryEntry[] {
    if (!existsSync(this.path)) return [];
    const raw = readFileSync(this.path, 'utf-8');
    if (!raw.trim()) return [];
    return raw.split('\n')
      .filter(line => line.trim().length > 0)
      .map((line, index) => parseGardenAuditLine(line, index + 1));
  }
}

export class AdminAuditHistoryDataService implements AdminAuditHistoryService {
  private counter = 0;

  constructor(private readonly deps: {
    gardenStore: GardenAuditHistoryJsonlStore;
    gatewayReader?: GatewayAuditHistoryReader | null;
    chargeLedger?: Pick<RunChargeLedger, 'getData'> | null;
    now?: () => number;
  }) {}

  appendGardenEntry(input: {
    actionType: AdminAuditActionType;
    decision: AdminAuditDecision;
    narrative: string;
    details?: string;
    actor?: AdminAuditActor;
    timestamp?: number;
    raw?: Record<string, unknown>;
  }): AdminAuditHistoryEntry {
    const timestamp = input.timestamp ?? this.now();
    const entry: AdminAuditHistoryEntry = {
      id: `garden-audit-${timestamp}-${++this.counter}`,
      timestamp,
      source: 'garden',
      sourceRecordId: `garden:${timestamp}:${this.counter}`,
      actionType: input.actionType,
      decision: input.decision,
      narrative: input.narrative,
      ...(input.details?.trim() ? { details: input.details.trim() } : {}),
      ...(input.actor ? { actor: input.actor } : {}),
      ...(input.raw ? { raw: input.raw } : {}),
    };
    this.deps.gardenStore.append(entry);
    return entry;
  }

  async getAuditHistory(query: AdminAuditHistoryQuery = {}): Promise<AdminAuditHistoryData> {
    const filters = normalizeAuditHistoryFilters(query);
    const sinceMs = resolveSinceMs(filters.timeRange, this.now());

    const gardenEntries = safeReadGardenEntries(this.deps.gardenStore);
    const gateway = safeReadGatewayEntries(this.deps.gatewayReader ?? null, {
      limit: MAX_SOURCE_SCAN,
      ...(filters.decision !== 'all' ? { decision: toGatewayDecision(filters.decision) } : {}),
      ...(sinceMs !== undefined ? { sinceMs } : {}),
      ...(filters.query ? { query: filters.query } : {}),
    });
    const charge = await safeReadChargeEntries(this.deps.chargeLedger ?? null, {
      limit: MAX_SOURCE_SCAN,
      ...(sinceMs !== undefined ? { sinceMs } : {}),
    });

    const allEntries = [
      ...gardenEntries,
      ...gateway.entries,
      ...charge.entries,
    ]
      .filter(entry => matchesFilters(entry, filters, sinceMs))
      .sort((left, right) => {
        const delta = right.timestamp - left.timestamp;
        if (delta !== 0) return delta;
        return right.id.localeCompare(left.id);
      });

    const pageEntries = allEntries.slice(filters.offset, filters.offset + filters.limit);
    return {
      entries: pageEntries,
      filters,
      pagination: {
        limit: filters.limit,
        offset: filters.offset,
        total: allEntries.length,
        hasPrevious: filters.offset > 0,
        hasNext: filters.offset + filters.limit < allEntries.length,
      },
      sources: {
        garden: { available: true, count: gardenEntries.length },
        gateway: {
          available: gateway.available,
          count: gateway.entries.length,
          ...(gateway.message ? { message: gateway.message } : {}),
        },
        charge: {
          available: charge.available,
          count: charge.entries.length,
          ...(charge.message ? { message: charge.message } : {}),
        },
      },
    };
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

function parseGardenAuditLine(line: string, lineNumber: number): AdminAuditHistoryEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new Error(`Invalid Garden audit history JSON at line ${lineNumber}: ${String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid Garden audit history at line ${lineNumber}: expected object`);
  }
  const record = parsed as Partial<GardenAuditJsonlRecord>;
  if (record.schemaVersion !== GARDEN_AUDIT_SCHEMA_VERSION || record.recordType !== 'garden_audit_history') {
    throw new Error(`Invalid Garden audit history at line ${lineNumber}: unsupported schema`);
  }
  const entry = record.entry;
  if (!entry || typeof entry !== 'object') {
    throw new Error(`Invalid Garden audit history at line ${lineNumber}: missing entry`);
  }
  return entry;
}

function normalizeAuditHistoryFilters(query: AdminAuditHistoryQuery): AdminAuditHistoryFilters {
  return {
    actionType: query.actionType ?? 'all',
    decision: query.decision ?? 'all',
    timeRange: query.timeRange ?? '24h',
    source: query.source ?? 'all',
    ...(query.query?.trim() ? { query: query.query.trim() } : {}),
    limit: normalizeLimit(query.limit),
    offset: normalizeOffset(query.offset),
  };
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_HISTORY_LIMIT;
  return Math.min(MAX_HISTORY_LIMIT, Math.max(1, Math.trunc(value)));
}

function normalizeOffset(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function resolveSinceMs(timeRange: AdminAuditTimeRange, now: number): number | undefined {
  if (timeRange === 'all') return undefined;
  return Math.max(0, now - TIME_RANGE_MS[timeRange]);
}

function matchesFilters(
  entry: AdminAuditHistoryEntry,
  filters: AdminAuditHistoryFilters,
  sinceMs: number | undefined,
): boolean {
  if (sinceMs !== undefined && entry.timestamp < sinceMs) return false;
  if (filters.source !== 'all' && entry.source !== filters.source) return false;
  if (filters.actionType !== 'all' && entry.actionType !== filters.actionType) return false;
  if (filters.decision !== 'all' && entry.decision !== filters.decision) return false;
  if (filters.query && !entryMatchesTextQuery(entry, filters.query)) return false;
  return true;
}

function entryMatchesTextQuery(entry: AdminAuditHistoryEntry, query: string): boolean {
  const normalized = query.toLowerCase();
  return [
    entry.narrative,
    entry.details,
    entry.source,
    entry.sourceRecordId,
    entry.actionType,
    entry.decision,
    entry.actor,
  ]
    .filter((value): value is string => typeof value === 'string')
    .some(value => value.toLowerCase().includes(normalized));
}

function safeReadGardenEntries(store: GardenAuditHistoryJsonlStore): AdminAuditHistoryEntry[] {
  return store.list();
}

function safeReadGatewayEntries(
  reader: GatewayAuditHistoryReader | null,
  query: GatewayAuditHistoryQuery,
): { available: boolean; entries: AdminAuditHistoryEntry[]; message?: string } {
  if (!reader) {
    return { available: false, entries: [], message: 'Gateway audit history is unavailable.' };
  }
  try {
    const page = reader(query);
    return {
      available: true,
      entries: page.entries.map(mapGatewayAuditEntry),
    };
  } catch (error) {
    return {
      available: false,
      entries: [],
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function safeReadChargeEntries(
  ledger: Pick<RunChargeLedger, 'getData'> | null,
  query: { limit: number; sinceMs?: number },
): Promise<{ available: boolean; entries: AdminAuditHistoryEntry[]; message?: string }> {
  if (!ledger) {
    return { available: false, entries: [], message: 'Charge ledger is unavailable.' };
  }
  try {
    const data = await ledger.getData(query);
    return {
      available: true,
      entries: data.events.map(mapChargeLedgerEntry),
    };
  } catch (error) {
    return {
      available: false,
      entries: [],
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function mapGatewayAuditEntry(entry: AuditEntry): AdminAuditHistoryEntry {
  const decision = fromGatewayDecision(entry.decision);
  const details = [
    entry.durationMs !== null ? `durationMs=${entry.durationMs}` : null,
    entry.error ? `error=${entry.error}` : null,
  ].filter((value): value is string => Boolean(value)).join(' ');
  return {
    id: `gateway-audit-${entry.id}`,
    source: 'gateway',
    sourceRecordId: String(entry.id),
    timestamp: entry.timestamp,
    actionType: 'gateway_policy',
    decision,
    narrative: `Gateway ${entry.method} ${entry.decision}.`,
    ...(details ? { details } : {}),
    raw: {
      method: entry.method,
      decision: entry.decision,
      paramsJson: entry.paramsJson,
      durationMs: entry.durationMs,
      error: entry.error,
    },
  };
}

function mapChargeLedgerEntry(entry: RunChargeLedgerEntry): AdminAuditHistoryEntry {
  const event = entry.event;
  const model = entry.metadata?.model ?? stringDetail(event.details, 'model');
  const provider = entry.metadata?.provider ?? stringDetail(event.details, 'provider');
  return {
    id: `charge-audit-${entry.eventId}`,
    source: 'charge',
    sourceRecordId: entry.eventId,
    timestamp: event.timestampMs,
    actionType: 'charge_decision',
    decision: 'allowed',
    narrative: `Charge ${event.surface} spent ${event.amount} on ${event.lane}.`,
    details: [
      `runId=${event.lineage.runId}`,
      provider ? `provider=${provider}` : null,
      model ? `model=${model}` : null,
      `spentAfter=${event.spentAfter}`,
      `remainingAfter=${event.remainingAfter}`,
    ].filter((value): value is string => Boolean(value)).join(' '),
    raw: {
      eventId: entry.eventId,
      recordedAtMs: entry.recordedAtMs,
      event,
      metadata: entry.metadata,
    },
  };
}

function fromGatewayDecision(decision: AuditEntry['decision']): AdminAuditDecision {
  switch (decision) {
    case 'ALLOW':
      return 'allowed';
    case 'NEEDS_APPROVAL':
      return 'needs_approval';
    case 'DENY':
      return 'denied';
  }
}

function toGatewayDecision(decision: AdminAuditDecision): AuditEntry['decision'] {
  switch (decision) {
    case 'allowed':
      return 'ALLOW';
    case 'needs_approval':
      return 'NEEDS_APPROVAL';
    case 'denied':
      return 'DENY';
  }
}

function stringDetail(details: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = details?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
