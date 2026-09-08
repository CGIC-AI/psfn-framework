// ── Human escalation control plane (bead psfn-framework-bznbn) ──
//
// The one governed path from "a domain needs a human" to "a human was asked,
// and here is what they said". It does exactly five things, in this order, and
// nothing else:
//
//   1. Admits the raise against the closed vocabularies in `contracts.ts`.
//      An unknown kind, a malformed key, a label that is not a vocabulary
//      token — all rejected here, before any row exists.
//   2. Resolves the owner-file routing entry for the kind: which sink, and how
//      long a cooldown applies to repeats about the same condition.
//   3. Replays idempotently. An `idempotencyKey` already in the ledger is a
//      redelivery of a notice that was already attempted; the plane returns the
//      recorded outcome and dispatches nothing.
//   4. Opens (or reopens) the durable escalation for the condition, CLAIMS the
//      attempt row for this notice, and only then dispatches to the routed sink
//      — or, for `garden_only`, records that the ledger row IS the notice.
//   5. Settles the claimed attempt with what the sink said, so step 3 survives
//      a restart.
//
// Step 4 claims before it dispatches, and that ordering is the whole
// concurrency argument. Step 3's lookup is a fast path over a committed row; it
// cannot stop two overlapping raises about one NEW condition, which both find
// no attempt and both open the same escalation. The attempt key is a primary
// key, so exactly one of them wins the claim and pages, and the loser is handed
// the winner's outcome as a replay.
//
// What it deliberately does NOT do: own a sink, own retry, own rendering, or
// own any domain's decision. `operator-alert-dispatcher.ts` is untouched and
// reached through an adapter; the notice is rendered by the caller and passes
// through opaque; a resolution is recorded, never executed.
//
// Deduplication is layered on purpose and the layers do different jobs. The
// plane's cooldown throttles repeats about one CONDITION. A caller that already
// owns a longer, evidence-aware clock — the incident alert path and its
// `realertCooldownMs` — configures a zero cooldown here, and the owner file
// enforces that so the two clocks can never silently fight.

import { createComponentLogger } from '../logger.js';
import { toErrorMessage } from '../utils/errors.js';
import {
  checkHumanEscalationTransition,
  validateHumanEscalationRaise,
  type HumanEscalationActor,
  type HumanEscalationDeliveryOutcome,
  type HumanEscalationKind,
  type HumanEscalationLedgerPort,
  type HumanEscalationRaiseRequest,
  type HumanEscalationRecord,
  type HumanEscalationResolutionReason,
  type HumanEscalationResolutionState,
  type HumanEscalationSinkId,
} from './contracts.js';

const log = createComponentLogger('HumanEscalationControlPlane');

interface HumanEscalationLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

/**
 * One routed destination. `TNotice` is the caller's rendered notification: the
 * plane hands it over untouched, which is what keeps rendering with the domain
 * that owns the vocabulary being rendered.
 */
export interface HumanEscalationSink<TNotice> {
  readonly id: HumanEscalationSinkId;
  deliver(notice: TNotice, record: HumanEscalationRecord): Promise<HumanEscalationDeliveryOutcome>;
}

/** Owner-file routing for one kind. */
interface HumanEscalationRoute {
  sink: HumanEscalationSinkId;
  /** Zero means the caller owns deduplication for this kind. */
  cooldownMs: number;
}

export type HumanEscalationRoutingPolicy = Readonly<
  Record<HumanEscalationKind, HumanEscalationRoute>
>;

type HumanEscalationRaiseResult =
  | { status: 'delivered'; escalationId: string }
  /** Routed to `garden_only`: the durable row is the whole notice. */
  | { status: 'recorded'; escalationId: string }
  | { status: 'suppressed'; escalationId: string; reason: 'within_cooldown' }
  /** This idempotency key was already attempted; nothing was dispatched again. */
  | { status: 'replayed'; escalationId: string; outcome: HumanEscalationDeliveryOutcome }
  | {
      status: 'undeliverable';
      escalationId: string;
      reason: 'no_sink' | 'unconfigured' | 'delivery_failed';
    };

export interface HumanEscalationControlPlane<TNotice> {
  raise(request: HumanEscalationRaiseRequest<TNotice>): Promise<HumanEscalationRaiseResult>;
  /**
   * How many times this runtime has already raised one condition, across every
   * process that ever ran. A caller that builds a per-attempt idempotency key
   * from a counter MUST take it from here rather than from its own in-process
   * state: a process-local counter restarts at zero, and after two restarts it
   * re-mints a key the ledger has already recorded, which the plane correctly
   * refuses to dispatch twice.
   */
  raiseCount(kind: HumanEscalationKind, dedupeKey: string): Promise<number>;
}

