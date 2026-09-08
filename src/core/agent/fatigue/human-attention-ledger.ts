import { randomUUID } from 'node:crypto';
import {
  appendJsonLine,
  resolveJsonLinesReadLimits,
  streamJsonLines,
  streamJsonLinesSync,
  type JsonLinesReadLimitSettings,
  type JsonLinesReadLimits,
} from '../../../persistence/jsonl.js';
import type { EventBus } from '../../../shared/event-bus.js';
import { assertNoUnknownKeys } from '../../../shared/utils/types.js';
import type {
  HumanAttentionPressureDecision,
  HumanAttentionPressureEvent,
  HumanAttentionPressureStore,
} from './human-attention-pressure.js';

export interface HumanAttentionPressureLedgerEntry {
  schemaVersion: 1;
  recordType: 'human_attention_pressure_event';
  eventId: string;
  recordedAtMs: number;
  event: HumanAttentionPressureEvent;
}

export interface HumanAttentionPressureLedgerBreakdown {
  key: string;
  eventCount: number;
}

export interface HumanAttentionPressureLedgerData {
  aggregates: {
    eventCount: number;
    boundaryAlertCount: number;
    byDecision: HumanAttentionPressureLedgerBreakdown[];
    byContact: HumanAttentionPressureLedgerBreakdown[];
    byChannel: HumanAttentionPressureLedgerBreakdown[];
  };
  events: HumanAttentionPressureLedgerEntry[];
}

const HUMAN_ATTENTION_EVENT_KEYS = [
  'schemaVersion',
  'timestampMs',
  'localCompanionId',
  'contactId',
  'channelId',
  'trustLevel',
  'relationshipType',
  'channelContext',
  'weight',
  'pressureInWindow',
  'threshold',
  'decision',
  'reason',
  'suppressTurn',
  'sourceMessageId',
  'turnId',
  'cooldownUntilMs',
] as const;

const HUMAN_ATTENTION_ENTRY_KEYS = [
  'schemaVersion',
  'recordType',
  'eventId',
  'recordedAtMs',
  'event',
] as const;

function cloneEvent(event: HumanAttentionPressureEvent): HumanAttentionPressureEvent {
  return {
    schemaVersion: 1,
    timestampMs: event.timestampMs,
    localCompanionId: event.localCompanionId,
    contactId: event.contactId,
    channelId: event.channelId,
    trustLevel: event.trustLevel,
    relationshipType: event.relationshipType,
    channelContext: event.channelContext,
    weight: event.weight,
    pressureInWindow: event.pressureInWindow,
    threshold: event.threshold,
    decision: event.decision,
    reason: event.reason,
    suppressTurn: false,
    sourceMessageId: event.sourceMessageId,
    turnId: event.turnId,
    ...(event.cooldownUntilMs !== undefined
      ? { cooldownUntilMs: event.cooldownUntilMs }
      : {}),
  };
}

