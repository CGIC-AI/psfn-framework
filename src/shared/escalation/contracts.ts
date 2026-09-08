// ── Human escalation control plane: contracts (bead psfn-framework-bznbn) ──
//
// PSFN asks a human for attention from several independent places: the operator
// alert dispatcher pages about runtime incidents, the confirmation queue holds
// approval envelopes, CogSec holds quarantined intake behind its own
// double-confirmed ceremony. Each of those owns its evidence and its decision
// rules, and should keep owning them. What none of them owns today is the OUTER
// control plane — the part that says "this needs a human", records that it was
// raised, decides where the notice goes, remembers whether a human answered,
// and refuses to page twice for the same thing.
//
// This module owns that outer shape and nothing else:
//
//   * A closed vocabulary of escalation KINDS. An unknown kind is rejected at
//     the raise seam, so a caller cannot invent an unrouted attention channel.
//   * A closed vocabulary of SINKS, and a routing policy — owner-file owned —
//     that maps each kind to exactly one sink and one cooldown. A kind with no
//     routing entry, or a routing entry naming an unknown sink, fails the owner
//     file closed at load rather than discovering it at 3am.
//   * Two keys with two different jobs. `dedupeKey` names the underlying
//     CONDITION and is what a human resolves; `idempotencyKey` names one
//     DELIVERY ATTEMPT about that condition and is what makes a replay a no-op.
//     Conflating them is the bug that turns a restart into an alert storm.
//   * Explicit human resolution states with a closed reason vocabulary.
//
// It is CONTENT-FREE by construction, in the same sense and by the same means
// as the health-event envelope it reuses: the owner, severity and evidence
// types come straight from `shared/contracts/health-event.ts`, every other
// string field is either a closed vocabulary member, a UUID, a Garden route
// path, or a lowercase label token. There is no free-text field on the record,
// so nothing that is persisted or logged here can carry conversation content,
// an error string, or a private identifier.
//
// The one thing that is NOT content-free is the rendered notice a caller hands
// to `raise()`. That is deliberate and bounded: the plane never inspects it,
// never persists it, and never logs it — it exists only to be handed to the
// sink. Its type is a caller-chosen type parameter precisely so this module
// cannot grow an opinion about its contents.
//
// Non-goals: this is not a domain state machine. Domain persistence, evidence,
// stale-state validation, execution and rollback stay with the domain that
// raised the escalation. The plane records that a human is needed and what a
// human said; it never executes a domain decision.

import type {
  HealthEventEvidence,
  HealthEventOwner,
  HealthEventSeverity,
} from '../contracts/health-event.js';
import { isRecord } from '../utils/types.js';
import { requireUuid } from '../utils/uuid.js';

/** Envelope revision persisted with every ledger row. */
export const HUMAN_ESCALATION_SCHEMA_VERSION = 1;

/**
 * The attention channels this runtime governs.
 *
 * `runtime_incident` is the only kind with a producer today: the deduplicated
 * incident alert path routes through the plane. The other two name the surfaces
 * this bead exists to unify — they carry routing policy so adopting the plane
 * is a wiring change rather than a vocabulary change, and both route to
 * `garden_only` by default so adoption cannot silently start paging an operator
 * for a queue that has never paged anyone.
 */
export const HUMAN_ESCALATION_KINDS = [
  'runtime_incident',
  'operator_confirmation',
  'cogsec_quarantine',
] as const;

export type HumanEscalationKind = typeof HUMAN_ESCALATION_KINDS[number];

function isHumanEscalationKind(value: unknown): value is HumanEscalationKind {
  return typeof value === 'string'
    && (HUMAN_ESCALATION_KINDS as readonly string[]).includes(value);
}

/**
 * Where a raised escalation goes.
 *
 * `operator_alert` is the existing gateway dispatcher seam, reached through an
 * adapter rather than reimplemented. `garden_only` sends nothing at all: the
 * durable ledger row IS the notice, which is exactly the current behaviour of
 * every queue that waits to be looked at rather than paging.
 */
export const HUMAN_ESCALATION_SINKS = [
  'operator_alert',
  'garden_only',
] as const;

export type HumanEscalationSinkId = typeof HUMAN_ESCALATION_SINKS[number];

export function isHumanEscalationSinkId(value: unknown): value is HumanEscalationSinkId {
  return typeof value === 'string'
    && (HUMAN_ESCALATION_SINKS as readonly string[]).includes(value);
}

