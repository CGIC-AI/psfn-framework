import { createComponentLogger } from '../../../shared/logger.js';
import type {
  TurnRecordContinuityWithheld,
  TurnRecordMessageWithheld,
  TurnRecordRecentEntryHealDrop,
  TurnRecordWireBodyWithheld,
} from '../turn-record-session-refs.js';

const log = createComponentLogger('SessionStore');

/**
 * Content-free identity of one bounded TurnRecord read. Every field here is a
 * routing/id value that already appears in store telemetry; no conversation
 * content, metadata, or entry body ever enters this surface.
 */
export interface TurnRecordReadWindowProvenance {
  /** Store method that opened this window, e.g. `getRecentTurnRecords`. */
  readonly readOperation: string;
  /** Channel/session id-space the read was scoped to. */
  readonly channelId: string;
  /** Caller-requested bound, when the read takes one. */
  readonly limit?: number;
}

/** Safe per-event provenance retained for the first and last occurrence. */
interface TurnRecordTelemetryProvenance {
  readonly channelId: string;
  readonly turnId: string;
  readonly entryId?: number;
}

/**
 * O(1) accumulator for one telemetry kind across a read window: exact total,
 * per-category counts, distinct affected records, and first/last provenance.
 * Bounded by construction — nothing grows with the number of occurrences except
 * the category map, whose key space is a closed union.
 */
class TurnRecordTelemetryAggregate<TCategory extends string> {
  total = 0;
  private first: TurnRecordTelemetryProvenance | undefined;
  private last: TurnRecordTelemetryProvenance | undefined;
  private readonly affectedTurnIds = new Set<string>();
  private readonly categories = new Map<TCategory, number>();

  record(provenance: TurnRecordTelemetryProvenance, category?: TCategory): void {
    this.total += 1;
    this.last = provenance;
    this.first ??= provenance;
    this.affectedTurnIds.add(provenance.turnId);
    if (category !== undefined) {
      this.categories.set(category, (this.categories.get(category) ?? 0) + 1);
    }
  }

  summarize(countField: string, categoryField: string): Record<string, unknown> {
    return {
      [countField]: this.total,
      recordsAffected: this.affectedTurnIds.size,
      ...(this.categories.size > 0
        ? { [categoryField]: Object.fromEntries(this.categories) }
        : {}),
      ...(this.first ? { first: this.first } : {}),
      ...(this.last ? { last: this.last } : {}),
    };
  }
}

/**
 * Process-lifetime running totals. Preserved from the per-row emitters these
 * aggregates replace so an operator reading two windows can still tell a fresh
 * signal from a long-running one; no telemetry port is reachable from the
 * persistence layer, so the component logger remains the only sink.
 */
const processTotals = {
  healDropsThisProcess: 0,
  wireBodiesWithheldThisProcess: 0,
  messagesWithheldThisProcess: 0,
  continuityEntriesWithheldThisProcess: 0,
};

/**
 * Request-scoped aggregation for TurnRecord session-ref heal/withhold telemetry
 * (bead psfn-framework-ylu4i). A bounded user-requested history or introspection
 * read can legitimately touch thousands of old-fat / ref-missing rows; emitting
 * one info event per row floods the log with an expected outcome. One window is
 * opened per store read, every sink accumulates into it, and `flush` emits at
 * most one truthful aggregate per telemetry kind.
 *
 * The window is an ordinary local object owned by exactly one synchronous read,
 * so concurrent reads cannot mix accounting. It never changes a heal, withhold,
 * or redaction decision, and never observes or suppresses a thrown resolver
 * error — callers flush in `finally` and let the error propagate.
 */
export class TurnRecordReadTelemetryWindow {
  private readonly healDrops = new TurnRecordTelemetryAggregate<TurnRecordRecentEntryHealDrop['source']>();
  private readonly wireBodies = new TurnRecordTelemetryAggregate<never>();
  private readonly messages = new TurnRecordTelemetryAggregate<TurnRecordMessageWithheld['surface']>();
  private readonly continuity = new TurnRecordTelemetryAggregate<TurnRecordContinuityWithheld['reason']>();
  private recordsResolved = 0;
  private flushed = false;

  constructor(private readonly provenance: TurnRecordReadWindowProvenance) {}

  readonly onHealDrop = (drop: TurnRecordRecentEntryHealDrop): void => {
    this.healDrops.record(
      { channelId: drop.channelId, turnId: drop.turnId, entryId: drop.entryId },
      drop.source,
    );
  };

  readonly onWireBodyWithheld = (event: TurnRecordWireBodyWithheld): void => {
    this.wireBodies.record({ channelId: event.channelId, turnId: event.turnId });
  };

  readonly onMessageWithheld = (event: TurnRecordMessageWithheld): void => {
    this.messages.record(
      { channelId: event.channelId, turnId: event.turnId, entryId: event.entryId },
      event.surface,
    );
  };

  readonly onContinuityWithheld = (event: TurnRecordContinuityWithheld): void => {
    this.continuity.record(
      {
        channelId: event.sourceChannelId,
        turnId: event.turnId,
        ...(event.sourceEntryId === undefined ? {} : { entryId: event.sourceEntryId }),
      },
      event.reason,
    );
  };

  /** Counts one record whose refs were resolved inside this window. */
  countResolvedRecord(): void {
    this.recordsResolved += 1;
  }

  /**
   * Emits at most one aggregate per telemetry kind and marks the window spent.
   * `completed` is false when the read aborted part-way (a resolver threw), so a
   * partial aggregate never claims to describe the whole window.
   */
  flush(outcome: { readonly completed: boolean; readonly exhausted?: boolean }): void {
    if (this.flushed) return;
    this.flushed = true;
    const base = {
      readOperation: this.provenance.readOperation,
      readChannelId: this.provenance.channelId,
      ...(this.provenance.limit === undefined ? {} : { readLimit: this.provenance.limit }),
      recordsRead: this.recordsResolved,
      windowCompleted: outcome.completed,
      ...(outcome.exhausted === undefined ? {} : { historyExhausted: outcome.exhausted }),
    };
    this.emit('turn_record_recent_entry_heal_drop', this.healDrops, base, 'droppedEntries', 'sourceCounts', 'healDropsThisProcess');
    this.emit('turn_record_wire_body_withheld', this.wireBodies, base, 'wireBodiesWithheld', 'categoryCounts', 'wireBodiesWithheldThisProcess');
    this.emit('turn_record_message_withheld', this.messages, base, 'messagesWithheld', 'surfaceCounts', 'messagesWithheldThisProcess');
    this.emit('turn_record_continuity_withheld', this.continuity, base, 'continuityEntriesWithheld', 'reasonCounts', 'continuityEntriesWithheldThisProcess');
  }

  private emit(
    event: string,
    aggregate: TurnRecordTelemetryAggregate<string>,
    base: Record<string, unknown>,
    countField: string,
    categoryField: string,
    processField: keyof typeof processTotals,
  ): void {
    if (aggregate.total === 0) return;
    processTotals[processField] += aggregate.total;
    log.info(event, {
      ...base,
      ...aggregate.summarize(countField, categoryField),
      [processField]: processTotals[processField],
    });
  }
}

/** Test-only reset of the process-lifetime running totals. */
export function resetTurnRecordReadTelemetryTotalsForTests(): void {
  for (const key of Object.keys(processTotals) as (keyof typeof processTotals)[]) {
    processTotals[key] = 0;
  }
}
