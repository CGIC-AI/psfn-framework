// Per-companion daily spend ceiling for the remote Jev decision backend (bead
// psfn-framework-na1r9).
//
// Jev is not a models.json entry, so the model budget and model-call gate in
// primitives/llm never see it. This gate is its own admission check: before a
// call is dispatched, the companion's Jev spend already ledgered today (the
// same immutable usage rows the model budget reads, restricted to the Jev
// attribution) plus the worst-case price of every call this gateway has in
// flight plus this call's worst case must stay within the owner-file
// `decisionBackend.jev.dailyBudgetUsd`. Anything else refuses, and the caller
// answers locally:
//
//   * no usage query wired, or the query fails  -> accounting unavailable;
//   * an unknown-cost Jev row today             -> spend cannot be bounded;
//   * the ceiling would be crossed              -> budget exceeded.
//
// The in-flight reservation closes the window between "spend read" and "row
// written", so concurrent calls on one gateway cannot all pass the same read.
// Reservations are per gateway process: two gateways sharing one ledger could
// each admit one call past the same read.
// A crossed ceiling is reported on the health plane once per companion per UTC
// day, not once per refused call.

import {
  emitHealthEvent,
  hashHealthEventSubject,
  processObserverId,
  resolveHealthEventOwner,
  type HealthEventPublisher,
} from '../../shared/contracts/health-event.js';
import type { ModelUsageBudgetQueryPort } from '../../shared/telemetry/model-usage.js';
import { createComponentLogger } from '../../shared/logger.js';
import { toErrorMessage } from '../../shared/utils/errors.js';

const log = createComponentLogger('jev-decision-budget');

/** The usage attribution every Jev decision row carries; the ceiling counts only these. */
export const JEV_DECISION_USAGE_ATTRIBUTION = Object.freeze({
  service: 'decision',
  process: 'jev',
} as const);

type JevBudgetRefusalCode =
  | 'jev_budget_accounting_unavailable'
  | 'jev_budget_unknown_cost'
  | 'jev_daily_budget_exceeded';

type JevBudgetAdmission =
  | { ok: true; release: () => void }
  | { ok: false; reasonCode: JevBudgetRefusalCode };

export interface JevDecisionBudgetGate {
  admit(input: {
    companionId?: string;
    dailyBudgetUsd: number;
    worstCaseUsd: number;
    nowMs: number;
  }): Promise<JevBudgetAdmission>;
}

interface Reservation {
  amountUsd: number;
  /** Gateway sequence number of the release; null while the call is in flight. */
  releasedAt: number | null;
}

interface CompanionReservationLedger {
  reservations: Set<Reservation>;
  /** Sequence number at which each pending spend read started, by read id. */
  pendingReadStarts: Map<number, number>;
}

