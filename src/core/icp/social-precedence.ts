/**
 * ICP-over-social precedence and the unlinked-peer speaking fallback
 * (free-time social autonomy, jp36.5.2.2).
 *
 * Two deterministic decision primitives the gateway speaking arbiter (jp36.5)
 * consumes. Neither runs a model or touches the store: both are pure functions
 * so the arbiter's egress gate and the unlinked cross-installation path stay
 * legible and testable.
 *
 * ## 1. ICP-over-social precedence ({@link resolveIcpSocialPrecedence})
 *
 * ICP and ordinary-social participation are two legitimately different
 * autonomy authorities over the same companion (adjudication R2 §3.7, bible
 * §8.5 settled block). Where they contend — an in-flight ICP turn, an
 * exhausted ICP continuation lane, or a companion who has declared reduced
 * availability while the social side would grant a room turn — **ICP wins on
 * any conflict or race.** This resolves the reviewer's "one authority sees
 * `available` while the other has fenced DND/exhausted" inconsistency by
 * making ICP the tie-breaker: social participation yields.
 *
 * The three ICP-side conditions are distinct mechanisms, not one enum:
 * - **fenced** — a durable ICP turn fence is live for this scope (the
 *   `IcpConversationCorrelation` reservation fence in
 *   `regulation-reservation.ts`); social must not race an in-flight ICP turn.
 * - **exhausted** — the ICP continuation fatigue lane is at its hard stop
 *   (`fatigue_exhausted`); the shared economy has no budget left for a turn.
 * - **availability** — the local companion's own current ICP availability
 *   lease is a non-open state (`busy` / `resting` / `do_not_disturb`), the
 *   canonical case being `do_not_disturb` ("DND").
 *
 * ## 2. Unlinked-peer fallback ({@link resolveUnlinkedPeerSpeakLeast})
 *
 * Two companions on unrelated installations sharing one platform room have no
 * common arbiter to race and (by definition of *unlinked*) no ICP federation
 * link to negotiate over. There is no shared state to coordinate through, so
 * each installation decides for itself using only its own recent history:
 * **per-installation "speak least" with jitter, never dogpile-by-design**
 * (the bead's resolution of the design review's still-open option (a); see the
 * design-gap note in the bead handoff). A talkative installation defers
 * outright, and the rest stagger behind a speak-least-biased, deterministically
 * jittered delay so their sends do not fire together — the caller observes the
 * shared room and cancels once a peer has spoken.
 */

import {
  ICP_AVAILABILITY_STATES,
  type IcpAvailabilityState,
} from '../../shared/contracts/icp-autonomy.js';

// ── ICP-over-social precedence ──────────────────────────────────────────────

/** Availability states in which the companion is open to contact; all others yield social. */
const OPEN_AVAILABILITY_STATES: ReadonlySet<IcpAvailabilityState> = new Set([
  'available',
  'open_to_chat',
]);

/**
 * Why social participation must yield to ICP. `icp_availability` carries the
 * specific non-open state so telemetry can distinguish DND from busy/resting.
 */
export type IcpSocialPrecedenceBlockReason =
  | 'icp_turn_fenced'
  | 'icp_fatigue_exhausted'
  | 'icp_availability';

export interface IcpSocialPrecedenceInput {
  /**
   * The local companion's own current ICP availability state, from a current
   * lease. Omit when no current lease exists — an absent lease is treated as
   * open (does not block), matching the ICP broker's "availability missing" is
   * not itself a DND.
   */
  availabilityState?: IcpAvailabilityState;
  /**
   * True when a durable ICP turn fence (a pending reservation on the
   * `IcpConversationCorrelation` recovery fence) is live for this scope.
   */
  icpTurnFenced: boolean;
  /** True when the ICP continuation fatigue lane is at its hard stop for this scope. */
  icpFatigueExhausted: boolean;
}