/**
 * Lifecycle of one escalation as far as a HUMAN is concerned.
 *
 * `open` is the only state the runtime can set. Everything else is a person
 * saying something, which is why every non-open state carries a reason: an
 * escalation that left the queue without a recorded reason is indistinguishable
 * from one that was lost.
 */
export const HUMAN_ESCALATION_STATES = [
  'open',
  'acknowledged',
  'resolved',
  'dismissed',
] as const;

export type HumanEscalationState = typeof HUMAN_ESCALATION_STATES[number];

export function isHumanEscalationState(value: unknown): value is HumanEscalationState {
  return typeof value === 'string'
    && (HUMAN_ESCALATION_STATES as readonly string[]).includes(value);
}

/** The states a person may move an escalation into. */
export const HUMAN_ESCALATION_RESOLUTION_STATES = [
  'acknowledged',
  'resolved',
  'dismissed',
] as const;

export type HumanEscalationResolutionState = typeof HUMAN_ESCALATION_RESOLUTION_STATES[number];

export function isHumanEscalationResolutionState(
  value: unknown,
): value is HumanEscalationResolutionState {
  return typeof value === 'string'
    && (HUMAN_ESCALATION_RESOLUTION_STATES as readonly string[]).includes(value);
}

/**
 * Why a person moved an escalation. One vocabulary across all three resolution
 * states on purpose: an operator says why they acknowledged for the same reason
 * they say why they dismissed, and a shared vocabulary keeps the Garden filter
 * and the telemetry counter honest across kinds.
 */
export const HUMAN_ESCALATION_RESOLUTION_REASONS = [
  'handled',
  'mitigated',
  'investigating',
  'not_actionable',
  'duplicate',
  'expected',
] as const;

export type HumanEscalationResolutionReason =
  typeof HUMAN_ESCALATION_RESOLUTION_REASONS[number];

export function isHumanEscalationResolutionReason(
  value: unknown,
): value is HumanEscalationResolutionReason {
  return typeof value === 'string'
    && (HUMAN_ESCALATION_RESOLUTION_REASONS as readonly string[]).includes(value);
}

/**
 * Who recorded a resolution, as a closed vocabulary rather than an identity.
 *
 * The concrete principal belongs in the Garden audit timeline, which already
 * carries actor identity under its own retention. Keeping the ledger to an
 * actor CLASS is what lets the whole table stay content-free.
 */
const HUMAN_ESCALATION_ACTORS = [
  'operator',
  'fleet_principal',
  'system',
] as const;

export type HumanEscalationActor = typeof HUMAN_ESCALATION_ACTORS[number];

function isHumanEscalationActor(value: unknown): value is HumanEscalationActor {
  return typeof value === 'string'
    && (HUMAN_ESCALATION_ACTORS as readonly string[]).includes(value);
}

/** What one delivery attempt did. */
export type HumanEscalationDeliveryOutcome =
  /** A sink accepted the notice. */
  | 'delivered'
  /** Routing said `garden_only`: the ledger row is the notice. */
  | 'recorded'
  /** The routed sink is not wired in this process yet. */
  | 'no_sink'
  /** The sink exists but has no configured destination. */
  | 'unconfigured'
  /** The sink was reached and refused or threw. */
  | 'delivery_failed'
  /** A cooldown for this condition suppressed the notice. */
  | 'suppressed';

/**
 * Structural bounds on the identifiers and label tokens the plane accepts.
 *
 * These are CONTRACT shapes, not tuning: relaxing any of them would let free
 * text into a table whose whole guarantee is that it holds none. They live
 * beside the vocabularies they guard rather than in an owner file for exactly
 * that reason — an operator may choose where an escalation goes, never whether
 * a label may carry a sentence.
 */
const LABEL_TOKEN_PATTERN = /^[a-z][a-z0-9_]*$/u;
const DEDUPE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u;
const DETAIL_PATH_PATTERN = /^\/[a-z0-9/-]*$/u;

export const HUMAN_ESCALATION_LIMITS = Object.freeze({
  maxLabels: 8,
  maxLabelChars: 64,
  maxKeyChars: 256,
  maxDetailPathChars: 128,
  maxListLimit: 200,
});

function requireBounded(value: unknown, field: string, max: number, pattern: RegExp): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new Error(
      `Human escalation ${field} must be a non-empty string of at most ${String(max)} characters`,
    );
  }
  if (!pattern.test(value)) {
    throw new Error(`Human escalation ${field} has a forbidden shape: ${JSON.stringify(value)}`);
  }
  return value;
}

