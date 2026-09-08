// ── Confirmation queue → human escalation control plane (bead
// psfn-framework-wtw7l) ──
//
// The confirmation queue has always been a place a human is asked for
// something, and has never said so anywhere a human looks. This is the
// producer that closes that gap: every enqueue raises onto the escalation
// plane, and every resolution — approval, denial, expiry — mirrors the queue's
// own decision back onto the same durable row.
//
// Three properties this file exists to hold:
//
//   * It changes nothing about the queue. The escalation is raised from the
//     observer seam the queue already exposes, the raise is fire-and-forget,
//     and a plane that is down cannot fail an approval. An approval flow that
//     started refusing work because a ledger was unreachable would be a worse
//     outcome than the invisibility this fixes.
//   * It is CONTENT-FREE. The queue's entries carry a method, an action, a
//     scope, a companion's stated reason and arbitrary parameters; none of it
//     crosses this seam. What crosses is the entry id, a vocabulary label, and
//     the approval window in milliseconds. The Garden row points at
//     `/confirmations`, where the domain shows its own detail under its own
//     authority.
//   * Enqueue and resolve are SERIALIZED per entry. The queue resolves
//     synchronously and the plane is asynchronous, so a fast approve can
//     otherwise reach `resolve` before its own `raise` has committed — which
//     would find no row, no-op, and leave an answered confirmation open on the
//     operator surface forever. Each entry's work is chained onto the previous
//     step for that entry, and the chain is dropped once it is terminal.

import { createComponentLogger } from '../../shared/logger.js';
import { resolveHealthEventOwner } from '../../shared/contracts/health-event.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import {
  resolveHumanEscalation,
  type HumanEscalationControlPlane,
} from '../../shared/escalation/control-plane.js';
import type {
  HumanEscalationActor,
  HumanEscalationLedgerPort,
  HumanEscalationResolutionReason,
} from '../../shared/escalation/contracts.js';
import type {
  ConfirmationQueueEntry,
  ConfirmationQueueObserver,
  ConfirmationQueueResolutionOutcome,
} from './confirmation-queue.js';

const log = createComponentLogger('ConfirmationEscalationProducer');

/** The Garden page that owns confirmation detail; the ledger only points here. */
const CONFIRMATION_GARDEN_DETAIL_PATH = '/confirmations';

const CONFIRMATION_ESCALATION_KIND = 'operator_confirmation';

interface ConfirmationEscalationLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface ConfirmationEscalationProducerOptions<TNotice> {
  /** Raises onto the plane; `garden_only` by owner-file default, so nothing pages. */
  plane: HumanEscalationControlPlane<TNotice>;
  /** The same durable ledger the plane writes, read to mirror a resolution. */
  ledger: HumanEscalationLedgerPort;
  /**
   * Renders the notice a sink would receive. Owned by the caller, exactly as
   * the plane's contract requires, and unused while this kind routes
   * `garden_only` — but the owner file may route it elsewhere, and a producer
   * that could not render one would turn an operator's routing change into a
   * runtime failure.
   */
  renderNotice: (entry: ConfirmationQueueEntry) => TNotice;
  now?: () => number;
  logger?: ConfirmationEscalationLogger;
}

/**
 * How a queue outcome reads as a human resolution.
 *
 * `approved`, `denied` and `modified` are all a person having dealt with the
 * request — the plane records THAT a human answered and the Garden audit
 * timeline records what they said, so collapsing the three here loses nothing
 * the runtime holds elsewhere. An expiry is the opposite: nobody answered, and
 * the window closed, so there is nothing left to act on.
 */
function resolutionFor(
  outcome: ConfirmationQueueResolutionOutcome,
): { reason: HumanEscalationResolutionReason; actor: HumanEscalationActor } | null {
  if (outcome.status === 'expired') {
    return { reason: 'not_actionable', actor: 'system' };
  }
  if (outcome.status === 'approved'
    || outcome.status === 'denied'
    || outcome.status === 'modified') {
    return {
      reason: 'handled',
      actor: outcome.resolver?.kind === 'operator' ? 'operator' : 'system',
    };
  }
  // `failed` leaves the entry pending: the queue has not decided, so neither
  // has the escalation. Resolving here would clear an operator's page for a
  // request that is still waiting on them.
  return null;
}

