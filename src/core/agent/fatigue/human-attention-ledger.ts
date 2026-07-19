import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { appendJsonLine } from '../../../persistence/jsonl.js';
import type { EventBus } from '../../../shared/event-bus.js';
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

function cloneEvent(event: HumanAttentionPressureEvent): HumanAttentionPressureEvent {
  return { ...event };
}

function assertEvent(value: unknown, lineNumber: number): asserts value is HumanAttentionPressureEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid human attention ledger entry at line ${lineNumber}: missing event`);
  }
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

function readEntries(path: string): HumanAttentionPressureLedgerEntry[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8');
  if (!raw.trim()) return [];
  return raw
    .split('\n')
    .filter(line => line.trim())
    .map((line, index) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid human attention ledger JSON at line ${index + 1}: ${String(error)}`);
      }
      assertEntry(parsed, index + 1);
      return parsed;
    });
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

export class HumanAttentionPressureLedger implements HumanAttentionPressureStore {
  private readonly entries: HumanAttentionPressureLedgerEntry[];
  private readonly detachEventBus: (() => void) | null;

  constructor(
    private readonly path: string,
    eventBus: EventBus | null = null,
    private readonly now: () => number = Date.now,
  ) {
    this.entries = readEntries(path);
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