export function createJevDecisionBudgetGate(options: {
  budgetQuery?: ModelUsageBudgetQueryPort;
  healthEvents?: HealthEventPublisher;
}): JevDecisionBudgetGate {
  const ledgers = new Map<string, CompanionReservationLedger>();
  const reportedDayByCompanion = new Map<string, string>();
  // Orders reservation releases against spend reads on this gateway.
  let sequence = 0;
  let nextReadId = 0;

  function ledgerFor(key: string): CompanionReservationLedger {
    let ledger = ledgers.get(key);
    if (!ledger) {
      ledger = { reservations: new Set(), pendingReadStarts: new Map() };
      ledgers.set(key, ledger);
    }
    return ledger;
  }

  /**
   * In-flight worst cases to add to a spend read that started at `readStart`:
   * every live reservation, and every one released after the read started,
   * because its row may have committed after the read's snapshot. A call
   * whose row the read did see is counted twice, which only errs safe.
   */
  function reservedUsd(ledger: CompanionReservationLedger, readStart: number): number {
    let total = 0;
    for (const reservation of ledger.reservations) {
      if (reservation.releasedAt === null || reservation.releasedAt > readStart) total += reservation.amountUsd;
    }
    return total;
  }

  /** Forgets released reservations no pending read can still need. */
  function prune(ledger: CompanionReservationLedger): void {
    const oldestPendingRead = Math.min(Infinity, ...ledger.pendingReadStarts.values());
    for (const reservation of ledger.reservations) {
      if (reservation.releasedAt !== null && reservation.releasedAt <= oldestPendingRead) {
        ledger.reservations.delete(reservation);
      }
    }
  }

  function reserve(ledger: CompanionReservationLedger, amountUsd: number): () => void {
    const reservation: Reservation = { amountUsd, releasedAt: null };
    ledger.reservations.add(reservation);
    return () => {
      if (reservation.releasedAt !== null) return;
      sequence += 1;
      reservation.releasedAt = sequence;
      prune(ledger);
    };
  }

  function reportExceeded(
    key: string,
    companionId: string | undefined,
    dayKey: string,
    spentUsd: number,
    limitUsd: number,
    nowMs: number,
  ): void {
    if (reportedDayByCompanion.get(key) === dayKey) return;
    reportedDayByCompanion.set(key, dayKey);
    log.warn('Jev daily decision budget reached; remote decisions answer locally until the UTC day rolls over', {
      spentUsd,
      limitUsd,
    });
    if (!options.healthEvents) return;
    void emitHealthEvent(options.healthEvents, {
      owner: resolveHealthEventOwner(companionId),
      severity: 'degraded',
      code: 'decision_budget_exceeded',
      provenance: {
        process: 'gateway',
        component: 'decision',
        observerId: processObserverId(),
        subjectHash: hashHealthEventSubject('decision_budget:jev:daily'),
      },
      observedAtMs: nowMs,
      evidence: { spentUsd, limitUsd },
    }).catch((error: unknown) => {
      log.error('Failed to emit Jev decision budget health event', { error: toErrorMessage(error) });
    });
  }

  return {
    async admit({ companionId, dailyBudgetUsd, worstCaseUsd, nowMs }) {
      if (!options.budgetQuery) return { ok: false, reasonCode: 'jev_budget_accounting_unavailable' };
      const key = companionId?.trim() ?? '';
      const ledger = ledgerFor(key);
      const readId = nextReadId;
      nextReadId += 1;
      const readStart = sequence;
      ledger.pendingReadStarts.set(readId, readStart);
      let spend;
      try {
        spend = await options.budgetQuery.getModelBudgetSpend(nowMs, {
          ...(key ? { companionId: key } : {}),
          attribution: JEV_DECISION_USAGE_ATTRIBUTION,
        });
      } catch (error) {
        log.warn('Jev decision budget accounting failed; the caller answers locally', {
          error: toErrorMessage(error),
        });
        return { ok: false, reasonCode: 'jev_budget_accounting_unavailable' };
      } finally {
        ledger.pendingReadStarts.delete(readId);
      }
      // Counted before pruning: this read's own window still applies.
      const projectedUsd = spend.dailyEstimatedCostUsd + reservedUsd(ledger, readStart) + worstCaseUsd;
      prune(ledger);
      if (spend.dailyUnknownCostAttempts > 0) {
        return { ok: false, reasonCode: 'jev_budget_unknown_cost' };
      }
      // Check and reserve with no await between them, so the next admission
      // on this gateway always sees this call.
      if (projectedUsd > dailyBudgetUsd) {
        // Only ledgered spend reaching the ceiling is the reportable condition;
        // a refusal caused by concurrent reservations alone is transient, and
        // reporting it would spend the day's one report before the real one.
        if (spend.dailyEstimatedCostUsd + worstCaseUsd > dailyBudgetUsd) {
          reportExceeded(key, companionId, spend.dayKey, spend.dailyEstimatedCostUsd, dailyBudgetUsd, nowMs);
        }
        return { ok: false, reasonCode: 'jev_daily_budget_exceeded' };
      }
      return { ok: true, release: reserve(ledger, worstCaseUsd) };
    },
  };
}
