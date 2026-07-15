import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
  statSync,
  type Stats,
} from 'node:fs';
import { createHmac } from 'node:crypto';
import { appendJsonLine } from '../../../persistence/jsonl.js';
import type { SessionHmacKeyring } from '../../../persistence/journals/journal-utils.js';
import type {
  AdminAuditActionType,
  AdminAuditActor,
  AdminAuditDecision,
  AdminAuditHistoryData,
  AdminAuditHistoryDetailData,
  AdminAuditHistoryEntry,
  AdminAuditHistoryFilters,
  AdminAuditHistoryListEntry,
  AdminAuditHistorySource,
  AdminAuditTimeRange,
} from '../types.js';
import type { AuditEntry } from '../../../boundary/gateway/audit-port.js';
import type {
  GatewayAuditHistoryPage,
  GatewayAuditHistoryQuery,
} from '../../../boundary/gateway/audit-port.js';
import type {
  RunChargeLedger,
  RunChargeLedgerEntry,
} from '../../../shared/telemetry/charge-ledger.js';

const GARDEN_AUDIT_SCHEMA_VERSION = 1;
const DEFAULT_HISTORY_LIMIT = 100;
const MAX_HISTORY_LIMIT = 500;
const MAX_SOURCE_SCAN = 2_000;
const MAX_GARDEN_AUDIT_READ_BYTES = 16 * 1_024 * 1_024;
const AUDIT_OPAQUE_ID_CONTEXT = 'psfn-garden-audit-opaque-id-v1';

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
  getAuditHistoryDetail(entryId: string): Promise<AdminAuditHistoryDetailData>;
}

export class AdminAuditHistoryEntryNotFoundError extends Error {
  constructor() {
    super('Audit history entry not found.');
    this.name = 'AdminAuditHistoryEntryNotFoundError';
  }
}

export type GatewayAuditHistoryReader = (query: GatewayAuditHistoryQuery) => GatewayAuditHistoryPage;

interface GardenAuditFileIdentity {
  device: number;
  inode: number;
  size: number;
  modifiedAtMs: number;
  changedAtMs: number;
}

export interface GardenAuditHistoryJsonlStoreOptions {
  maxEntries?: number;
  maxReadBytes?: number;
  onRead?: (bytes: number) => void;
  /** Test seam for proving fail-closed behavior when a file changes mid-read. */
  afterRead?: () => void;
}

export class GardenAuditHistoryJsonlStore {
  private readonly maxEntries: number;
  private readonly maxReadBytes: number;
  private cache: { identity: GardenAuditFileIdentity; entries: AdminAuditHistoryEntry[] } | null = null;

  constructor(
    private readonly path: string,
    private readonly options: GardenAuditHistoryJsonlStoreOptions = {},
  ) {
    this.maxEntries = positiveInteger(options.maxEntries, MAX_SOURCE_SCAN);
    this.maxReadBytes = positiveInteger(options.maxReadBytes, MAX_GARDEN_AUDIT_READ_BYTES);
  }

  append(entry: AdminAuditHistoryEntry): void {
    appendJsonLine(this.path, {
      schemaVersion: GARDEN_AUDIT_SCHEMA_VERSION,
      recordType: 'garden_audit_history',
      entry,
    } satisfies GardenAuditJsonlRecord);
    this.cache = null;
  }

