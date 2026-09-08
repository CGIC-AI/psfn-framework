// ── CogSec quarantine → human escalation control plane (bead
// psfn-framework-wtw7l) ──
//
// Quarantine is where this runtime physically withholds something until a
// person decides. It has always been that, and it has never appeared on the one
// surface a person is asked to look at. This producer raises a held item onto
// the escalation plane and resolves it when the domain's own decision lands.
//
// The two halves run in DIFFERENT processes, and the design follows from that:
//
//   * A hold is made by the screening pipeline in the gateway, so the raise
//     happens there, against the gateway's ledger — which in fleet mode is the
//     shared one every companion's Garden can read (bead psfn-framework-e5r0s).
//   * A decision is made by an operator in the Garden, which runs in the agent
//     process against its own tenant ledger. So the resolve searches the
//     ledgers that Garden can actually reach, in order, and writes back to
//     whichever one holds the row.
//
// Content-free by construction: the quarantine entry carries raw text, a safe
// representation, a contact id, a channel id, artifact paths and a CogSec case.
// None of it crosses this seam. What crosses is the envelope id, the firewall
// mode as a vocabulary label, and the hold window in milliseconds. The Garden
// row points at the Cognitive Security page, where the domain shows its own
// detail under its own authority — and acknowledging an escalation there does
// not admit the artifact, because this producer holds no domain authority at
// all.
//
// Nothing here can fail a hold or a decision. Both are security decisions that
// are already durable by the time the observer runs; a raise is fire-and-forget
// and an unreachable ledger is a log line.

import { createComponentLogger } from '../../../shared/logger.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import {
  resolveHumanEscalation,
  type HumanEscalationControlPlane,
} from '../../../shared/escalation/control-plane.js';
import type {
  HumanEscalationActor,
  HumanEscalationLedgerPort,
  HumanEscalationResolutionReason,
} from '../../../shared/escalation/contracts.js';
import { resolveHealthEventOwner } from '../../../shared/contracts/health-event.js';
import type { IntakeQuarantineEntry } from './quarantine-store.js';

const log = createComponentLogger('QuarantineEscalationProducer');

/** The Garden page that owns quarantine detail; the ledger only points here. */
const QUARANTINE_GARDEN_DETAIL_PATH = '/cognitive-security';

const QUARANTINE_ESCALATION_KIND = 'cogsec_quarantine';

interface QuarantineEscalationLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface QuarantineHoldEscalationOptions<TNotice> {
  plane: HumanEscalationControlPlane<TNotice>;
  /** Rendered by the caller; unused while this kind routes `garden_only`. */
  renderNotice: (entry: IntakeQuarantineEntry) => TNotice;
  /** This runtime's companion identity; absent for a shard with no tenancy. */
  companionId?: string;
  now?: () => number;
  logger?: QuarantineEscalationLogger;
}

export interface QuarantineDecisionEscalationOptions {
  /**
   * Every ledger the resolving surface can reach, searched in order. In fleet
   * mode this is the companion's own ledger and then the fleet's shared one,
   * because a hold made by the gateway was raised into the latter.
   */
  ledgers: readonly HumanEscalationLedgerPort[];
  now?: () => number;
  logger?: QuarantineEscalationLogger;
}

/**
 * Whether a decision closes the escalation, and how it reads.
 *
 * Every terminal decision is a person having dealt with the item — released it,
 * released a sanitized form, or discarded it. `expired` is the one outcome a
 * person did not make: the hold window closed with nobody answering, which is
 * the runtime's own decision and not actionable by the time it is recorded.
 */
function resolutionFor(
  entry: IntakeQuarantineEntry,
): { reason: HumanEscalationResolutionReason; actor: HumanEscalationActor } | null {
  if (entry.status === 'expired') return { reason: 'not_actionable', actor: 'system' };
  if (entry.status === 'held') return null;
  return { reason: 'handled', actor: 'operator' };
}

/** The hold window: the one number an operator triaging the queue needs. */
function windowMs(entry: IntakeQuarantineEntry): number {
  return Math.max(0, entry.expiresAtMs - entry.heldAtMs);
}

/** Observer for the process that HOLDS: raises one escalation per held item. */
export function createQuarantineHoldEscalationObserver<TNotice>(
  options: QuarantineHoldEscalationOptions<TNotice>,
): (entry: IntakeQuarantineEntry) => void {
  const now = options.now ?? (() => Date.now());
  const logger = options.logger ?? log;
  return (entry: IntakeQuarantineEntry): void => {
    void (async () => {
      // From the DURABLE ledger: a gateway that restarts while items are held
      // would otherwise re-mint an attempt key the ledger already holds.
      const raiseCount = await options.plane.raiseCount(
        QUARANTINE_ESCALATION_KIND,
        entry.id,
      );
      await options.plane.raise({
        kind: QUARANTINE_ESCALATION_KIND,
        // A withheld item is a decision waiting, not a fault in progress.
        severity: 'warning',
        owner: resolveHealthEventOwner(options.companionId),
        dedupeKey: entry.id,
        idempotencyKey: `${entry.id}.${String(raiseCount + 1)}`,
        sourceRef: entry.id,
        labels: [QUARANTINE_ESCALATION_KIND, entry.mode],
        evidence: { windowMs: windowMs(entry) },
        detailPath: QUARANTINE_GARDEN_DETAIL_PATH,
        raisedAtMs: now(),
        notice: options.renderNotice(entry),
      });
    })().catch((error: unknown) => {
      logger.warn('Quarantine hold escalation raise failed', {
        envelopeId: entry.id,
        error: toErrorMessage(error),
      });
    });
  };
}

/** Observer for the process that DECIDES: mirrors the decision onto the plane. */
export function createQuarantineDecisionEscalationObserver(
  options: QuarantineDecisionEscalationOptions,
): (entry: IntakeQuarantineEntry) => void {
  const now = options.now ?? (() => Date.now());
  const logger = options.logger ?? log;
  return (entry: IntakeQuarantineEntry): void => {
    const resolution = resolutionFor(entry);
    if (!resolution) return;
    void (async () => {
      for (const ledger of options.ledgers) {
        const existing = await ledger.findByCondition(QUARANTINE_ESCALATION_KIND, entry.id);
        // No row is not an error: an item held before this producer was wired,
        // or one whose raise failed, still decides in its own domain.
        if (!existing) continue;
        const result = await resolveHumanEscalation(ledger, {
          escalationId: existing.escalationId,
          state: 'resolved',
          reason: resolution.reason,
          actor: resolution.actor,
          resolvedAtMs: now(),
        });
        if (result.ok) return;
        // 409 is the ordinary race: an operator answered the Garden row first.
        logger.info('Quarantine escalation was already answered', {
          envelopeId: entry.id,
          status: result.status,
        });
        return;
      }
    })().catch((error: unknown) => {
      logger.warn('Quarantine decision escalation resolve failed', {
        envelopeId: entry.id,
        error: toErrorMessage(error),
      });
    });
  };
}