function assertEvent(value: unknown, lineNumber: number): asserts value is HumanAttentionPressureEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid human attention ledger entry at line ${lineNumber}: missing event`);
  }
  assertNoUnknownKeys(value as Record<string, unknown>, HUMAN_ATTENTION_EVENT_KEYS, 'event', {
    errorPrefix: `Invalid human attention ledger entry at line ${lineNumber}`,
  });
  const event = value as Partial<HumanAttentionPressureEvent>;
  if (
    event.schemaVersion !== 1
    || typeof event.timestampMs !== 'number'
    || !Number.isFinite(event.timestampMs)
    || typeof event.localCompanionId !== 'string'
    || !event.localCompanionId.trim()
    || typeof event.contactId !== 'string'
    || !event.contactId.trim()
    || typeof event.channelId !== 'string'
    || !event.channelId.trim()
    || !['public', 'regular', 'trusted', 'primary'].includes(event.trustLevel ?? '')
    || !['stranger', 'acquaintance', 'friend', 'family', 'partner', 'ai_companion']
      .includes(event.relationshipType ?? '')
    || !['direct_message', 'direct_mention', 'ambient_group_message']
      .includes(event.channelContext ?? '')
    || typeof event.weight !== 'number'
    || !Number.isFinite(event.weight)
    || event.weight < 0
    || typeof event.pressureInWindow !== 'number'
    || !Number.isFinite(event.pressureInWindow)
    || event.pressureInWindow < 0
    || typeof event.threshold !== 'number'
    || !Number.isFinite(event.threshold)
    || event.threshold <= 0
    || !['clear', 'boundary_alert', 'cooldown'].includes(event.decision ?? '')
    || ![
      'below_threshold',
      'threshold_reached',
      'boundary_cooldown_active',
      'policy_disabled',
    ].includes(event.reason ?? '')
    || event.suppressTurn !== false
    || typeof event.sourceMessageId !== 'string'
    || !event.sourceMessageId.trim()
    || typeof event.turnId !== 'string'
    || !event.turnId.trim()
    || (
      event.cooldownUntilMs !== undefined
      && (typeof event.cooldownUntilMs !== 'number' || !Number.isFinite(event.cooldownUntilMs))
    )
  ) {
    throw new Error(`Invalid human attention ledger entry at line ${lineNumber}: malformed event`);
  }
}

function assertEntry(
  value: unknown,
  lineNumber: number,
): asserts value is HumanAttentionPressureLedgerEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid human attention ledger entry at line ${lineNumber}: expected object`);
  }
  assertNoUnknownKeys(value as Record<string, unknown>, HUMAN_ATTENTION_ENTRY_KEYS, 'entry', {
    errorPrefix: `Invalid human attention ledger entry at line ${lineNumber}`,
  });
  const entry = value as Partial<HumanAttentionPressureLedgerEntry>;
  if (
    entry.schemaVersion !== 1
    || entry.recordType !== 'human_attention_pressure_event'
    || typeof entry.eventId !== 'string'
    || !entry.eventId.trim()
    || typeof entry.recordedAtMs !== 'number'
    || !Number.isFinite(entry.recordedAtMs)
  ) {
    throw new Error(`Invalid human attention ledger entry at line ${lineNumber}: unsupported schema`);
  }
  assertEvent(entry.event, lineNumber);
}

/**
 * Bounded append-only hydration (psfn-framework-z3e2x): one physical row is
 * retained at a time instead of a whole-file string plus a whole-file row
 * array. Malformed rows still fail closed.
 */
function visitEntryRows(collect: (entry: HumanAttentionPressureLedgerEntry) => void) {
  return (parsed: unknown, context: { line: number }): void => {
    assertEntry(parsed, context.line);
    collect(parsed);
  };
}

function attentionLedgerParseError(path: string) {
  return (context: { line: number; error: unknown }): never => {
    throw new Error(
      `Invalid human attention ledger JSON at line ${context.line} of ${path}: `
      + String(context.error),
    );
  };
}

function readEntriesSync(
  path: string,
  limits: JsonLinesReadLimits,
): HumanAttentionPressureLedgerEntry[] {
  const entries: HumanAttentionPressureLedgerEntry[] = [];
  streamJsonLinesSync(path, limits, visitEntryRows(entry => entries.push(entry)), {
    onParseError: attentionLedgerParseError(path),
  });
  return entries;
}

async function readEntriesStreaming(
  path: string,
  limits: JsonLinesReadLimits,
): Promise<HumanAttentionPressureLedgerEntry[]> {
  const entries: HumanAttentionPressureLedgerEntry[] = [];
  await streamJsonLines(path, limits, visitEntryRows(entry => entries.push(entry)), {
    onParseError: attentionLedgerParseError(path),
  });
  return entries;
}

function countBy(
  events: readonly HumanAttentionPressureEvent[],
  selectKey: (event: HumanAttentionPressureEvent) => string,
): HumanAttentionPressureLedgerBreakdown[] {
  const counts = new Map<string, number>();
  for (const event of events) {
    const key = selectKey(event);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, eventCount]) => ({ key, eventCount }))
    .sort((left, right) => (
      right.eventCount - left.eventCount || left.key.localeCompare(right.key)
    ));
}

export interface HumanAttentionPressureLedgerOptions {
  /** Owner-file bounded-read budgets (settings.json ledgerRead* keys). */
  readLimitSettings?: JsonLinesReadLimitSettings | null;
  /** Internal: entries already streamed by {@link HumanAttentionPressureLedger.open}. */
  hydratedEntries?: HumanAttentionPressureLedgerEntry[];
}

