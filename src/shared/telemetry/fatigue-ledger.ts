import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { EventBus } from '../event-bus.js';
import { appendJsonLine } from '../../persistence/jsonl.js';
import type {
  FatigueBudgetDecision,
  FatigueBudgetEvent,
  FatigueBudgetHardState,
  FatigueBudgetSoftState,
  FatigueTriggeringAuthorRole,
} from '../contracts/runtime.js';

export interface FatigueLedgerEntry {
  schemaVersion: 1;
  recordType: 'fatigue_event';
  eventId: string;
  recordedAtMs: number;
  event: FatigueBudgetEvent;
}

export interface FatigueLedgerQuery {
  limit?: number;
  sinceMs?: number;
  untilMs?: number;
  localCompanionId?: string;
  peerContactId?: string;
  channelId?: string;
  dayKey?: string;
  decision?: FatigueBudgetDecision;
  runId?: string;
}

export interface FatigueLedgerBreakdown {
  key: string;
  amount: number;
  eventCount: number;
}

export interface FatigueLedgerScopeSummary {
  localCompanionId: string;
  peerContactId: string;
  channelId: string;
  dayKey: string;
  amount: number;
  eventCount: number;
  chargedEventCount: number;
  overchargeEventCount: number;
  freeEventCount: number;
  lastEvent?: FatigueBudgetEvent;
}

export interface FatigueLedgerAggregates {
  amount: number;
  eventCount: number;
  byChannel: FatigueLedgerBreakdown[];
  byPeer: FatigueLedgerBreakdown[];
  byDay: FatigueLedgerBreakdown[];
  byDecision: FatigueLedgerBreakdown[];
  scopes: FatigueLedgerScopeSummary[];
}

export interface FatigueLedgerData {
  aggregates: FatigueLedgerAggregates;
  events: FatigueLedgerEntry[];
}

export interface FatigueLedgerOptions {
  now?: () => number;
}

interface MutableScopeSummary {
  localCompanionId: string;
  peerContactId: string;
  channelId: string;
  dayKey: string;
  amount: number;
  eventCount: number;
  chargedEventCount: number;
  overchargeEventCount: number;
  freeEventCount: number;
  lastEvent?: FatigueBudgetEvent;
}

const DEFAULT_EVENT_LIMIT = 200;
const MAX_EVENT_LIMIT = 2_000;

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function normalizeFiniteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function normalizeLimit(value: number | undefined, defaultLimit?: number): number | undefined {
  if (value === undefined) {
    return defaultLimit;
  }
  if (!Number.isFinite(value) || value < 1) {
    return defaultLimit;
  }
  return Math.min(MAX_EVENT_LIMIT, Math.trunc(value));
}

function assertRole(value: unknown, lineNumber: number): asserts value is FatigueTriggeringAuthorRole {
  if (value !== 'human' && value !== 'machine_intelligence' && value !== 'system' && value !== 'unknown') {
    throw new Error(`Invalid fatigue ledger entry at line ${lineNumber}: invalid triggering author role`);
  }
}

function assertDecision(value: unknown, lineNumber: number): asserts value is FatigueBudgetDecision {
  if (value !== 'charged' && value !== 'free' && value !== 'overcharge') {
    throw new Error(`Invalid fatigue ledger entry at line ${lineNumber}: invalid decision`);
  }
}

function assertSoftState(value: unknown, lineNumber: number): asserts value is FatigueBudgetSoftState {
  if (value !== 'clear' && value !== 'soft_limit_reached') {
    throw new Error(`Invalid fatigue ledger entry at line ${lineNumber}: invalid soft state`);
  }
}

function assertHardState(value: unknown, lineNumber: number): asserts value is FatigueBudgetHardState {
  if (value !== 'available' && value !== 'exhausted') {
    throw new Error(`Invalid fatigue ledger entry at line ${lineNumber}: invalid hard state`);
  }
}