export interface HumanEscalationControlPlaneOptions<TNotice> {
  ledger: HumanEscalationLedgerPort;
  /** Re-read per raise so an owner-file reload takes effect without a restart. */
  routing: () => HumanEscalationRoutingPolicy;
  /**
   * Sinks this process can actually reach. `garden_only` needs no entry — it
   * dispatches nothing — but every other routed sink must be present, and a
   * routing entry naming an absent one fails at construction rather than at the
   * first incident.
   */
  sinks: readonly HumanEscalationSink<TNotice>[];
  now?: () => number;
  logger?: HumanEscalationLogger;
}

function requireRoute(
  routing: HumanEscalationRoutingPolicy,
  kind: HumanEscalationKind,
): HumanEscalationRoute {
  // Widened deliberately: the owner file proves every kind is routed, but this
  // seam is also reachable from a caller-supplied policy, and a kind with no
  // entry must throw rather than dereference undefined at the sink.
  const table: Partial<Record<HumanEscalationKind, HumanEscalationRoute>> = routing;
  const route = table[kind];
  if (!route) {
    throw new Error(
      `Human escalation kind ${kind} has no routing entry; the owner file must route every kind`,
    );
  }
  return route;
}

export function createHumanEscalationControlPlane<TNotice>(
  options: HumanEscalationControlPlaneOptions<TNotice>,
): HumanEscalationControlPlane<TNotice> {
  const now = options.now ?? (() => Date.now());
  const logger = options.logger ?? log;
  const sinks = new Map<HumanEscalationSinkId, HumanEscalationSink<TNotice>>();
  for (const sink of options.sinks) {
    if (sinks.has(sink.id)) {
      throw new Error(`Human escalation sink ${sink.id} is registered twice`);
    }
    sinks.set(sink.id, sink);
  }
  // Fail closed at construction: a kind routed to a sink this process cannot
  // reach is a deployment mistake, and discovering it at the first escalation
  // means discovering it exactly when nobody can afford to.
  const declaredRouting = options.routing();
  for (const [kind, route] of Object.entries(declaredRouting)) {
    if (route.sink !== 'garden_only' && !sinks.has(route.sink)) {
      throw new Error(
        `Human escalation kind ${kind} routes to sink ${route.sink}, which is not registered`,
      );
    }
  }

  return {
    async raiseCount(kind: HumanEscalationKind, dedupeKey: string): Promise<number> {
      const existing = await options.ledger.findByCondition(kind, dedupeKey);
      return existing?.raiseCount ?? 0;
    },

    async raise(
      request: HumanEscalationRaiseRequest<TNotice>,
    ): Promise<HumanEscalationRaiseResult> {
      const { facts, idempotencyKey } = validateHumanEscalationRaise(request);
      const route = requireRoute(options.routing(), facts.kind);

      const replay = await options.ledger.findAttempt(idempotencyKey);
      if (replay) {
        logger.info('Human escalation raise replayed an already-recorded attempt', {
          kind: facts.kind,
          sink: replay.sink,
          outcome: replay.outcome,
          escalationId: replay.escalationId,
        });
        return {
          status: 'replayed',
          escalationId: replay.escalationId,
          outcome: replay.outcome,
        };
      }

      const record = await options.ledger.openOrReopen(facts);
      const nowMs = now();

      /**
       * Take the attempt row BEFORE anything is dispatched for it. The replay
       * lookup above is a fast path over a committed row; it cannot stop two
       * overlapping raises that both read no attempt and both reach here. This
       * can, because the attempt key is a primary key: exactly one caller owns
       * the dispatch, and every other caller is told who already does.
       */
      const claim = async (
        provisionalOutcome: HumanEscalationDeliveryOutcome,
      ): Promise<HumanEscalationRaiseResult | null> => {
        const claimed = await options.ledger.claimAttempt({
          idempotencyKey,
          escalationId: record.escalationId,
          sink: route.sink,
          outcome: provisionalOutcome,
          attemptedAtMs: nowMs,
        });
        if (claimed.claimed) return null;
        logger.info('Human escalation raise lost the attempt claim and dispatched nothing', {
          kind: facts.kind,
          sink: route.sink,
          outcome: claimed.existing.outcome,
          escalationId: claimed.existing.escalationId,
        });
        return {
          status: 'replayed',
          escalationId: claimed.existing.escalationId,
          outcome: claimed.existing.outcome,
        };
      };

      if (route.cooldownMs > 0
        && record.lastNotifiedAtMs !== null
        && nowMs - record.lastNotifiedAtMs < route.cooldownMs) {
        const lost = await claim('suppressed');
        if (lost) return lost;
        logger.info('Human escalation suppressed inside its routed cooldown', {
          kind: facts.kind,
          severity: facts.severity,
          sink: route.sink,
          escalationId: record.escalationId,
        });
        return { status: 'suppressed', escalationId: record.escalationId, reason: 'within_cooldown' };
      }

      let outcome: HumanEscalationDeliveryOutcome;
      if (route.sink === 'garden_only') {
        const lost = await claim('recorded');
        if (lost) return lost;
        outcome = 'recorded';
      } else {
        const sink = sinks.get(route.sink);
        if (!sink) {
          throw new Error(
            `Human escalation sink ${route.sink} disappeared after construction`,
          );
        }
        // The provisional outcome is the fail-closed one. A process that dies
        // between the claim and the settle leaves a row that does not claim a
        // delivery nobody can prove happened. It is also what the settle below
        // compares against, so this value names the row this caller owns.
        const provisionalOutcome = 'delivery_failed' as const;
        const lost = await claim(provisionalOutcome);
        if (lost) return lost;
        try {
          outcome = await sink.deliver(request.notice, record);
        } catch (error) {
          // Contained, never swallowed: a sink adapter that throws is itself
          // news, and the claimed attempt row is what stops the next raise from
          // re-paging on the same key.
          logger.warn('Human escalation sink threw while delivering', {
            kind: facts.kind,
            sink: route.sink,
            escalationId: record.escalationId,
            error: toErrorMessage(error),
          });
          outcome = 'delivery_failed';
        }
        await options.ledger.settleAttempt({
          idempotencyKey,
          expectedOutcome: provisionalOutcome,
          outcome,
        });
      }

      if (outcome === 'delivered') {
        await options.ledger.markNotified(record.escalationId, nowMs);
        logger.info('Human escalation delivered to its routed sink', {
          kind: facts.kind,
          severity: facts.severity,
          sink: route.sink,
          escalationId: record.escalationId,
          raiseCount: record.raiseCount,
        });
        return { status: 'delivered', escalationId: record.escalationId };
      }
      if (outcome === 'recorded') {
        logger.info('Human escalation recorded for the Garden attention surface', {
          kind: facts.kind,
          severity: facts.severity,
          escalationId: record.escalationId,
          raiseCount: record.raiseCount,
        });
        return { status: 'recorded', escalationId: record.escalationId };
      }
      if (outcome === 'suppressed') {
        throw new Error('A human escalation sink may not report a suppressed outcome');
      }
      logger.warn('Human escalation could not reach a human', {
        kind: facts.kind,
        severity: facts.severity,
        sink: route.sink,
        outcome,
        escalationId: record.escalationId,
      });
      return { status: 'undeliverable', escalationId: record.escalationId, reason: outcome };
    },
  };
}