export type IcpSocialPrecedenceDecision =
  /** No ICP condition contends; the arbiter may proceed with the social turn. */
  | { admitted: true }
  /** ICP dominates; social participation must yield. */
  | {
      admitted: false;
      blockedBy: IcpSocialPrecedenceBlockReason;
      /** Present only for `icp_availability`, the specific non-open state. */
      availabilityState?: Exclude<IcpAvailabilityState, 'available' | 'open_to_chat'>;
    };

function assertBoolean(value: boolean, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${field} must be a boolean`);
  }
  return value;
}

function assertOptionalAvailabilityState(
  value: IcpAvailabilityState | undefined,
  field: string,
): IcpAvailabilityState | undefined {
  if (value === undefined) return undefined;
  if (!ICP_AVAILABILITY_STATES.includes(value)) {
    throw new Error(`${field} is not a known ICP availability state: ${String(value)}`);
  }
  return value;
}

/**
 * Resolve ICP-over-social precedence. Fails closed on malformed input rather
 * than silently admitting a social turn. When several ICP conditions hold at
 * once the primary reason follows a stable order — **fenced → exhausted →
 * availability** — most-immediate race first: an in-flight ICP turn outranks a
 * hard economic stop, which outranks a declared-availability gate.
 */
export function resolveIcpSocialPrecedence(
  input: IcpSocialPrecedenceInput,
): IcpSocialPrecedenceDecision {
  const fenced = assertBoolean(input.icpTurnFenced, 'icpTurnFenced');
  const exhausted = assertBoolean(input.icpFatigueExhausted, 'icpFatigueExhausted');
  const availabilityState = assertOptionalAvailabilityState(
    input.availabilityState,
    'availabilityState',
  );

  if (fenced) {
    return { admitted: false, blockedBy: 'icp_turn_fenced' };
  }
  if (exhausted) {
    return { admitted: false, blockedBy: 'icp_fatigue_exhausted' };
  }
  if (availabilityState !== undefined && !OPEN_AVAILABILITY_STATES.has(availabilityState)) {
    return {
      admitted: false,
      blockedBy: 'icp_availability',
      // Narrowed above: any state not in the open set is a non-open state.
      availabilityState: availabilityState as Exclude<
        IcpAvailabilityState,
        'available' | 'open_to_chat'
      >,
    };
  }
  return { admitted: true };
}

// ── Unlinked-peer speak-least fallback ──────────────────────────────────────

// Well-known FNV-1a 32-bit constants (algorithmic, not tuning): a stable,
// dependency-free hash so the jitter is reproducible and distinct per
// installation without any shared coordination state.
const FNV_OFFSET_BASIS_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;

function fnv1a32(input: string): number {
  let hash = FNV_OFFSET_BASIS_32;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME_32);
  }
  return hash >>> 0;
}

/**
 * Tuning for the unlinked-peer fallback. Supplied by the caller (the arbiter),
 * never module-owned, so this primitive stays settings-free and the owner-file
 * contract keeps sole authority over where the numbers live.
 */
export interface UnlinkedPeerSpeakLeastConfig {
  /** Floor delay before any unlinked installation may speak (ms, >= 0). */
  baseDelayMs: number;
  /**
   * Added delay per recent self-send in the window (ms, >= 0): the speak-least
   * bias, so the installation that has spoken least waits least and speaks
   * first while noisier ones fall behind it.
   */
  perRecentSendDelayMs: number;
  /**
   * Deterministic per-installation stagger window (ms, >= 1). Distinct
   * installations land at distinct offsets in [0, jitterWindowMs) so their
   * sends do not fire together.
   */
  jitterWindowMs: number;
  /**
   * Recent-self-send count at or above which this installation defers outright
   * (>= 1). This is the "never dogpile-by-design" bias: a talkative
   * installation steps back rather than piling on.
   */
  deferAtRecentSends: number;
}

export interface UnlinkedPeerSpeakLeastInput {
  /** This installation's stable identity (non-empty, trimmed). */
  installationId: string;
  /** The triggering room event; seeds the deterministic jitter (non-empty, trimmed). */
  roomEventId: string;
  /** This installation's own recent sends in the window (>= 0 integer). */
  recentSelfSendCount: number;
}

export type UnlinkedPeerSpeakLeastDecision =
  /** This installation yields; it has already spoken enough recently. */
  | { decision: 'defer'; reason: 'speak_least_saturated' }
  /**
   * This installation may speak after `delayMs`. The caller waits, then cancels
   * if a peer has meanwhile spoken in the shared room (there is no shared mutex
   * when unlinked — the stagger minimizes, it does not forbid, a race).
   */
  | { decision: 'speak_after'; delayMs: number; jitterMs: number };

function assertNonEmptyId(value: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error(`${field} must be a non-empty trimmed string`);
  }
  return value;
}

function assertNonNegativeInteger(value: number, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function assertNonNegativeFinite(value: number, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite number >= 0`);
  }
  return value;
}

