import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { EventBus } from '../event-bus.js';
import { appendJsonLine } from '../../persistence/jsonl.js';
import type { RunChargeEvent } from '../contracts/runtime.js';
import type {
  ChargePolicyRuntimeLane,
  ChargePolicySurface,
} from '../../system/config/charge-policy-config.js';

export interface RunChargeLedgerMetadata {
  provider?: string;
  model?: string;
  modality?: string;
  referenceModelClass?: string;
  shardId?: string;
  subagentId?: string;
}

export interface RunChargeLedgerEntry {
  schemaVersion: 1;
  recordType: 'charge_event';
  eventId: string;
  recordedAtMs: number;
  event: RunChargeEvent;
  metadata?: RunChargeLedgerMetadata;
}

export interface RunChargeLedgerQuery {
  limit?: number;
  sinceMs?: number;
  untilMs?: number;
  runId?: string;
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
  spentByLane: Partial<Record<ChargePolicyRuntimeLane, number>>;
  spentBySurface: Partial<Record<ChargePolicySurface, number>>;
  lineageDepth: number;
  shardIds: string[];
  subagentIds: string[];
  models: string[];
  lastQuotaByLane: Partial<Record<ChargePolicyRuntimeLane, number>>;
  lastSpentAfterByLane: Partial<Record<ChargePolicyRuntimeLane, number>>;
  lastRemainingAfterByLane: Partial<Record<ChargePolicyRuntimeLane, number>>;
}

export interface RunChargeLedgerAggregates {
  amount: number;
  eventCount: number;
  byLane: RunChargeBreakdown[];
  bySurface: RunChargeBreakdown[];
  byLineage: RunChargeBreakdown[];
}

export interface RunChargeLedgerData {
  activeRun: RunChargeRunSummary | null;
  recentRuns: RunChargeRunSummary[];
  aggregates: RunChargeLedgerAggregates;
  events: RunChargeLedgerEntry[];
}

interface MutableRunSummary {
  runId: string;
  rootRunId: string;
  parentRunId?: string;
  startedAtMs: number;
  updatedAtMs: number;
  eventCount: number;
  amount: number;
  spentByLane: Partial<Record<ChargePolicyRuntimeLane, number>>;
  spentBySurface: Partial<Record<ChargePolicySurface, number>>;
  lineageDepth: number;
  shardIds: Set<string>;
  subagentIds: Set<string>;
  models: Set<string>;
  lastQuotaByLane: Partial<Record<ChargePolicyRuntimeLane, number>>;
  lastSpentAfterByLane: Partial<Record<ChargePolicyRuntimeLane, number>>;
  lastRemainingAfterByLane: Partial<Record<ChargePolicyRuntimeLane, number>>;
}

const DEFAULT_EVENT_LIMIT = 200;
const MAX_EVENT_LIMIT = 2_000;
const DEFAULT_RECENT_RUN_LIMIT = 24;

function normalizePositiveFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function normalizeLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return DEFAULT_EVENT_LIMIT;
  }
  return Math.min(MAX_EVENT_LIMIT, Math.trunc(value));
}

function addBreakdown(
  target: Map<string, RunChargeBreakdown>,
  key: string,
  amount: number,
): void {
  const existing = target.get(key);
  if (existing) {
    existing.amount += amount;
    existing.eventCount += 1;
    return;
  }
  target.set(key, { key, amount, eventCount: 1 });
}

function addRecordAmount<T extends string>(
  target: Partial<Record<T, number>>,
  key: T,
  amount: number,
): void {
  target[key] = (target[key] ?? 0) + amount;
}

function sortedBreakdowns(map: Map<string, RunChargeBreakdown>): RunChargeBreakdown[] {
  return [...map.values()].sort((left, right) => {
    if (right.amount !== left.amount) return right.amount - left.amount;
    return left.key.localeCompare(right.key);
  });
}

function readMetadataString(details: Record<string, unknown> | undefined, key: string): string | undefined {
  return normalizeOptionalString(details?.[key]);
}

