// ── Deterministic pre-LLM gating primitive ──
//
// Operator principle (jpvd.4): if a process does not need to run, it must not
// run. Where deterministic signals can tell us nothing changed, the heavier
// nondeterministic LLM pass must NOT fire.
//
// A gate is a pure, declarative decision over named deterministic inputs
// (counts since a watermark, VAD/trend deltas, keyword signal scores, elapsed
// time, pending-item counts). It produces { open, reason, inputs } with zero
// side effects and zero LLM spend. Callers evaluate the gate BEFORE any model
// call; a closed gate short-circuits the pass and (by convention) emits a typed
// skip event carrying the same reason + inputs so the Garden subsystem-health
// view can display why the pass did or did not run.
//
// The primitive intentionally covers two shapes seen across the recurring
// passes:
//   1. Change/evidence gates (orientation rewrite, dream pass, refinement,
//      appraisal, concern review): the gate OPENS when at least one opening
//      signal fires (enough evidence of change / enough pending work). If none
//      fire it stays CLOSED with `closedReason`.
//   2. Ordered hard pre-checks (extraction empty-transcript): `blockWhen` rules
//      are tested first, in order, and the first match closes the gate with its
//      own reason BEFORE any opening signal is considered.
//
// Every referenced input must be a finite number at evaluation time; a missing
// or non-finite required signal fails closed (throws) rather than silently
// defaulting — a deterministic gate must never guess.

export type GateComparator = 'gte' | 'gt' | 'lte' | 'lt' | 'eq';

/** A single deterministic threshold test over one named numeric input. */
export interface GateSignal {
  readonly input: string;
  readonly comparator: GateComparator;
  readonly threshold: number;
}

/** An ordered hard-close pre-check: first match closes the gate with `reason`. */
export interface GateBlockRule extends GateSignal {
  readonly reason: string;
}

export interface DeterministicGateDefinition {
  /** Lane id: matches the typed skip event + subsystem-health lane. */
  readonly lane: string;
  /** Ordered hard-close pre-checks evaluated before opening signals. */
  readonly blockWhen?: readonly GateBlockRule[];
  /** The gate opens when ANY of these fire. Empty => the gate never opens. */
  readonly openWhenAny: readonly GateSignal[];
  /** Reason recorded when the gate is closed and no block rule matched. */
  readonly closedReason: string;
  /** Reason recorded when the gate is open (default 'open'). */
  readonly openReason?: string;
}

export interface GateDecision {
  readonly lane: string;
  readonly open: boolean;
  readonly reason: string;
  /** Echo of the deterministic inputs, for the typed skip/run event. */
  readonly inputs: Readonly<Record<string, number | string>>;
}

const DEFAULT_OPEN_REASON = 'open';

function requireNumericInput(
  inputs: Readonly<Record<string, number | string>>,
  key: string,
  lane: string,
): number {
  const value = inputs[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(
      `Deterministic gate "${lane}" requires finite numeric input "${key}", received ${String(value)}`,
    );
  }
  return value;
}

function signalFires(value: number, comparator: GateComparator, threshold: number): boolean {
  switch (comparator) {
    case 'gte':
      return value >= threshold;
    case 'gt':
      return value > threshold;
    case 'lte':
      return value <= threshold;
    case 'lt':
      return value < threshold;
    case 'eq':
      return value === threshold;
  }
}

/**
 * Evaluate a deterministic gate against a snapshot of named inputs. Pure and
 * free: no I/O, no LLM call. Returns the decision plus an echo of the inputs so
 * the caller can attach them to a typed skip/run event.
 */
export function evaluateDeterministicGate(
  definition: DeterministicGateDefinition,
  inputs: Readonly<Record<string, number | string>>,
): GateDecision {
  for (const rule of definition.blockWhen ?? []) {
    const value = requireNumericInput(inputs, rule.input, definition.lane);
    if (signalFires(value, rule.comparator, rule.threshold)) {
      return { lane: definition.lane, open: false, reason: rule.reason, inputs };
    }
  }

  for (const signal of definition.openWhenAny) {
    const value = requireNumericInput(inputs, signal.input, definition.lane);
    if (signalFires(value, signal.comparator, signal.threshold)) {
      return {
        lane: definition.lane,
        open: true,
        reason: definition.openReason ?? DEFAULT_OPEN_REASON,
        inputs,
      };
    }
  }

  return { lane: definition.lane, open: false, reason: definition.closedReason, inputs };
}