  list(): AdminAuditHistoryEntry[] {
    const before = readFileIdentity(this.path);
    if (!before) {
      this.cache = null;
      return [];
    }
    if (this.cache && identitiesEqual(this.cache.identity, before)) {
      return [...this.cache.entries];
    }

    let descriptor: number;
    try {
      descriptor = openSync(this.path, 'r');
    } catch (error) {
      throw new Error(`Garden audit history changed while it was being read: ${String(error)}`);
    }

    try {
      const opened = identityFromStats(fstatSync(descriptor));
      if (!identitiesEqual(before, opened)) {
        throw new Error('Garden audit history changed while it was being read.');
      }

      const bytesToRead = Math.min(opened.size, this.maxReadBytes);
      const start = opened.size - bytesToRead;
      const buffer = Buffer.allocUnsafe(bytesToRead);
      let bytesRead = 0;
      while (bytesRead < bytesToRead) {
        const count = readSync(descriptor, buffer, bytesRead, bytesToRead - bytesRead, start + bytesRead);
        if (count === 0) break;
        bytesRead += count;
      }
      this.options.onRead?.(bytesRead);
      this.options.afterRead?.();

      const afterDescriptorRead = identityFromStats(fstatSync(descriptor));
      const afterPathRead = readFileIdentity(this.path);
      if (
        bytesRead !== bytesToRead
        || !identitiesEqual(opened, afterDescriptorRead)
        || !afterPathRead
        || !identitiesEqual(opened, afterPathRead)
      ) {
        throw new Error('Garden audit history changed while it was being read.');
      }

      const entries = parseRecentGardenAuditEntries(
        buffer.subarray(0, bytesRead),
        start > 0,
        this.maxEntries,
      );
      this.cache = { identity: afterPathRead, entries };
      return [...entries];
    } finally {
      closeSync(descriptor);
    }
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

function readFileIdentity(path: string): GardenAuditFileIdentity | null {
  try {
    return identityFromStats(statSync(path));
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw error;
  }
}

function identityFromStats(stats: Stats): GardenAuditFileIdentity {
  return {
    device: stats.dev,
    inode: stats.ino,
    size: stats.size,
    modifiedAtMs: stats.mtimeMs,
    changedAtMs: stats.ctimeMs,
  };
}

function identitiesEqual(left: GardenAuditFileIdentity, right: GardenAuditFileIdentity): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.modifiedAtMs === right.modifiedAtMs
    && left.changedAtMs === right.changedAtMs;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function parseRecentGardenAuditEntries(
  buffer: Buffer,
  startsInsideFile: boolean,
  maxEntries: number,
): AdminAuditHistoryEntry[] {
  if (buffer.length === 0) return [];
  let raw = buffer.toString('utf8');
  if (startsInsideFile) {
    const firstCompleteLine = raw.indexOf('\n');
    if (firstCompleteLine < 0) {
      throw new Error('Garden audit history entry exceeds the bounded read window.');
    }
    raw = raw.slice(firstCompleteLine + 1);
  }
  const lines = raw.split('\n').filter(line => line.trim().length > 0);
  return lines
    .slice(-maxEntries)
    .map((line, index) => parseGardenAuditLine(line, index + 1));
}

export class AdminAuditHistoryDataService implements AdminAuditHistoryService {
  private counter = 0;
  private readonly activeOpaqueIdKey: string;
  private readonly opaqueIdKeys: readonly string[];

  constructor(private readonly deps: {
    gardenStore: GardenAuditHistoryJsonlStore;
    gatewayReader?: GatewayAuditHistoryReader | null;
    chargeLedger?: Pick<RunChargeLedger, 'getData'> | null;
    scopeId: string;
    opaqueIdKeyring: SessionHmacKeyring;
    now?: () => number;
  }) {
    if (!deps.scopeId.trim()) {
      throw new Error('Audit history scopeId is required.');
    }
    const activeKeyValue: unknown = deps.opaqueIdKeyring.keys[deps.opaqueIdKeyring.activeVersion];
    const activeKey = typeof activeKeyValue === 'string' ? activeKeyValue.trim() : '';
    const configuredKeys = Object.values(deps.opaqueIdKeyring.keys).map(key => key.trim());
    if (!activeKey || configuredKeys.length === 0 || configuredKeys.some(key => key.length === 0)) {
      throw new Error('Audit history requires a valid server-side opaque-id keyring.');
    }
    this.activeOpaqueIdKey = activeKey;
    this.opaqueIdKeys = [...new Set(configuredKeys)];
  }

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

    const { gardenEntries, gateway, charge } = await this.readBoundedSourceWindow();

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

    const pageEntries = allEntries
      .slice(filters.offset, filters.offset + filters.limit)
      .map(entry => toAuditHistoryListEntry(entry, this.deps.scopeId, this.activeOpaqueIdKey));
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

  async getAuditHistoryDetail(entryId: string): Promise<AdminAuditHistoryDetailData> {
    if (!/^audit_[A-Za-z0-9_-]{43}$/.test(entryId)) {
      throw new AdminAuditHistoryEntryNotFoundError();
    }
    const { gardenEntries, gateway, charge } = await this.readBoundedSourceWindow();
    const entry = [...gardenEntries, ...gateway.entries, ...charge.entries]
      .find(candidate => this.opaqueIdKeys.some(key => (
        toOpaqueAuditEntryId(candidate, this.deps.scopeId, key) === entryId
      )));
    if (!entry) throw new AdminAuditHistoryEntryNotFoundError();
    return {
      entry: {
        ...toAuditHistoryListEntry(entry, this.deps.scopeId, this.activeOpaqueIdKey),
        id: entryId,
      },
      raw: entry.raw ?? null,
    };
  }

  private async readBoundedSourceWindow(): Promise<{
    gardenEntries: AdminAuditHistoryEntry[];
    gateway: { available: boolean; entries: AdminAuditHistoryEntry[]; message?: string };
    charge: { available: boolean; entries: AdminAuditHistoryEntry[]; message?: string };
  }> {
    const gardenEntries = safeReadGardenEntries(this.deps.gardenStore);
    const gateway = safeReadGatewayEntries(this.deps.gatewayReader ?? null, {
      limit: MAX_SOURCE_SCAN,
    });
    const charge = await safeReadChargeEntries(this.deps.chargeLedger ?? null, {
      limit: MAX_SOURCE_SCAN,
    });
    return { gardenEntries, gateway, charge };
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

function toAuditHistoryListEntry(
  entry: AdminAuditHistoryEntry,
  scopeId: string,
  opaqueIdKey: string,
): AdminAuditHistoryListEntry {
  return {
    id: toOpaqueAuditEntryId(entry, scopeId, opaqueIdKey),
    timestamp: entry.timestamp,
    source: entry.source,
    actionType: entry.actionType,
    decision: entry.decision,
    narrative: entry.narrative,
    ...(entry.details ? { details: entry.details } : {}),
    ...(entry.actor ? { actor: entry.actor } : {}),
  };
}

function toOpaqueAuditEntryId(
  entry: AdminAuditHistoryEntry,
  scopeId: string,
  opaqueIdKey: string,
): string {
  const sourceIdentity = entry.sourceRecordId ?? entry.id;
  const digest = createHmac('sha256', opaqueIdKey)
    .update(AUDIT_OPAQUE_ID_CONTEXT)
    .update('\0')
    .update(scopeId)
    .update('\0')
    .update(entry.source)
    .update('\0')
    .update(sourceIdentity)
    .digest('base64url');
  return `audit_${digest}`;
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
  } catch {
    return {
      available: false,
      entries: [],
      message: 'Gateway audit history could not be read.',
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
    entry.error ? 'error=present' : null,
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

function stringDetail(details: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = details?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