function extractMetadata(event: RunChargeEvent): RunChargeLedgerMetadata | undefined {
  const details = event.details;
  const metadata: RunChargeLedgerMetadata = {};
  const provider = readMetadataString(details, 'provider');
  const model = readMetadataString(details, 'model');
  const modality = readMetadataString(details, 'modality')
    ?? (event.surface === 'paidImageGeneration' ? 'image' : undefined);
  const referenceModelClass = readMetadataString(details, 'referenceModelClass');
  const shardId = readMetadataString(details, 'shardId');
  const subagentId = readMetadataString(details, 'subagentId');

  if (provider) metadata.provider = provider;
  if (model) metadata.model = model;
  if (modality) metadata.modality = modality;
  if (referenceModelClass) metadata.referenceModelClass = referenceModelClass;
  if (shardId) metadata.shardId = shardId;
  if (subagentId) metadata.subagentId = subagentId;

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function cloneChargeEvent(event: RunChargeEvent): RunChargeEvent {
  return {
    ...event,
    lineage: { ...event.lineage },
    ...(event.details ? { details: { ...event.details } } : {}),
  };
}

function createLedgerEntry(event: RunChargeEvent): RunChargeLedgerEntry {
  const clonedEvent = cloneChargeEvent(event);
  const metadata = extractMetadata(clonedEvent);
  return {
    schemaVersion: 1,
    recordType: 'charge_event',
    eventId: randomUUID(),
    recordedAtMs: Date.now(),
    event: clonedEvent,
    ...(metadata ? { metadata } : {}),
  };
}

function assertLedgerEntry(value: unknown, lineNumber: number): asserts value is RunChargeLedgerEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid charge ledger entry at line ${lineNumber}: expected object`);
  }
  const entry = value as Partial<RunChargeLedgerEntry>;
  if (entry.schemaVersion !== 1 || entry.recordType !== 'charge_event') {
    throw new Error(`Invalid charge ledger entry at line ${lineNumber}: unsupported schema`);
  }
  if (!normalizeOptionalString(entry.eventId)) {
    throw new Error(`Invalid charge ledger entry at line ${lineNumber}: missing eventId`);
  }
  if (normalizePositiveFiniteNumber(entry.recordedAtMs) === undefined) {
    throw new Error(`Invalid charge ledger entry at line ${lineNumber}: missing recordedAtMs`);
  }
  const event = entry.event;
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new Error(`Invalid charge ledger entry at line ${lineNumber}: missing event`);
  }
  if (normalizePositiveFiniteNumber(event.timestampMs) === undefined) {
    throw new Error(`Invalid charge ledger entry at line ${lineNumber}: missing event timestamp`);
  }
  if (normalizePositiveFiniteNumber(event.amount) === undefined) {
    throw new Error(`Invalid charge ledger entry at line ${lineNumber}: missing event amount`);
  }
  const eventLineage = (event as { lineage?: { runId?: unknown; rootRunId?: unknown } }).lineage;
  if (!eventLineage || !normalizeOptionalString(eventLineage.runId) || !normalizeOptionalString(eventLineage.rootRunId)) {
    throw new Error(`Invalid charge ledger entry at line ${lineNumber}: missing lineage`);
  }
}

function readLedgerEntries(path: string): RunChargeLedgerEntry[] {
  if (!existsSync(path)) {
    return [];
  }
  const raw = readFileSync(path, 'utf-8');
  if (raw.trim().length === 0) {
    return [];
  }
  return raw.split('\n')
    .filter(line => line.trim().length > 0)
    .map((line, index) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid charge ledger JSON at line ${index + 1}: ${String(error)}`);
      }
      assertLedgerEntry(parsed, index + 1);
      return parsed;
    });
}

function matchesQuery(entry: RunChargeLedgerEntry, query: RunChargeLedgerQuery): boolean {
  const timestamp = entry.event.timestampMs;
  if (query.sinceMs !== undefined && timestamp < query.sinceMs) return false;
  if (query.untilMs !== undefined && timestamp > query.untilMs) return false;
  if (query.runId) {
    const lineage = entry.event.lineage;
    return lineage.runId === query.runId
      || lineage.rootRunId === query.runId
      || lineage.parentRunId === query.runId;
  }
  return true;
}

function resolveLineageDepth(entry: RunChargeLedgerEntry): number {
  const lineage = entry.event.lineage;
  if (lineage.parentRunId) return 2;
  return lineage.rootRunId === lineage.runId ? 1 : 2;
}

function getOrCreateRunSummary(
  summaries: Map<string, MutableRunSummary>,
  entry: RunChargeLedgerEntry,
): MutableRunSummary {
  const { lineage } = entry.event;
  const existing = summaries.get(lineage.runId);
  if (existing) {
    return existing;
  }
  const summary: MutableRunSummary = {
    runId: lineage.runId,
    rootRunId: lineage.rootRunId,
    ...(lineage.parentRunId ? { parentRunId: lineage.parentRunId } : {}),
    startedAtMs: entry.event.timestampMs,
    updatedAtMs: entry.event.timestampMs,
    eventCount: 0,
    amount: 0,
    spentByLane: {},
    spentBySurface: {},
    lineageDepth: resolveLineageDepth(entry),
    shardIds: new Set(),
    subagentIds: new Set(),
    models: new Set(),
    lastQuotaByLane: {},
    lastSpentAfterByLane: {},
    lastRemainingAfterByLane: {},
  };
  summaries.set(lineage.runId, summary);
  return summary;
}

