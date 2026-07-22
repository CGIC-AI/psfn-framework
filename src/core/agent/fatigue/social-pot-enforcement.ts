/**
 * Draw-cap enforcement with ICP priority (design bible §12.6, adjudication
 * §3.8). This is the policy layer that composes the atomic {@link SocialPotPort}
 * primitive (jp36.4.1.1) into the settled social-pot economy:
 *
 * - **Per-channel draw cap.** Ordinary group-social spend for one channel may
 *   consume no more than a bounded fraction (`perChannelDrawFraction`, ~a third)
 *   of the pot remaining at draw time, so one busy room cannot starve the
 *   others and a multi-room argument drains the shared pot and stops.
 * - **ICP continuation draws at priority.** ICP continuation draws against the
 *   *same* shared pot but is not bound by the per-channel fraction cap
 *   (consistent with ICP-dominates-social); it is limited only by the remaining
 *   balance.
 * - **Human-triggered turns do not charge the pot** (existing invariant). Only
 *   companion-triggered (machine-intelligence) continuation draws from the pot;
 *   a human-triggered turn is never routed to the store, so the pot is left
 *   untouched.
 *
 * The cap is enforced atomically inside the store's advisory-locked draw
 * transaction (`maxDrawFraction`), not by a read-then-draw in this layer, so
 * concurrent sibling-channel draws cannot each cap against a stale balance.
 */

import type { FatigueSocialPotConfig } from '../../../shared/contracts/charge-policy.js';
import type { FatiguePolicyTriggerAuthorKind } from './policy.js';
import type {
  SocialPotConfig,
  SocialPotDrawInput,
  SocialPotPort,
  SocialPotSnapshot,
} from './social-pot.js';

/**
 * Which lane a draw belongs to. Both draw against the one shared per-companion
 * pot; the lane only decides whether the per-channel fraction cap applies.
 */
export type SocialPotDrawLane = 'group_social' | 'icp_continuation';

export interface SocialPotEnforcementRequest {
  companionId: string;
  /** ICP continuation draws at priority (uncapped); group-social is capped. */
  lane: SocialPotDrawLane;
  /**
   * The kind of author that triggered this turn. Only `machine_intelligence`
   * (companion-triggered continuation) charges the pot; human-, system-, and
   * unknown-triggered turns are uncharged and never touch the store.
   */
  triggerAuthorKind: FatiguePolicyTriggerAuthorKind;
  /** Requested draw amount (positive, finite), in charge-policy units. */
  amount: number;
  nowMs: number;
}

export type SocialPotEnforcementOutcome =
  /** The full amount was drawn from the pot. */
  | 'drawn'
  /** Refused: the amount exceeds the per-channel share of the remaining pot. */
  | 'capped'
  /** Refused: the pot balance is below the requested amount. */
  | 'insufficient'
  /** Not charged: a human/non-autonomous trigger never draws from the pot. */
  | 'uncharged';

export type SocialPotUnchargedReason = 'human_triggered' | 'non_autonomous_trigger';

export interface SocialPotEnforcementDecision {
  outcome: SocialPotEnforcementOutcome;
  lane: SocialPotDrawLane;
  requested: number;
  /** Amount actually removed from the pot (0 unless outcome is `drawn`). */
  drawn: number;
  /** Present only when the turn was uncharged (no store operation ran). */
  unchargedReason?: SocialPotUnchargedReason;
  /** Pot snapshots around the draw; absent when the turn was uncharged. */
  before?: SocialPotSnapshot;
  after?: SocialPotSnapshot;
}

function requirePositiveFiniteAmount(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error('socialPotEnforcement.amount must be a finite number > 0');
  }
  return value;
}

const KNOWN_LANES: readonly SocialPotDrawLane[] = ['group_social', 'icp_continuation'];

function assertKnownLane(lane: SocialPotDrawLane): SocialPotDrawLane {
  // Runtime guard against a caller passing an unknown lane through a loosened
  // type: fail closed rather than silently defaulting to an uncapped draw.
  if (!KNOWN_LANES.includes(lane)) {
    throw new Error(`socialPotEnforcement.lane is not a known lane: ${String(lane)}`);
  }
  return lane;
}

/** The store consumes only the regeneration subset of the owner-file config. */
function toStoreConfig(config: FatigueSocialPotConfig): SocialPotConfig {
  return {
    capUnits: config.capUnits,
    regenerationTickMs: config.regenerationTickMs,
    regenerationUnitsPerTick: config.regenerationUnitsPerTick,
  };
}

/**
 * Enforce a single social-pot draw. Fails closed: an unknown lane or invalid
 * amount throws rather than silently spending, and any non-`machine_intelligence`
 * trigger is refused before the pot is ever read.
 */
export async function enforceSocialPotDraw(
  port: Pick<SocialPotPort, 'draw'>,
  config: FatigueSocialPotConfig,
  request: SocialPotEnforcementRequest,
): Promise<SocialPotEnforcementDecision> {
  const lane = assertKnownLane(request.lane);
  const requested = requirePositiveFiniteAmount(request.amount);

  // Human-uncharged invariant (§12.6): only companion-triggered continuation
  // draws from the pot. Refuse before touching the store so the pot balance is
  // provably untouched for human/system/unknown triggers.
  if (request.triggerAuthorKind !== 'machine_intelligence') {
    return {
      outcome: 'uncharged',
      lane,
      requested,
      drawn: 0,
      unchargedReason: request.triggerAuthorKind === 'human'
        ? 'human_triggered'
        : 'non_autonomous_trigger',
    };
  }

  const drawInput: SocialPotDrawInput = {
    companionId: request.companionId,
    nowMs: request.nowMs,
    amount: requested,
    config: toStoreConfig(config),
    // ICP continuation draws at priority: uncapped, bounded only by the pot.
    // Group-social is throttled to its per-channel share of the remaining pot.
    ...(lane === 'group_social'
      ? { maxDrawFraction: config.perChannelDrawFraction }
      : {}),
  };

  const result = await port.draw(drawInput);
  return {
    outcome: result.outcome,
    lane,
    requested,
    drawn: result.drawn,
    before: result.before,
    after: result.after,
  };
}

/**
 * Return a previously enforced draw to the pot (qgqw.3). For the egress-lease
 * phase only: when the draw succeeded but the fenced lease was never acquired,
 * no durable record carries the charge, so the units are credited back (clamped
 * at the cap by the store). Fails closed like the draw: an invalid amount
 * throws rather than silently crediting.
 */
export async function refundSocialPotDraw(
  port: Pick<SocialPotPort, 'refund'>,
  config: FatigueSocialPotConfig,
  request: { companionId: string; amount: number; nowMs: number },
): Promise<SocialPotSnapshot> {
  const amount = requirePositiveFiniteAmount(request.amount);
  return await port.refund({
    companionId: request.companionId,
    nowMs: request.nowMs,
    amount,
    config: toStoreConfig(config),
  });
}