export class HumanAttentionPressureLedger implements HumanAttentionPressureStore {
  /**
   * Cooperative startup hydration: streams the append-only ledger with explicit
   * event-loop yields so Garden/admin work keeps advancing on a multi-megabyte
   * ledger (psfn-framework-z3e2x).
   */
  static async open(
    path: string,
    eventBus: EventBus | null = null,
    now: () => number = Date.now,
    options: HumanAttentionPressureLedgerOptions = {},
  ): Promise<HumanAttentionPressureLedger> {
    // Buffer pressure events across the hydration await and replay them once the
    // ledger owns its own subscription, so cooperative hydration cannot drop an
    // event the synchronous constructor would have captured.
    const pending: HumanAttentionPressureEvent[] = [];
    const detachBuffer = eventBus?.on('agent.human_attention_pressure', (event) => {
      pending.push(event);
    }) ?? null;
    try {
      const hydratedEntries = await readEntriesStreaming(
        path,
        resolveJsonLinesReadLimits(options.readLimitSettings),
      );
      const ledger = new HumanAttentionPressureLedger(path, eventBus, now, {
        ...options,
        hydratedEntries,
      });
      detachBuffer?.();
      for (const event of pending) ledger.recordHumanAttentionPressureEvent(event);
      return ledger;
    } catch (error) {
      detachBuffer?.();
      throw error;
    }
  }

  private readonly entries: HumanAttentionPressureLedgerEntry[];
  private readonly detachEventBus: (() => void) | null;

  constructor(
    private readonly path: string,
    eventBus: EventBus | null = null,
    private readonly now: () => number = Date.now,
    options: HumanAttentionPressureLedgerOptions = {},
  ) {
    this.entries = options.hydratedEntries
      ?? readEntriesSync(path, resolveJsonLinesReadLimits(options.readLimitSettings));
    this.detachEventBus = eventBus?.on(
      'agent.human_attention_pressure',
      event => this.recordHumanAttentionPressureEvent(event),
    ) ?? null;
  }

  recordHumanAttentionPressureEvent(event: HumanAttentionPressureEvent): void {
    const entry: HumanAttentionPressureLedgerEntry = {
      schemaVersion: 1,
      recordType: 'human_attention_pressure_event',
      eventId: randomUUID(),
      recordedAtMs: this.now(),
      event: cloneEvent(event),
    };
    appendJsonLine(this.path, entry);
    this.entries.push(entry);
  }

  findHumanAttentionPressureEvent(input: {
    localCompanionId: string;
    contactId: string;
    channelId: string;
    sourceMessageId: string;
  }): HumanAttentionPressureEvent | null {
    const entry = this.entries.find(candidate => (
      candidate.event.localCompanionId === input.localCompanionId
      && candidate.event.contactId === input.contactId
      && candidate.event.channelId === input.channelId
      && candidate.event.sourceMessageId === input.sourceMessageId
    ));
    return entry ? cloneEvent(entry.event) : null;
  }

  listHumanAttentionPressureEvents(input: {
    localCompanionId: string;
    contactId: string;
    channelId: string;
    sinceMs: number;
  }): HumanAttentionPressureEvent[] {
    return this.entries
      .map(entry => entry.event)
      .filter(event => (
        event.localCompanionId === input.localCompanionId
        && event.contactId === input.contactId
        && event.channelId === input.channelId
        && event.timestampMs >= input.sinceMs
      ))
      .map(cloneEvent);
  }

  getData(input: {
    sinceMs?: number;
    untilMs?: number;
    contactId?: string;
    channelId?: string;
    decision?: HumanAttentionPressureDecision;
    limit?: number;
  } = {}): HumanAttentionPressureLedgerData {
    const entries = this.entries.filter(({ event }) => (
      (input.sinceMs === undefined || event.timestampMs >= input.sinceMs)
      && (input.untilMs === undefined || event.timestampMs <= input.untilMs)
      && (!input.contactId || event.contactId === input.contactId)
      && (!input.channelId || event.channelId === input.channelId)
      && (!input.decision || event.decision === input.decision)
    ));
    const events = entries.map(entry => entry.event);
    const limit = Math.max(1, Math.min(2_000, Math.floor(input.limit ?? 200)));
    return {
      aggregates: {
        eventCount: events.length,
        boundaryAlertCount: events.filter(event => event.decision === 'boundary_alert').length,
        byDecision: countBy(events, event => event.decision),
        byContact: countBy(events, event => event.contactId),
        byChannel: countBy(events, event => event.channelId),
      },
      events: entries
        .slice(-limit)
        .reverse()
        .map(entry => ({ ...entry, event: cloneEvent(entry.event) })),
    };
  }

  close(): void {
    this.detachEventBus?.();
  }
}