export type HumanEscalationResolveResult =
  | { ok: true; record: HumanEscalationRecord }
  | { ok: false; status: 404 | 409; error: string };

/**
 * Record what a human said about one escalation.
 *
 * Kept as a function over the ledger rather than a method on the plane because
 * resolving needs no sink, no routing, and no notice type: an operator surface
 * should be able to answer an escalation without holding the machinery that
 * raises one.
 */
export async function resolveHumanEscalation(
  ledger: HumanEscalationLedgerPort,
  input: {
    escalationId: string;
    state: HumanEscalationResolutionState;
    reason: HumanEscalationResolutionReason;
    actor: HumanEscalationActor;
    resolvedAtMs: number;
  },
): Promise<HumanEscalationResolveResult> {
  const existing = await ledger.getById(input.escalationId);
  if (!existing) {
    return { ok: false, status: 404, error: 'Escalation not found' };
  }
  const rejection = checkHumanEscalationTransition(existing.state, input.state);
  if (rejection) {
    return { ok: false, status: 409, error: rejection.message };
  }
  const updated = await ledger.applyResolution({
    escalationId: input.escalationId,
    expectedState: existing.state,
    resolution: {
      state: input.state,
      reason: input.reason,
      actor: input.actor,
      resolvedAtMs: input.resolvedAtMs,
    },
  });
  if (!updated) {
    return {
      ok: false,
      status: 409,
      error: 'Escalation changed state while the resolution was being recorded',
    };
  }
  return { ok: true, record: updated };
}
