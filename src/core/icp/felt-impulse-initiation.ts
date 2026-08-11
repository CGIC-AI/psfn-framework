// ── Affect-driven ICP initiation: the felt-impulse source (hrmrq.34, D4) ──
//
// Operator ruling D4 (2026-07-30): "ICP triggers on social need via emo-sim,
// not by wall clock timers." The emo-sim proactivity sidecar's would_message
// lever — "she would send a proactive message now" — is the initiating
// impulse. This adapter is the ratified authoritative consumer of that
// signal: on each fire it selects an eligible canonical companion peer and
// submits an ICP initiation candidate through the EXISTING source runtime, so
// consent, gateway preflight/arbitration, permits, retry/TTL plumbing, and
// the capability-tier authorization all apply unchanged.
//
// This module deliberately does NOT import the observer-sidecar lever module:
// it consumes only the content-free bus payload {lever, firedAtMs}. Rate
// limiting is inherited from the lever's own sustain/cooldown configuration —
// the impulse cannot fire faster than the affect model sustains it — plus a
// local floor so a misconfigured lever cannot flood the candidate store.
//
// Peer eligibility is the canonical sibling-contact seed (bead x5t4): peers
// must exist as channel='companion', is_machine_intelligence contacts in this
// companion's own schema. When NO eligible peer exists the failure is
// EXPLICIT (warn log + outcome event naming the seed:sibling-contacts
// maintenance entrypoint) — never a silent no-op (live fleet evidence 2026-07-30).

import { createComponentLogger } from '../../shared/logger.js';
import type { EmotionProactiveTransitionEvent, EventBus } from '../../shared/event-bus.js';
import type { KnownCompanionPeerAvailability } from './agent-facing-autonomy.js';
import type {
  IcpInitiationSourceResult,
  IcpInitiationSourceRuntime,
} from './initiation-source-runtime.js';

const log = createComponentLogger('IcpFeltImpulse');

/** Local flood floor: at most one felt-impulse submission per window. */
export const FELT_IMPULSE_MIN_INTERVAL_MS = 15 * 60_000;

export interface FeltImpulseLeverSignal {
  lever: 'would_message';
  correlationId: string;
  firedAtMs: number;
  timestamp: number;
}

export type IcpFeltImpulseOutcome =
  | { kind: 'submitted'; peerContactId: string; result: IcpInitiationSourceResult }
  | { kind: 'no_eligible_peer' }
  | { kind: 'throttled'; nextEligibleAtMs: number }
  | { kind: 'deduped'; candidateId: string }
  | { kind: 'not_authorized' };

export interface IcpFeltImpulseInitiationAdapter {
  onLeverSignal(signal: FeltImpulseLeverSignal): Promise<IcpFeltImpulseOutcome>;
}

export interface IcpFeltImpulseInitiationDeps {
  sourceRuntime: IcpInitiationSourceRuntime;
  peers: {
    listKnownPeerAvailability(): Promise<KnownCompanionPeerAvailability[]>;
  };
  /** Runtime enablement AND capability tier, both re-checked per impulse. */
  isAuthorized(): boolean;
  eventBus?: EventBus;
  now?: () => number;
  minIntervalMs?: number;
}