function validateConfig(config: UnlinkedPeerSpeakLeastConfig): UnlinkedPeerSpeakLeastConfig {
  const baseDelayMs = assertNonNegativeFinite(config.baseDelayMs, 'baseDelayMs');
  const perRecentSendDelayMs = assertNonNegativeFinite(
    config.perRecentSendDelayMs,
    'perRecentSendDelayMs',
  );
  const jitterWindowMs = assertNonNegativeFinite(config.jitterWindowMs, 'jitterWindowMs');
  if (jitterWindowMs < 1) {
    throw new Error('jitterWindowMs must be >= 1');
  }
  const deferAtRecentSends = assertNonNegativeInteger(
    config.deferAtRecentSends,
    'deferAtRecentSends',
  );
  if (deferAtRecentSends < 1) {
    throw new Error('deferAtRecentSends must be >= 1');
  }
  return { baseDelayMs, perRecentSendDelayMs, jitterWindowMs, deferAtRecentSends };
}

/**
 * Resolve the unlinked-peer speaking fallback for one installation. Pure and
 * deterministic: the same inputs always yield the same decision, so two
 * installations never negotiate — each computes its own staggered slot from its
 * own history. Fails closed on malformed config or input.
 *
 * - At or above `deferAtRecentSends`, the installation defers (speak-least
 *   saturation): the structural "never dogpile-by-design" guard.
 * - Otherwise it may speak after `baseDelayMs + recentSelfSendCount *
 *   perRecentSendDelayMs + jitter`, where jitter is a stable hash of
 *   `(installationId, roomEventId)` in [0, jitterWindowMs). The speak-least
 *   term orders quieter installations ahead of noisier ones; the jitter breaks
 *   ties between equally-quiet installations so their sends do not collide.
 */
export function resolveUnlinkedPeerSpeakLeast(
  config: UnlinkedPeerSpeakLeastConfig,
  input: UnlinkedPeerSpeakLeastInput,
): UnlinkedPeerSpeakLeastDecision {
  const { baseDelayMs, perRecentSendDelayMs, jitterWindowMs, deferAtRecentSends } =
    validateConfig(config);
  const installationId = assertNonEmptyId(input.installationId, 'installationId');
  const roomEventId = assertNonEmptyId(input.roomEventId, 'roomEventId');
  const recentSelfSendCount = assertNonNegativeInteger(
    input.recentSelfSendCount,
    'recentSelfSendCount',
  );

  if (recentSelfSendCount >= deferAtRecentSends) {
    return { decision: 'defer', reason: 'speak_least_saturated' };
  }

  // NUL-delimited so distinct (installationId, roomEventId) pairs cannot alias.
  const jitterMs = fnv1a32(`${installationId}\u0000${roomEventId}`) % jitterWindowMs;
  const delayMs = baseDelayMs + recentSelfSendCount * perRecentSendDelayMs + jitterMs;
  return { decision: 'speak_after', delayMs, jitterMs };
}