function addEntryToRunSummary(summary: MutableRunSummary, entry: RunChargeLedgerEntry): void {
  const event = entry.event;
  summary.startedAtMs = Math.min(summary.startedAtMs, event.timestampMs);
  summary.updatedAtMs = Math.max(summary.updatedAtMs, event.timestampMs);
  summary.eventCount += 1;
  summary.amount += event.amount;
  summary.lineageDepth = Math.max(summary.lineageDepth, resolveLineageDepth(entry));
  addRecordAmount(summary.spentByLane, event.lane, event.amount);
  addRecordAmount(summary.spentBySurface, event.surface, event.amount);
  summary.lastQuotaByLane[event.lane] = event.quota;
  summary.lastSpentAfterByLane[event.lane] = event.spentAfter;
  summary.lastRemainingAfterByLane[event.lane] = event.remainingAfter;
  if (entry.metadata?.shardId) summary.shardIds.add(entry.metadata.shardId);
  if (entry.metadata?.subagentId) summary.subagentIds.add(entry.metadata.subagentId);
  if (entry.metadata?.model) summary.models.add(entry.metadata.model);
}

function finalizeRunSummary(summary: MutableRunSummary): RunChargeRunSummary {
  return {
    runId: summary.runId,
    rootRunId: summary.rootRunId,
    ...(summary.parentRunId ? { parentRunId: summary.parentRunId } : {}),
    startedAtMs: summary.startedAtMs,
    updatedAtMs: summary.updatedAtMs,
    eventCount: summary.eventCount,
    amount: summary.amount,
    spentByLane: { ...summary.spentByLane },
    spentBySurface: { ...summary.spentBySurface },
    lineageDepth: summary.lineageDepth,
    shardIds: [...summary.shardIds].sort(),
    subagentIds: [...summary.subagentIds].sort(),
    models: [...summary.models].sort(),
    lastQuotaByLane: { ...summary.lastQuotaByLane },
    lastSpentAfterByLane: { ...summary.lastSpentAfterByLane },
    lastRemainingAfterByLane: { ...summary.lastRemainingAfterByLane },
  };
}

function summarizeEntries(entries: RunChargeLedgerEntry[]): {
  aggregates: RunChargeLedgerAggregates;
  runs: RunChargeRunSummary[];
} {
  const byLane = new Map<string, RunChargeBreakdown>();
  const bySurface = new Map<string, RunChargeBreakdown>();
  const byLineage = new Map<string, RunChargeBreakdown>();
  const runSummaries = new Map<string, MutableRunSummary>();
  let amount = 0;

  for (const entry of entries) {
    const event = entry.event;
    amount += event.amount;
    addBreakdown(byLane, event.lane, event.amount);
    addBreakdown(bySurface, event.surface, event.amount);
    addBreakdown(byLineage, event.lineage.runId, event.amount);
    addEntryToRunSummary(getOrCreateRunSummary(runSummaries, entry), entry);
  }

  const runs = [...runSummaries.values()]
    .map(finalizeRunSummary)
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs);

  return {
    aggregates: {
      amount,
      eventCount: entries.length,
      byLane: sortedBreakdowns(byLane),
      bySurface: sortedBreakdowns(bySurface),
      byLineage: sortedBreakdowns(byLineage),
    },
    runs,
  };
}

export class RunChargeLedger {
  private entries: RunChargeLedgerEntry[];
  private unsubscribe?: () => void;

  constructor(private readonly path: string, eventBus?: Pick<EventBus, 'on'> | null) {
    this.entries = readLedgerEntries(path);
    if (eventBus) {
      this.unsubscribe = eventBus.on('agent.charge', (event) => {
        this.recordChargeEvent(event);
      });
    }
  }

  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  recordChargeEvent(event: RunChargeEvent): RunChargeLedgerEntry {
    const entry = createLedgerEntry(event);
    appendJsonLine(this.path, entry);
    this.entries.push(entry);
    return entry;
  }

  listEntries(query: RunChargeLedgerQuery = {}): RunChargeLedgerEntry[] {
    const limit = normalizeLimit(query.limit);
    return this.entries
      .filter(entry => matchesQuery(entry, query))
      .sort((left, right) => right.event.timestampMs - left.event.timestampMs)
      .slice(0, limit)
      .map(entry => ({
        ...entry,
        event: cloneChargeEvent(entry.event),
        ...(entry.metadata ? { metadata: { ...entry.metadata } } : {}),
      }));
  }

  getData(query: RunChargeLedgerQuery = {}): RunChargeLedgerData {
    const allMatchingEntries = this.entries
      .filter(entry => matchesQuery(entry, query))
      .sort((left, right) => right.event.timestampMs - left.event.timestampMs);
    const { aggregates, runs } = summarizeEntries(allMatchingEntries);
    const limit = normalizeLimit(query.limit);
    return {
      activeRun: runs[0] ?? null,
      recentRuns: runs.slice(0, DEFAULT_RECENT_RUN_LIMIT),
      aggregates,
      events: allMatchingEntries.slice(0, limit).map(entry => ({
        ...entry,
        event: cloneChargeEvent(entry.event),
        ...(entry.metadata ? { metadata: { ...entry.metadata } } : {}),
      })),
    };
  }
}