/**
 * The approval window, which is the one number an operator triaging a queue
 * actually needs and the only one that carries nothing about the request.
 */
function windowMs(entry: ConfirmationQueueEntry): number {
  return Math.max(0, entry.expiresAt - entry.requestedAt);
}

export function createConfirmationEscalationObserver<TNotice>(
  options: ConfirmationEscalationProducerOptions<TNotice>,
): ConfirmationQueueObserver {
  const now = options.now ?? (() => Date.now());
  const logger = options.logger ?? log;
  // One chain per entry id, so a resolution can never overtake its own raise.
  const chains = new Map<string, Promise<void>>();

  const chain = (id: string, step: () => Promise<void>, terminal: boolean): void => {
    const previous = chains.get(id) ?? Promise.resolve();
    const next = previous
      .then(step)
      .catch((error: unknown) => {
        // Contained, never swallowed. A ledger fault must not fail an approval,
        // and the operator alert path is not the right place to learn that a
        // Garden row is missing — the log line is.
        logger.warn('Confirmation escalation step failed', {
          confirmationId: id,
          error: toErrorMessage(error),
        });
      })
      .then(() => {
        if (terminal && chains.get(id) === next) chains.delete(id);
      });
    chains.set(id, next);
  };

  return {
    onEnqueued(entry: ConfirmationQueueEntry): void {
      chain(entry.id, async () => {
        // From the DURABLE ledger, not a process-local counter: a gateway that
        // restarts mid-queue would otherwise re-mint an attempt key the ledger
        // already holds, and the plane would correctly refuse to record it.
        const raiseCount = await options.plane.raiseCount(
          CONFIRMATION_ESCALATION_KIND,
          entry.id,
        );
        await options.plane.raise({
          kind: CONFIRMATION_ESCALATION_KIND,
          severity: 'warning',
          // A confirmation with no approval owner is the runtime's own, and a
          // companion id the parser refuses is not silently downgraded to a
          // tenant — `resolveHealthEventOwner` fails it closed to system-owned,
          // which the Garden fence shows to whoever can read the surface rather
          // than to the wrong companion.
          owner: resolveHealthEventOwner(entry.approvalOwner?.companionId),
          dedupeKey: entry.id,
          idempotencyKey: `${entry.id}.${String(raiseCount + 1)}`,
          sourceRef: entry.id,
          labels: [CONFIRMATION_ESCALATION_KIND],
          evidence: { windowMs: windowMs(entry) },
          detailPath: CONFIRMATION_GARDEN_DETAIL_PATH,
          raisedAtMs: now(),
          // Rendered by the caller and passed through opaque: while this kind
          // routes `garden_only` the durable row IS the notice and no sink ever
          // sees this value.
          notice: options.renderNotice(entry),
        });
      }, false);
    },

    onResolved(outcome: ConfirmationQueueResolutionOutcome): void {
      const resolution = resolutionFor(outcome);
      if (!resolution) return;
      chain(outcome.id, async () => {
        const existing = await options.ledger.findByCondition(
          CONFIRMATION_ESCALATION_KIND,
          outcome.id,
        );
        // No row is not an error. A confirmation enqueued before this producer
        // was wired, or one whose raise failed, still resolves in its own
        // domain; the ledger simply has nothing to mirror.
        if (!existing) return;
        const result = await resolveHumanEscalation(options.ledger, {
          escalationId: existing.escalationId,
          state: 'resolved',
          reason: resolution.reason,
          actor: resolution.actor,
          resolvedAtMs: now(),
        });
        if (result.ok) return;
        // 409 is the ordinary race: an operator answered the Garden row before
        // the queue's own resolution landed, and the ledger already says so.
        logger.info('Confirmation escalation was already answered', {
          confirmationId: outcome.id,
          status: result.status,
        });
      }, true);
    },
  };
}