const requireEscalationUuid = (value: unknown, field: string): string =>
  requireUuid(value, `Human escalation ${field}`);

function requireEpochMs(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Human escalation ${field} must be a non-negative safe integer`);
  }
  return value as number;
}

function requireLabels(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error('Human escalation labels must be an array');
  }
  if (value.length > HUMAN_ESCALATION_LIMITS.maxLabels) {
    throw new Error(
      `Human escalation labels must hold at most ${String(HUMAN_ESCALATION_LIMITS.maxLabels)} tokens`,
    );
  }
  const labels = value.map((entry, index) => requireBounded(
    entry,
    `labels[${String(index)}]`,
    HUMAN_ESCALATION_LIMITS.maxLabelChars,
    LABEL_TOKEN_PATTERN,
  ));
  if (new Set(labels).size !== labels.length) {
    throw new Error('Human escalation labels must be distinct');
  }
  return Object.freeze(labels);
}

/**
 * Evidence is the health envelope's own bounded map: enumerated keys, numeric
 * or boolean values. Reused rather than redeclared so an escalation cannot
 * carry evidence the health stream would have refused.
 */
function requireEvidence(value: unknown): HealthEventEvidence {
  if (!isRecord(value)) {
    throw new Error('Human escalation evidence must be an object');
  }
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'number' && typeof entry !== 'boolean') {
      throw new Error(`Human escalation evidence.${key} must be a number or boolean`);
    }
    if (typeof entry === 'number' && !Number.isFinite(entry)) {
      throw new Error(`Human escalation evidence.${key} must be finite`);
    }
  }
  return value as HealthEventEvidence;
}

function requireOwner(value: unknown): HealthEventOwner {
  if (!isRecord(value)) {
    throw new Error('Human escalation owner must be an object');
  }
  if (value.kind === 'system') return { kind: 'system' };
  if (value.kind === 'companion' && typeof value.companionId === 'string') {
    return value as HealthEventOwner;
  }
  throw new Error('Human escalation owner must be system-owned or name one companion');
}

/**
 * What a domain hands the plane when it needs a human.
 *
 * `TNotice` is the caller's rendered notification. The plane is generic over it
 * so that it structurally cannot read, store, or log the only field that is not
 * content-free.
 */
export interface HumanEscalationRaiseRequest<TNotice> {
  kind: HumanEscalationKind;
  severity: HealthEventSeverity;
  owner: HealthEventOwner;
  /**
   * Names the underlying condition. Every raise sharing this key under one kind
   * is the same escalation: it is what a human resolves, and what a cooldown
   * throttles.
   */
  dedupeKey: string;
  /**
   * Names one delivery attempt. It must vary per intended notice — a stable key
   * would silently swallow the second page about a condition that is still
   * going — and a repeat of a key already in the ledger is a replay that is
   * recorded and never re-dispatched.
   */
  idempotencyKey: string;
  /** Opaque server-derived reference into the raising domain's own store. */
  sourceRef: string;
  /** Lowercase vocabulary tokens (a code, a family) an operator can scan. */
  labels: readonly string[];
  evidence: HealthEventEvidence;
  /** Garden route that shows this escalation's domain-owned detail. */
  detailPath: string;
  raisedAtMs: number;
  /** Rendered by the caller, handed to the sink, never persisted or logged. */
  notice: TNotice;
}

/** The validated, content-free half of a raise request. */
export interface HumanEscalationFacts {
  kind: HumanEscalationKind;
  severity: HealthEventSeverity;
  owner: HealthEventOwner;
  dedupeKey: string;
  sourceRef: string;
  labels: readonly string[];
  evidence: HealthEventEvidence;
  detailPath: string;
  raisedAtMs: number;
}

/**
 * Fail-closed admission for one raise. Everything the ledger will persist is
 * proved here, at the seam, so a malformed escalation is a throw at the caller
 * rather than a row nobody can render.
 */
export function validateHumanEscalationRaise<TNotice>(
  request: HumanEscalationRaiseRequest<TNotice>,
): { facts: HumanEscalationFacts; idempotencyKey: string } {
  if (!isHumanEscalationKind(request.kind)) {
    throw new Error(
      `Unknown human escalation kind ${JSON.stringify(request.kind)}; `
      + `expected one of: ${HUMAN_ESCALATION_KINDS.join(', ')}`,
    );
  }
  const severity = request.severity;
  if (typeof severity !== 'string') {
    throw new Error('Human escalation severity must be a health-event severity');
  }
  return {
    idempotencyKey: requireBounded(
      request.idempotencyKey,
      'idempotencyKey',
      HUMAN_ESCALATION_LIMITS.maxKeyChars,
      IDEMPOTENCY_KEY_PATTERN,
    ),
    facts: {
      kind: request.kind,
      severity,
      owner: requireOwner(request.owner),
      dedupeKey: requireBounded(
        request.dedupeKey,
        'dedupeKey',
        HUMAN_ESCALATION_LIMITS.maxKeyChars,
        DEDUPE_KEY_PATTERN,
      ),
      sourceRef: requireBounded(
        request.sourceRef,
        'sourceRef',
        HUMAN_ESCALATION_LIMITS.maxKeyChars,
        DEDUPE_KEY_PATTERN,
      ),
      labels: requireLabels(request.labels),
      evidence: requireEvidence(request.evidence),
      detailPath: requireBounded(
        request.detailPath,
        'detailPath',
        HUMAN_ESCALATION_LIMITS.maxDetailPathChars,
        DETAIL_PATH_PATTERN,
      ),
      raisedAtMs: requireEpochMs(request.raisedAtMs, 'raisedAtMs'),
    },
  };
}

/** How a human answered. Absent while the escalation is open. */
export interface HumanEscalationResolution {
  state: HumanEscalationResolutionState;
  reason: HumanEscalationResolutionReason;
  actor: HumanEscalationActor;
  resolvedAtMs: number;
}

/** One escalation as the ledger holds it. Content-free in every field. */
export interface HumanEscalationRecord {
  schemaVersion: number;
  escalationId: string;
  kind: HumanEscalationKind;
  severity: HealthEventSeverity;
  owner: HealthEventOwner;
  dedupeKey: string;
  sourceRef: string;
  labels: readonly string[];
  evidence: HealthEventEvidence;
  detailPath: string;
  state: HumanEscalationState;
  resolution: HumanEscalationResolution | null;
  raisedAtMs: number;
  /** Newest raise about this condition, which may be long after the first. */
  lastRaisedAtMs: number;
  /** Newest attempt that actually reached a sink; null while never notified. */
  lastNotifiedAtMs: number | null;
  /** Raises recorded against this condition, including suppressed ones. */
  raiseCount: number;
}

/** One recorded delivery attempt, keyed by its caller-supplied idempotency key. */
export interface HumanEscalationAttempt {
  idempotencyKey: string;
  escalationId: string;
  sink: HumanEscalationSinkId;
  outcome: HumanEscalationDeliveryOutcome;
  attemptedAtMs: number;
}

/**
 * The answer to an attempt claim. `claimed: false` carries the attempt that
 * already owns the key, so the loser of a race can report the winner's outcome
 * as a replay instead of dispatching a second notice.
 */
export type HumanEscalationAttemptClaim =
  | { claimed: true }
  | { claimed: false; existing: HumanEscalationAttempt };

/**
 * Re-validate a row read back from storage. A row written by a newer schema,
 * hand-edited, or corrupted fails here rather than reaching an operator surface
 * as a half-typed object.
 */
export function validateHumanEscalationRecord(value: unknown): HumanEscalationRecord {
  if (!isRecord(value)) {
    throw new Error('Human escalation record must be an object');
  }
  if (!isHumanEscalationState(value.state)) {
    throw new Error(`Unknown human escalation state ${JSON.stringify(value.state)}`);
  }
  if (!isHumanEscalationKind(value.kind)) {
    throw new Error(`Unknown human escalation kind ${JSON.stringify(value.kind)}`);
  }
  const resolution = value.resolution;
  if (value.state === 'open') {
    if (resolution !== null) {
      throw new Error('An open human escalation must carry no resolution');
    }
  } else {
    if (!isRecord(resolution)
      || !isHumanEscalationResolutionState(resolution.state)
      || resolution.state !== value.state
      || !isHumanEscalationResolutionReason(resolution.reason)
      || !isHumanEscalationActor(resolution.actor)) {
      throw new Error(
        `Human escalation in state ${value.state} must carry a matching resolution`,
      );
    }
    requireEpochMs(resolution.resolvedAtMs, 'resolution.resolvedAtMs');
  }
  requireEscalationUuid(value.escalationId, 'escalationId');
  requireLabels(value.labels);
  requireEvidence(value.evidence);
  requireOwner(value.owner);
  requireBounded(
    value.dedupeKey,
    'dedupeKey',
    HUMAN_ESCALATION_LIMITS.maxKeyChars,
    DEDUPE_KEY_PATTERN,
  );
  requireBounded(
    value.detailPath,
    'detailPath',
    HUMAN_ESCALATION_LIMITS.maxDetailPathChars,
    DETAIL_PATH_PATTERN,
  );
  requireEpochMs(value.raisedAtMs, 'raisedAtMs');
  requireEpochMs(value.lastRaisedAtMs, 'lastRaisedAtMs');
  if (value.lastNotifiedAtMs !== null) {
    requireEpochMs(value.lastNotifiedAtMs, 'lastNotifiedAtMs');
  }
  if (!Number.isSafeInteger(value.raiseCount) || (value.raiseCount as number) < 1) {
    throw new Error('Human escalation raiseCount must be a positive safe integer');
  }
  return value as unknown as HumanEscalationRecord;
}

/**
 * The transitions a person may make.
 *
 * Deliberately one-way past a terminal state: an escalation that was resolved
 * is not re-opened by another human clicking again — only the RUNTIME reopens
 * it, by raising the same condition once more, because the runtime is the only
 * authority on whether the condition is still true.
 */
const ALLOWED_HUMAN_TRANSITIONS: Readonly<
  Record<HumanEscalationState, readonly HumanEscalationResolutionState[]>
> = Object.freeze({
  open: ['acknowledged', 'resolved', 'dismissed'],
  acknowledged: ['resolved', 'dismissed'],
  resolved: [],
  dismissed: [],
});

export interface HumanEscalationTransitionRejection {
  code: 'illegal_transition';
  message: string;
}

/**
 * Admit or reject a human state change. Returns the rejection rather than
 * throwing so the Garden route can answer 409 without unwinding a stack.
 */
export function checkHumanEscalationTransition(
  from: HumanEscalationState,
  to: HumanEscalationResolutionState,
): HumanEscalationTransitionRejection | null {
  if (ALLOWED_HUMAN_TRANSITIONS[from].includes(to)) return null;
  return {
    code: 'illegal_transition',
    message: `A human escalation in state ${from} cannot be moved to ${to}`,
  };
}

/** Query for the operator attention surface. */
export interface HumanEscalationListQuery {
  /** Omitted means every state; the Garden surface defaults to open only. */
  states?: readonly HumanEscalationState[];
  limit: number;
}

/**
 * What bounds the durable ledger (bead psfn-framework-yu03d).
 *
 * The health-event stream is a ring: every write prunes past its cap, because
 * an observation nobody read is safe to lose. An escalation is not. A row here
 * is a question this runtime asked a person, so the bound cannot be a plain
 * ring — evicting an OPEN escalation would silently retract the question.
 *
 * The bound is therefore split along exactly that line:
 *
 *   * `resolvedRetentionMs` and `maxResolvedRowsPerKind` bound the ANSWERED
 *     half. Both evictions are restricted in SQL to rows that are not open, so
 *     an unanswered escalation is structurally not a candidate for either.
 *   * `maxAttemptsPerEscalation` bounds the delivery-attempt ledger a
 *     long-running condition accumulates, newest-first.
 *   * `maxOpenRowsPerKind` bounds nothing by itself, and says so: it is the
 *     count at which the ledger reports content-free saturation onto the health
 *     stream. There is no eviction behind it, because the only way to shrink
 *     the open half is for a human to answer.
 *
 * The values are owner-file owned (`scheduler.json` `humanEscalation.retention`)
 * and required: a ledger that persists what a runtime asked a human must never
 * come up without a declared bound.
 */
export interface HumanEscalationLedgerBounds {
  /** How long an answered escalation stays readable before it is evicted. */
  resolvedRetentionMs: number;
  /** Newest answered escalations kept per kind; open rows are never evicted. */
  maxResolvedRowsPerKind: number;
  /** Newest recorded delivery attempts kept per escalation. */
  maxAttemptsPerEscalation: number;
  /** Open rows per kind at which the ledger reports saturation; never evicts. */
  maxOpenRowsPerKind: number;
}

/**
 * What one prune reported. Content-free: counts and the cap that was compared
 * against, never a kind name, a dedupe key, or an owner.
 */
export interface HumanEscalationLedgerSaturation {
  kind: HumanEscalationKind;
  openRows: number;
  maxOpenRowsPerKind: number;
}

/**
 * Fail-closed admission for the owner-file bounds, taken wherever a ledger is
 * constructed. Mirrors the health stream's positive-cap guard: there is no
 * built-in fallback, so a missing or nonsensical bound is a startup failure.
 */
export function requireHumanEscalationLedgerBounds(
  bounds: HumanEscalationLedgerBounds,
): HumanEscalationLedgerBounds {
  if (!isRecord(bounds)) {
    throw new Error('Human escalation ledger requires the owner-file retention bounds');
  }
  for (const field of [
    'resolvedRetentionMs',
    'maxResolvedRowsPerKind',
    'maxAttemptsPerEscalation',
    'maxOpenRowsPerKind',
  ] as const) {
    const value = bounds[field];
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(
        `Human escalation ledger requires a positive owner-file ${field}`,
      );
    }
  }
  return {
    resolvedRetentionMs: bounds.resolvedRetentionMs,
    maxResolvedRowsPerKind: bounds.maxResolvedRowsPerKind,
    maxAttemptsPerEscalation: bounds.maxAttemptsPerEscalation,
    maxOpenRowsPerKind: bounds.maxOpenRowsPerKind,
  };
}

/**
 * Durable ledger seam. Postgres implements it in production; the in-memory
 * implementation beside it exists for tests and for the control plane's own
 * conformance suite, never as a runtime fallback — a missing ledger is a
 * startup failure, not a degraded mode.
 */
export interface HumanEscalationLedgerPort {
  /**
   * Create or reopen the escalation for `(kind, dedupeKey)` and return the row
   * as it now stands. Reopening clears any resolution: the runtime restating a
   * condition outranks a human having previously closed it.
   */
  openOrReopen(facts: HumanEscalationFacts): Promise<HumanEscalationRecord>;
  /**
   * The escalation for one condition, without opening or touching it. It is how
   * a caller learns how many times this runtime has already raised the
   * condition — which is the only counter that survives a restart, and
   * therefore the only safe source for a per-attempt idempotency key.
   */
  findByCondition(kind: HumanEscalationKind, dedupeKey: string): Promise<HumanEscalationRecord | null>;
  findAttempt(idempotencyKey: string): Promise<HumanEscalationAttempt | null>;
  /**
   * Atomically take ownership of one delivery attempt BEFORE anything is
   * dispatched for it.
   *
   * This is the only thing standing between two overlapping raises about one
   * new condition and two operator pages. The replay lookup above is a
   * fast path, not a guard: two callers can both read no attempt, both open the
   * same escalation, and both reach the sink. Whoever wins this insert owns the
   * dispatch; every other caller is told the attempt already exists and
   * dispatches nothing.
   *
   * The claimed row carries a PROVISIONAL outcome, settled by
   * {@link HumanEscalationLedgerPort.settleAttempt} once the sink answers. The
   * provisional value is the fail-closed one — a process that dies mid-dispatch
   * leaves a row that does not claim a delivery it cannot prove.
   */
  claimAttempt(attempt: HumanEscalationAttempt): Promise<HumanEscalationAttemptClaim>;
  /** Replace a claimed attempt's provisional outcome with what the sink said. */
  settleAttempt(
    idempotencyKey: string,
    outcome: HumanEscalationDeliveryOutcome,
  ): Promise<void>;
  /** Stamp the newest attempt that actually reached a sink. */
  markNotified(escalationId: string, notifiedAtMs: number): Promise<void>;
  list(query: HumanEscalationListQuery): Promise<HumanEscalationRecord[]>;
  /**
   * Content-free telemetry: how many escalations sit in each state right now.
   * Computed in the store rather than from a bounded list so the operator
   * surface never has to imply a total from a page of rows.
   */
  countByState(): Promise<Readonly<Record<HumanEscalationState, number>>>;
  getById(escalationId: string): Promise<HumanEscalationRecord | null>;
  /**
   * Apply a human resolution only if the row is still in `expectedState`.
   * Returns null when it moved underneath the operator, so two Garden tabs
   * cannot both claim the same escalation.
   */
  applyResolution(input: {
    escalationId: string;
    expectedState: HumanEscalationState;
    resolution: HumanEscalationResolution;
  }): Promise<HumanEscalationRecord | null>;
}