export function createIcpFeltImpulseInitiationAdapter(
  deps: IcpFeltImpulseInitiationDeps,
): IcpFeltImpulseInitiationAdapter {
  const now = deps.now ?? (() => Date.now());
  const minIntervalMs = deps.minIntervalMs ?? FELT_IMPULSE_MIN_INTERVAL_MS;
  let lastSubmittedAtMs = 0;
  let lastCompleted: { correlationId: string; candidateId: string } | null = null;
  const inFlight = new Map<string, Promise<IcpFeltImpulseOutcome>>();

  const emitOutcome = async (payload: {
    correlationId: string;
    outcome: string;
    peerContactId?: string;
    candidateId?: string;
    reason?: string;
  }): Promise<void> => {
    if (!deps.eventBus) return;
    try {
      await deps.eventBus.emit('icp.felt_impulse.outcome', {
        ...payload,
        timestamp: now(),
      });
    } catch (error) {
      // Telemetry emission must never undo the initiation outcome itself.
      log.warn('Felt-impulse outcome event emit failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const emitTransition = async (
    signal: FeltImpulseLeverSignal,
    payload: Omit<EmotionProactiveTransitionEvent,
      'correlationId' | 'lever' | 'firedAtMs' | 'timestamp'>,
  ): Promise<void> => {
    if (!deps.eventBus) return;
    try {
      await deps.eventBus.emit('emotion.proactive.transition', {
        correlationId: signal.correlationId,
        lever: signal.lever,
        firedAtMs: signal.firedAtMs,
        timestamp: now(),
        ...payload,
      });
    } catch (error) {
      log.warn('Felt-impulse transition telemetry emit failed', {
        correlationId: signal.correlationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const processSignal = async (signal: FeltImpulseLeverSignal): Promise<IcpFeltImpulseOutcome> => {
    await emitTransition(signal, { stage: 'felt_impulse', outcome: 'received' });
    const completedCandidateId = lastCompleted?.correlationId === signal.correlationId
      ? lastCompleted.candidateId
      : null;
    if (completedCandidateId) {
      await emitOutcome({
        correlationId: signal.correlationId,
        outcome: 'deduped',
        candidateId: completedCandidateId,
      });
      await emitTransition(signal, {
        stage: 'final_disposition',
        outcome: 'deduped',
        candidateId: completedCandidateId,
      });
      return { kind: 'deduped', candidateId: completedCandidateId };
    }

    if (!deps.isAuthorized()) {
      // Emergency-disabled at runtime or tier lacks external.companion.
      await emitOutcome({ correlationId: signal.correlationId, outcome: 'not_authorized' });
      await emitTransition(signal, { stage: 'final_disposition', outcome: 'not_authorized' });
      return { kind: 'not_authorized' };
    }
    const nowMs = now();
    if (nowMs - lastSubmittedAtMs < minIntervalMs) {
      const nextEligibleAtMs = lastSubmittedAtMs + minIntervalMs;
      await emitOutcome({ correlationId: signal.correlationId, outcome: 'throttled' });
      await emitTransition(signal, {
        stage: 'final_disposition',
        outcome: 'throttled',
        reasonCode: 'local_flood_floor',
      });
      return { kind: 'throttled', nextEligibleAtMs };
    }

    const peers = (await deps.peers.listKnownPeerAvailability())
      .filter(peer => peer.availability.eligible);
    if (peers.length === 0) {
      // EXPLICIT peer-eligibility failure (hrmrq.34 / live fleet evidence):
      // the felt impulse fired but there is no ICP-canonical sibling
      // contact to reach. Name the fix, do not degrade silently.
      log.warn(
        'Felt social impulse fired but no ICP-eligible companion peer exists: '
        + "no contact with a channel='companion' identity is seeded in this companion's schema. "
        + 'Run `npm run seed:sibling-contacts -- --apply` on the fleet to seed mutual sibling contacts (bead x5t4).',
        { lever: signal.lever, firedAtMs: signal.firedAtMs },
      );
      await emitOutcome({
        correlationId: signal.correlationId,
        outcome: 'no_eligible_peer',
        reason: 'missing_or_ineligible_companion_channel_contacts',
      });
      await emitTransition(signal, {
        stage: 'final_disposition',
        outcome: 'no_eligible_peer',
        reasonCode: 'missing_or_ineligible_companion_channel_contacts',
      });
      return { kind: 'no_eligible_peer' };
    }

    // Prefer the most receptive peer; the gateway preflight/arbitration is
    // the real authority — this is only impulse targeting. Deterministic
    // order (eligibility, lease-state receptivity, then contactId) so
    // replays pick stably.
    const receptivity: Record<string, number> = {
      available: 0,
      open_to_chat: 1,
      busy: 2,
      resting: 3,
      do_not_disturb: 4,
    };
    const rank = (peer: KnownCompanionPeerAvailability): number => (
      (peer.availability.eligible ? 0 : 10)
      + (receptivity[peer.availability.lease?.state ?? ''] ?? 5)
    );
    const ranked = [...peers].sort((left, right) => (
      rank(left) - rank(right)
      || left.contactId.localeCompare(right.contactId)
    ));
    const peer = ranked[0]!;

    const result = await deps.sourceRuntime.submit({
      source: 'felt_impulse',
      peerContactId: peer.contactId,
      preferredChannel: 'dm',
      // One durable identity per fire: the lever's own sustain/cooldown is
      // the natural dedupe window, and retries of the same fire coalesce.
      sourceRecordId: signal.correlationId,
      reasonSummary: 'Felt social impulse: the affect model sustained wanting to reach out.',
      cause: { kind: 'independent' },
    });
    lastSubmittedAtMs = nowMs;
    // The durable source runtime performs the authoritative identity dedupe.
    // Retain only the most recent response-loss replay locally; do not grow an
    // unbounded process-lifetime set of content-free correlation ids.
    lastCompleted = { correlationId: signal.correlationId, candidateId: result.candidateId };
    log.info('Felt-impulse ICP initiation candidate submitted', {
      peerContactId: peer.contactId,
      peerEligible: peer.availability.eligible,
      peerLeaseState: peer.availability.lease?.state ?? null,
      outcome: result.outcome,
      status: result.status,
      candidateId: result.candidateId,
      ...(result.reasonCode ? { reasonCode: result.reasonCode } : {}),
    });
    await emitTransition(signal, {
      stage: 'candidate_submission',
      outcome: result.outcome === 'deduped' ? 'deduped' : 'submitted',
      peerContactId: peer.contactId,
      candidateId: result.candidateId,
      candidateStatus: result.status,
      ...(result.reasonCode ? { reasonCode: result.reasonCode } : {}),
    });
    await emitOutcome({
      correlationId: signal.correlationId,
      outcome: result.outcome,
      peerContactId: peer.contactId,
      candidateId: result.candidateId,
      ...(result.reasonCode ? { reason: result.reasonCode } : {}),
    });
    await emitTransition(signal, {
      stage: 'final_disposition',
      outcome: result.outcome,
      peerContactId: peer.contactId,
      candidateId: result.candidateId,
      candidateStatus: result.status,
      ...(result.reasonCode ? { reasonCode: result.reasonCode } : {}),
    });
    return { kind: 'submitted', peerContactId: peer.contactId, result };
  };

  return {
    onLeverSignal: async (signal): Promise<IcpFeltImpulseOutcome> => {
      const existing = inFlight.get(signal.correlationId);
      if (existing) return await existing;
      const pending = processSignal(signal);
      inFlight.set(signal.correlationId, pending);
      try {
        return await pending;
      } finally {
        if (inFlight.get(signal.correlationId) === pending) {
          inFlight.delete(signal.correlationId);
        }
      }
    },
  };
}