function cloneFatigueEvent(event: FatigueBudgetEvent): FatigueBudgetEvent {
  return {
    ...event,
    triggeringAuthor: { ...event.triggeringAuthor },
    peer: { ...event.peer },
    ...(event.lineage ? { lineage: { ...event.lineage } } : {}),
    ...(event.details ? { details: { ...event.details } } : {}),
  };
}

function createLedgerEntry(event: FatigueBudgetEvent, recordedAtMs: number): FatigueLedgerEntry {
  return {
    schemaVersion: 1,
    recordType: 'fatigue_event',
    eventId: randomUUID(),
    recordedAtMs,
    event: cloneFatigueEvent(event),
  };
}

function assertLedgerEntry(value: unknown, lineNumber: number): asserts value is FatigueLedgerEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid fatigue ledger entry at line ${lineNumber}: expected object`);
  }
  const entry = value as Partial<FatigueLedgerEntry>;
  if (entry.schemaVersion !== 1 || entry.recordType !== 'fatigue_event') {
    throw new Error(`Invalid fatigue ledger entry at line ${lineNumber}: unsupported schema`);
  }
  if (!normalizeOptionalString(entry.eventId)) {
    throw new Error(`Invalid fatigue ledger entry at line ${lineNumber}: missing eventId`);
  }
  if (normalizeFiniteNonNegativeNumber(entry.recordedAtMs) === undefined) {
    throw new Error(`Invalid fatigue ledger entry at line ${lineNumber}: missing recordedAtMs`);
  }
  const event = entry.event;
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new Error(`Invalid fatigue ledger entry at line ${lineNumber}: missing event`);
  }
  const partialEvent = event as Partial<FatigueBudgetEvent>;
  if (normalizeFiniteNonNegativeNumber(partialEvent.timestampMs) === undefined) {
    throw new Error(`Invalid fatigue ledger entry at line ${lineNumber}: missing event timestamp`);
  }
  if (!normalizeOptionalString(partialEvent.dayKey)) {
    throw new Error(`Invalid fatigue ledger entry at line ${lineNumber}: missing dayKey`);
  }
  if (!normalizeOptionalString(partialEvent.localCompanionId)) {
    throw new Error(`Invalid fatigue ledger entry at line ${lineNumber}: missing localCompanionId`);
  }
  if (!normalizeOptionalString(partialEvent.peerContactId)) {
    throw new Error(`Invalid fatigue ledger entry at line ${lineNumber}: missing peerContactId`);
  }
  if (!normalizeOptionalString(partialEvent.channelId)) {
    throw new Error(`Invalid fatigue ledger entry at line ${lineNumber}: missing channelId`);
  }
  if (!partialEvent.triggeringAuthor || typeof partialEvent.triggeringAuthor !== 'object') {
    throw new Error(`Invalid fatigue ledger entry at line ${lineNumber}: missing triggeringAuthor`);
  }
  assertRole(partialEvent.triggeringAuthor.role, lineNumber);
  if (!partialEvent.peer || typeof partialEvent.peer !== 'object' || !normalizeOptionalString(partialEvent.peer.contactId)) {
    throw new Error(`Invalid fatigue ledger entry at line ${lineNumber}: missing peer contact`);
  }
  if (normalizeFiniteNonNegativeNumber(partialEvent.amount) === undefined) {
    throw new Error(`Invalid fatigue ledger entry at line ${lineNumber}: missing amount`);
  }
  assertDecision(partialEvent.decision, lineNumber);
  if (partialEvent.reason !== 'machine_intelligence_response'
    && partialEvent.reason !== 'overcharge_recent_human_participation'
    && partialEvent.reason !== 'overcharge_work_intent_wrapup'
    && partialEvent.reason !== 'peer_not_machine_intelligence'
    && partialEvent.reason !== 'triggering_author_not_machine_intelligence') {
    throw new Error(`Invalid fatigue ledger entry at line ${lineNumber}: invalid reason`);
  }
  if (normalizeFiniteNonNegativeNumber(partialEvent.spentAfter) === undefined) {
    throw new Error(`Invalid fatigue ledger entry at line ${lineNumber}: missing spentAfter`);
  }
  if (normalizeFiniteNonNegativeNumber(partialEvent.remainingAllowance) === undefined) {
    throw new Error(`Invalid fatigue ledger entry at line ${lineNumber}: missing remainingAllowance`);
  }
  if (normalizeFiniteNonNegativeNumber(partialEvent.allowance) === undefined) {
    throw new Error(`Invalid fatigue ledger entry at line ${lineNumber}: missing allowance`);
  }
  if (normalizeFiniteNonNegativeNumber(partialEvent.softLimit) === undefined) {
    throw new Error(`Invalid fatigue ledger entry at line ${lineNumber}: missing softLimit`);
  }
  assertSoftState(partialEvent.softState, lineNumber);
  assertHardState(partialEvent.hardState, lineNumber);
}

function readLedgerEntries(path: string): FatigueLedgerEntry[] {
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
        throw new Error(`Invalid fatigue ledger JSON at line ${index + 1}: ${String(error)}`);
      }
      assertLedgerEntry(parsed, index + 1);
      return parsed;
    });
}

function matchesQuery(entry: FatigueLedgerEntry, query: FatigueLedgerQuery): boolean {
  const event = entry.event;
  if (query.sinceMs !== undefined && event.timestampMs < query.sinceMs) return false;
  if (query.untilMs !== undefined && event.timestampMs > query.untilMs) return false;
  if (query.localCompanionId && event.localCompanionId !== query.localCompanionId) return false;
  if (query.peerContactId && event.peerContactId !== query.peerContactId) return false;
  if (query.channelId && event.channelId !== query.channelId) return false;
  if (query.dayKey && event.dayKey !== query.dayKey) return false;
  if (query.decision && event.decision !== query.decision) return false;
  if (query.runId) {
    const lineage = event.lineage;
    if (!lineage) return false;
    return lineage.runId === query.runId
      || lineage.rootRunId === query.runId
      || lineage.parentRunId === query.runId;
  }
  return true;
}

function addBreakdown(
  target: Map<string, FatigueLedgerBreakdown>,
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

function sortedBreakdowns(map: Map<string, FatigueLedgerBreakdown>): FatigueLedgerBreakdown[] {
  return [...map.values()].sort((left, right) => {
    if (right.amount !== left.amount) return right.amount - left.amount;
    return left.key.localeCompare(right.key);
  });
}

function makeScopeKey(event: FatigueBudgetEvent): string {
  return JSON.stringify([
    event.localCompanionId,
    event.peerContactId,
    event.channelId,
    event.dayKey,
  ]);
}

function addScopeSummary(
  target: Map<string, MutableScopeSummary>,
  event: FatigueBudgetEvent,
): void {
  const key = makeScopeKey(event);
  let summary = target.get(key);
  if (!summary) {
    summary = {
      localCompanionId: event.localCompanionId,
      peerContactId: event.peerContactId,
      channelId: event.channelId,
      dayKey: event.dayKey,
      amount: 0,
      eventCount: 0,
      chargedEventCount: 0,
      overchargeEventCount: 0,
      freeEventCount: 0,
    };
    target.set(key, summary);
  }
  summary.amount += event.amount;
  summary.eventCount += 1;
  if (event.decision === 'charged') {
    summary.chargedEventCount += 1;
  } else if (event.decision === 'overcharge') {
    summary.overchargeEventCount += 1;
  } else {
    summary.freeEventCount += 1;
  }
  if (!summary.lastEvent || event.timestampMs >= summary.lastEvent.timestampMs) {
    summary.lastEvent = cloneFatigueEvent(event);
  }
}

function summarizeEntries(entries: readonly FatigueLedgerEntry[]): FatigueLedgerAggregates {
  const byChannel = new Map<string, FatigueLedgerBreakdown>();
  const byPeer = new Map<string, FatigueLedgerBreakdown>();
  const byDay = new Map<string, FatigueLedgerBreakdown>();
  const byDecision = new Map<string, FatigueLedgerBreakdown>();
  const scopes = new Map<string, MutableScopeSummary>();
  let amount = 0;

  for (const entry of entries) {
    const event = entry.event;
    amount += event.amount;
    addBreakdown(byChannel, event.channelId, event.amount);
    addBreakdown(byPeer, event.peerContactId, event.amount);
    addBreakdown(byDay, event.dayKey, event.amount);
    addBreakdown(byDecision, event.decision, event.amount);
    addScopeSummary(scopes, event);
  }

  return {
    amount,
    eventCount: entries.length,
    byChannel: sortedBreakdowns(byChannel),
    byPeer: sortedBreakdowns(byPeer),
    byDay: sortedBreakdowns(byDay),
    byDecision: sortedBreakdowns(byDecision),
    scopes: [...scopes.values()]
      .sort((left, right) => {
        if (right.dayKey !== left.dayKey) return right.dayKey.localeCompare(left.dayKey);
        if (right.amount !== left.amount) return right.amount - left.amount;
        return `${left.localCompanionId}:${left.peerContactId}:${left.channelId}`
          .localeCompare(`${right.localCompanionId}:${right.peerContactId}:${right.channelId}`);
      })
      .map(summary => ({
        ...summary,
        ...(summary.lastEvent ? { lastEvent: cloneFatigueEvent(summary.lastEvent) } : {}),
      })),
  };
}

export class FatigueLedger {
  private entries: FatigueLedgerEntry[];
  private unsubscribe?: () => void;
  private readonly now: () => number;

  constructor(
    private readonly path: string,
    eventBus?: Pick<EventBus, 'on'> | null,
    options: FatigueLedgerOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.entries = readLedgerEntries(path);
    if (eventBus) {
      this.unsubscribe = eventBus.on('agent.fatigue', (event) => {
        this.recordFatigueEvent(event);
      });
    }
  }

  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  recordFatigueEvent(event: FatigueBudgetEvent): FatigueLedgerEntry {
    const entry = createLedgerEntry(event, this.now());
    appendJsonLine(this.path, entry);
    this.entries.push(entry);
    return {
      ...entry,
      event: cloneFatigueEvent(entry.event),
    };
  }

  listFatigueEvents(query: FatigueLedgerQuery = {}): FatigueBudgetEvent[] {
    const limit = normalizeLimit(query.limit);
    const events = this.entries
      .filter(entry => matchesQuery(entry, query))
      .sort((left, right) => right.event.timestampMs - left.event.timestampMs)
      .map(entry => cloneFatigueEvent(entry.event));
    return limit === undefined ? events : events.slice(0, limit);
  }

  listEntries(query: FatigueLedgerQuery = {}): FatigueLedgerEntry[] {
    const limit = normalizeLimit(query.limit, DEFAULT_EVENT_LIMIT);
    return this.entries
      .filter(entry => matchesQuery(entry, query))
      .sort((left, right) => right.event.timestampMs - left.event.timestampMs)
      .slice(0, limit)
      .map(entry => ({
        ...entry,
        event: cloneFatigueEvent(entry.event),
      }));
  }

  getData(query: FatigueLedgerQuery = {}): FatigueLedgerData {
    const allMatchingEntries = this.entries
      .filter(entry => matchesQuery(entry, query))
      .sort((left, right) => right.event.timestampMs - left.event.timestampMs);
    const limit = normalizeLimit(query.limit, DEFAULT_EVENT_LIMIT);
    return {
      aggregates: summarizeEntries(allMatchingEntries),
      events: allMatchingEntries.slice(0, limit).map(entry => ({
        ...entry,
        event: cloneFatigueEvent(entry.event),
      })),
    };
  }
}
