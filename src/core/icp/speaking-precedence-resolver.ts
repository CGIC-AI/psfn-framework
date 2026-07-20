/**
 * Live ICP-over-social precedence signal transport for the speaking arbiter
 * (free-time social autonomy, jp36.5.2.1).
 *
 * The reservation phase (jp36.5.1.2) gates every room-participation candidate on
 * ICP-over-social precedence BEFORE any model call, but consumes an *injected*
 * {@link IcpSocialPrecedenceResolver}: it only knows how to turn resolved
 * {@link IcpSocialPrecedenceInput} into a decision (via the pure
 * {@link resolveIcpSocialPrecedence} primitive, jp36.5.2.2). This module is the
 * transport that fills that seam with REAL ICP signals — replacing the pre-5.2
 * no-contention default — by reading the existing ICP autonomy machinery:
 *
 *   - **availability** — the local companion's own current ICP availability
 *     lease, over the gateway-RPC broker read
 *     ({@link IcpOwnAvailabilityReader}, backed by
 *     `AgentFacingIcpAutonomyRuntime.readOwnAvailability`). A live non-open lease
 *     (`busy`/`resting`/`do_not_disturb`) yields the social turn; a
 *     missing/expired lease is open and does not block (matching the broker's
 *     "availability missing is not a DND" and the primitive's absent-lease
 *     contract).
 *   - **fenced** — whether a durable ICP turn fence (a `pending`, not-yet-
 *     finalized turn reservation in the shared fatigue store) is live for this
 *     companion ({@link IcpTurnFenceReader}); social must not race an in-flight
 *     ICP turn.
 *   - **exhausted** — whether the ICP continuation fatigue lane is at its hard
 *     stop for this companion ({@link IcpContinuationFatigueReader}).
 *
 * This does not stand up a parallel signaling system: it composes the ICP
 * broker/fatigue surfaces the runtime already has. On any conflict or race, ICP
 * dominates social (bible §8.5, adjudication §3 R2 #7).
 *
 * ## Fail closed on signal-source error (no swallowed errors)
 *
 * The resolver NEVER swallows a signal-source failure into an admitted social
 * turn. If any read rejects, the rejection propagates: the reservation phase's
 * documented seam converts a throwing precedence resolver into a suppressing
 * `gate_error` (a gated candidate never reaches appraisal). Uncertainty about
 * ICP state therefore blocks the social turn — ICP dominates on uncertainty.
 * Malformed signal values (a non-boolean fence/exhaustion) are treated the same
 * way: they throw rather than admit.
 */

import type { IcpOwnAvailabilityResult } from '../../boundary/gateway/icp-autonomy-contract.js';
import type { IcpAvailabilityState } from '../../shared/contracts/icp-autonomy.js';
import type {
  IcpSocialPrecedenceResolver,
  ReservationSignalContext,
} from '../agent/arbiter/reservation-phase.js';
import type { IcpSocialPrecedenceInput } from './social-precedence.js';

/** Reads the local companion's own current ICP availability lease/state. */
export interface IcpOwnAvailabilityReader {
  readOwnAvailability(): Promise<IcpOwnAvailabilityResult>;
}

/** The deterministic scope a live ICP signal is read for. */
export interface IcpPrecedenceScope {
  /** The local companion the reservation phase is reserving for. */
  companionId: string;
  /** The room channel the candidate was produced in. */
  channelId: string;
  nowMs: number;
}

/** Reads whether a durable ICP turn fence is live for the companion's scope. */
export interface IcpTurnFenceReader {
  isTurnFenced(scope: IcpPrecedenceScope): Promise<boolean>;
}

/** Reads whether the ICP continuation fatigue lane is at its hard stop. */
export interface IcpContinuationFatigueReader {
  isContinuationExhausted(scope: IcpPrecedenceScope): Promise<boolean>;
}

export interface IcpSpeakingPrecedenceResolverDeps {
  /** The single local companion this resolver reads ICP state for. */
  companionId: string;
  availability: IcpOwnAvailabilityReader;
  turnFence: IcpTurnFenceReader;
  continuationFatigue: IcpContinuationFatigueReader;
}

function assertNonEmpty(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`icpSpeakingPrecedence.${field} must be a non-empty string`);
  }
  return value;
}

function assertBooleanSignal(value: boolean, source: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`ICP ${source} signal must be a boolean`);
  }
  return value;
}

/**
 * The current ICP availability *state* that should feed precedence, or
 * `undefined` when there is no current lease. Only a present, currently-live
 * lease contributes a state: `control` of `missing`/`expired` means no current
 * lease — open, does not block. A live lease's declared state (including a
 * non-open `busy`/`resting`/`do_not_disturb`) is passed through for the
 * primitive to gate on.
 */
export function liveAvailabilityState(
  result: IcpOwnAvailabilityResult,
): IcpAvailabilityState | undefined {
  if (result.control === 'missing' || result.control === 'expired') {
    return undefined;
  }
  return result.lease?.state;
}

/**
 * Build the live ICP-over-social precedence resolver the reservation phase
 * consumes. Bound to one local companion; a context for a different companion
 * is a wiring fault and fails closed (throws → suppressing `gate_error`).
 */
export function createIcpSpeakingPrecedenceResolver(
  deps: IcpSpeakingPrecedenceResolverDeps,
): IcpSocialPrecedenceResolver {
  const companionId = assertNonEmpty(deps.companionId, 'companionId');
  const { availability, turnFence, continuationFatigue } = deps;

  return {
    async resolve(ctx: ReservationSignalContext): Promise<IcpSocialPrecedenceInput> {
      if (ctx.companionId !== companionId) {
        throw new Error(
          'ICP speaking precedence resolver received a context for a different companion',
        );
      }
      const scope: IcpPrecedenceScope = {
        companionId,
        channelId: ctx.channelId,
        nowMs: ctx.nowMs,
      };

      // Read every live ICP signal. Promise.all rejects if any read rejects,
      // and that rejection is deliberately NOT caught here: the reservation
      // phase fails closed to a suppressing `gate_error`, so ICP dominates on
      // uncertainty (§8.5). No signal-source error is swallowed into an
      // admitted social turn.
      const [ownAvailability, fenced, exhausted] = await Promise.all([
        availability.readOwnAvailability(),
        turnFence.isTurnFenced(scope),
        continuationFatigue.isContinuationExhausted(scope),
      ]);

      const availabilityState = liveAvailabilityState(ownAvailability);
      return {
        ...(availabilityState !== undefined ? { availabilityState } : {}),
        icpTurnFenced: assertBooleanSignal(fenced, 'turn-fence'),
        icpFatigueExhausted: assertBooleanSignal(exhausted, 'continuation-fatigue'),
      };
    },
  };
}
