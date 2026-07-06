import type { ObserverEvalSidecarLeverSettings } from '../../../shared/contracts/runtime.js';

/**
 * Shadow trigger levers over the observer-eval sidecar's simulated emotion
 * state (emo_sim).
 *
 * TRACKING ONLY. A lever event means "the simulated temporal state says she
 * WOULD have acted now" -- send a proactive message, ask for a check-in, wind
 * down, or flag rumination-like persistence. Events are non-authoritative
 * telemetry written by the sidecar pipeline and read only by the Garden admin
 * service. Nothing in the live companion loop (src/core/agent, core/scheduler,
 * core/tools) may import this module or consume these events; a static
 * boundary test enforces that.
 *
 * The module is written against the emo_sim afterTick snapshot SHAPE
 * ({ t, mood: { valence, arousal }, drives: {...}, dominant, emotions }), not
 * against the current adapter internals: a parallel workstream is replacing
 * the one-shot adapter with a persistent server but preserves this shape.
 */

export const OBSERVER_EVAL_LEVER_NAMES = Object.freeze([
  'would_message',
  'would_check_in',
  'would_rest',
  'rumination_watch',
] as const);

export type ObserverEvalLeverName = typeof OBSERVER_EVAL_LEVER_NAMES[number];

export const OBSERVER_EVAL_LEVER_STATE_SCHEMA_VERSION = 1 as const;

export const OBSERVER_EVAL_LEVER_DETAILS: Readonly<Record<ObserverEvalLeverName, string>> = Object.freeze({
  would_message: 'she would send a proactive message now',
  would_check_in: 'she would surface a concern / ask for a check-in',
  would_rest: 'she would wind down / defer background work',
  rumination_watch: 'rumination-like persistence, watch only',
});

/**
 * Attachment-family emotions, mirroring the crosswalk's `affiliation_love`
 * family. Kept as a local frozen set so the lever surface stays decoupled
 * from crosswalk internals.
 */
export const OBSERVER_LEVER_ATTACHMENT_EMOTIONS: ReadonlySet<string> = new Set([
  'Love',
  'Romance',
  'Adoration',
  'Admiration',
  'Sympathy',
]);

/**
 * Negative-valence emotions used as a rumination proxy. The emo_sim engine's
 * internal rumination multiplier is not exposed in the snapshot shape, so a
 * persistently dominant negative emotion is the honest observable proxy;
 * this is watch-only telemetry, not a clinical claim.
 */
export const OBSERVER_LEVER_NEGATIVE_EMOTIONS: ReadonlySet<string> = new Set([
  'Empathic Pain',
  'Fear',
  'Anxiety',
  'Horror',
  'Distress',
  'Pain',
  'Sadness',
  'Disappointment',
  'Tiredness',
  'Boredom',
  'Anger',
  'Contempt',
  'Disgust',
  'Envy',
  'Guilt',
  'Shame',
  'Embarrassment',
  'Awkwardness',
  'Doubt',
  'Surprise (negative)',
]);

/**
 * Loose snapshot input: the emo_sim afterTick engine snapshot shape.
 * `drives` may be absent (historical rows / degraded adapters); levers whose
 * inputs are missing evaluate to `inputs_unavailable` instead of throwing.
 */
export interface ObserverLeverSnapshotInput {
  t: number;
  mood: {
    valence: number;
    arousal: number;
  };
  dominant: string;
  emotions: Readonly<Record<string, number>>;
  drives?: Readonly<Partial<Record<string, number>>> | null;
}

export type ObserverLeverConditionOutcome = 'met' | 'not_met' | 'inputs_unavailable';

export interface ObserverLeverConditionResult {
  lever: ObserverEvalLeverName;
  enabled: boolean;
  outcome: ObserverLeverConditionOutcome;
  /** Scalar state values sampled at evaluation time (for the event row / audit). */
  stateValues: Record<string, number | string | null>;
  /** Typed notes; always contains 'inputs_unavailable' when outcome says so. */
  notes: string[];
  missingInputs: string[];
}

export interface ObserverLeverTrackerLeverState {
  /** Timestamp of the first observation of the current uninterrupted crossing, or null. */
  firstCrossingMs: number | null;
  /** Timestamp of the most recent fire, or null if never fired. */
  lastFiredAtMs: number | null;
}

export interface ObserverLeverTrackerState {
  schemaVersion: typeof OBSERVER_EVAL_LEVER_STATE_SCHEMA_VERSION;
  levers: Record<ObserverEvalLeverName, ObserverLeverTrackerLeverState>;
}

export interface ObserverLeverCooldownContext {
  cooldownMs: number;
  previousFiredAtMs: number | null;
  refireReason: 'first_fire' | 'condition_reset' | 'cooldown_elapsed';
}

export interface ObserverLeverFiredEvent {
  lever: ObserverEvalLeverName;
  firedAtMs: number;
  detail: string;
  stateValues: Record<string, number | string | null>;
  sustainMs: number;
  firstCrossingMs: number;
  cooldown: ObserverLeverCooldownContext;
}

export interface ObserverLeverEvaluationEntry extends ObserverLeverConditionResult {
  status: 'fired' | 'sustaining' | 'inactive' | 'blocked_cooldown' | 'inputs_unavailable' | 'disabled';
  firstCrossingMs: number | null;
  lastFiredAtMs: number | null;
}

export interface ObserverLeverEvaluation {
  evaluatedAtMs: number;
  entries: ObserverLeverEvaluationEntry[];
  events: ObserverLeverFiredEvent[];
}

/**
 * Pure condition evaluation: snapshot in, per-lever condition out. No clock,
 * no state, no I/O. Missing inputs never throw; they produce
 * `inputs_unavailable` (or evaluate the remaining branch of an OR-lever with
 * a typed note).
 */
export function evaluateObserverLeverConditions(
  snapshot: ObserverLeverSnapshotInput | null,
  settings: ObserverEvalSidecarLeverSettings,
): ObserverLeverConditionResult[] {
  return OBSERVER_EVAL_LEVER_NAMES.map(lever => evaluateSingleLever(lever, snapshot, settings));
}

function evaluateSingleLever(
  lever: ObserverEvalLeverName,
  snapshot: ObserverLeverSnapshotInput | null,
  settings: ObserverEvalSidecarLeverSettings,
): ObserverLeverConditionResult {
  const base: ObserverLeverConditionResult = {
    lever,
    enabled: leverEnabled(lever, settings),
    outcome: 'inputs_unavailable',
    stateValues: {},
    notes: [],
    missingInputs: [],
  };
  if (!snapshot) {
    base.notes.push('inputs_unavailable');
    base.missingInputs.push('snapshot');
    return base;
  }

  switch (lever) {
    case 'would_message':
      return evaluateWouldMessage(base, snapshot, settings);
    case 'would_check_in':
      return evaluateWouldCheckIn(base, snapshot, settings);
    case 'would_rest':
      return evaluateWouldRest(base, snapshot, settings);
    case 'rumination_watch':
      return evaluateRuminationWatch(base, snapshot, settings);
  }
}

function evaluateWouldMessage(
  result: ObserverLeverConditionResult,
  snapshot: ObserverLeverSnapshotInput,
  settings: ObserverEvalSidecarLeverSettings,
): ObserverLeverConditionResult {
  const config = settings.wouldMessage;
  const socialNeed = finiteOrNull(snapshot.drives?.socialNeed);
  const dominant = snapshot.dominant;
  const dominantIntensity = finiteOrNull(snapshot.emotions[dominant]);

  const branches: Array<boolean | null> = [];
  if (socialNeed === null) {
    result.missingInputs.push('drives.socialNeed');
    result.notes.push('inputs_unavailable:drives.socialNeed');
    branches.push(null);
  } else {
    branches.push(socialNeed >= config.socialNeedThreshold);
  }

  if (dominantIntensity === null) {
    result.missingInputs.push(`emotions.${dominant}`);
    result.notes.push('inputs_unavailable:dominant_intensity');
    branches.push(null);
  } else {
    branches.push(
      OBSERVER_LEVER_ATTACHMENT_EMOTIONS.has(dominant)
      && dominantIntensity >= config.attachmentIntensityThreshold,
    );
  }

  result.stateValues = {
    socialNeed,
    dominant,
    dominantIntensity,
    socialNeedThreshold: config.socialNeedThreshold,
    attachmentIntensityThreshold: config.attachmentIntensityThreshold,
  };
  result.outcome = combineOrBranches(branches, result);
  return result;
}

function evaluateWouldCheckIn(
  result: ObserverLeverConditionResult,
  snapshot: ObserverLeverSnapshotInput,
  settings: ObserverEvalSidecarLeverSettings,
): ObserverLeverConditionResult {
  const config = settings.wouldCheckIn;
  const valence = finiteOrNull(snapshot.mood.valence);
  result.stateValues = {
    moodValence: valence,
    valenceThreshold: config.valenceThreshold,
  };
  if (valence === null) {
    result.missingInputs.push('mood.valence');
    result.notes.push('inputs_unavailable');
    result.outcome = 'inputs_unavailable';
    return result;
  }
  result.outcome = valence <= config.valenceThreshold ? 'met' : 'not_met';
  return result;
}

function evaluateWouldRest(
  result: ObserverLeverConditionResult,
  snapshot: ObserverLeverSnapshotInput,
  settings: ObserverEvalSidecarLeverSettings,
): ObserverLeverConditionResult {
  const config = settings.wouldRest;
  const sleepPressure = finiteOrNull(snapshot.drives?.sleepPressure);
  const arousal = finiteOrNull(snapshot.mood.arousal);

  const branches: Array<boolean | null> = [];
  if (sleepPressure === null) {
    result.missingInputs.push('drives.sleepPressure');
    result.notes.push('inputs_unavailable:drives.sleepPressure');
    branches.push(null);
  } else {
    branches.push(sleepPressure >= config.sleepPressureThreshold);
  }
  if (arousal === null) {
    result.missingInputs.push('mood.arousal');
    result.notes.push('inputs_unavailable:mood.arousal');
    branches.push(null);
  } else {
    branches.push(arousal >= config.arousalThreshold);
  }

  result.stateValues = {
    sleepPressure,
    moodArousal: arousal,
    sleepPressureThreshold: config.sleepPressureThreshold,
    arousalThreshold: config.arousalThreshold,
  };
  result.outcome = combineOrBranches(branches, result);
  return result;
}

function evaluateRuminationWatch(
  result: ObserverLeverConditionResult,
  snapshot: ObserverLeverSnapshotInput,
  settings: ObserverEvalSidecarLeverSettings,
): ObserverLeverConditionResult {
  const config = settings.ruminationWatch;
  const dominant = snapshot.dominant;
  const dominantIntensity = finiteOrNull(snapshot.emotions[dominant]);
  result.stateValues = {
    dominant,
    dominantIntensity,
    intensityThreshold: config.intensityThreshold,
  };
  // The engine-internal rumination multiplier is not present in the snapshot
  // shape; a persistently dominant negative-valence emotion is the proxy.
  result.notes.push('proxy:negative_dominant_persistence');
  if (dominantIntensity === null) {
    result.missingInputs.push(`emotions.${dominant}`);
    result.notes.push('inputs_unavailable');
    result.outcome = 'inputs_unavailable';
    return result;
  }
  result.outcome = OBSERVER_LEVER_NEGATIVE_EMOTIONS.has(dominant)
    && dominantIntensity >= config.intensityThreshold
    ? 'met'
    : 'not_met';
  return result;
}

/**
 * OR-combination for levers with multiple trigger branches:
 * any true branch -> met; all evaluable branches false -> not_met;
 * no evaluable branches -> inputs_unavailable.
 */
function combineOrBranches(
  branches: Array<boolean | null>,
  result: ObserverLeverConditionResult,
): ObserverLeverConditionOutcome {
  if (branches.some(branch => branch === true)) {
    return 'met';
  }
  if (branches.every(branch => branch === null)) {
    result.notes.push('inputs_unavailable');
    return 'inputs_unavailable';
  }
  return 'not_met';
}

function leverEnabled(lever: ObserverEvalLeverName, settings: ObserverEvalSidecarLeverSettings): boolean {
  if (!settings.enabled) return false;
  switch (lever) {
    case 'would_message': return settings.wouldMessage.enabled;
    case 'would_check_in': return settings.wouldCheckIn.enabled;
    case 'would_rest': return settings.wouldRest.enabled;
    case 'rumination_watch': return settings.ruminationWatch.enabled;
  }
}

function leverSustainMs(lever: ObserverEvalLeverName, settings: ObserverEvalSidecarLeverSettings): number {
  switch (lever) {
    case 'would_message': return settings.wouldMessage.sustainMs;
    case 'would_check_in': return settings.wouldCheckIn.sustainMs;
    case 'would_rest': return settings.wouldRest.sustainMs;
    case 'rumination_watch': return settings.ruminationWatch.sustainMs;
  }
}

export function createEmptyObserverLeverTrackerState(): ObserverLeverTrackerState {
  const levers = {} as Record<ObserverEvalLeverName, ObserverLeverTrackerLeverState>;
  for (const lever of OBSERVER_EVAL_LEVER_NAMES) {
    levers[lever] = { firstCrossingMs: null, lastFiredAtMs: null };
  }
  return { schemaVersion: OBSERVER_EVAL_LEVER_STATE_SCHEMA_VERSION, levers };
}

export function normalizeObserverLeverTrackerState(value: unknown): ObserverLeverTrackerState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('observer lever tracker state must be a JSON object');
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== OBSERVER_EVAL_LEVER_STATE_SCHEMA_VERSION) {
    throw new Error(`observer lever tracker state schemaVersion must be ${OBSERVER_EVAL_LEVER_STATE_SCHEMA_VERSION}`);
  }
  const rawLevers = record.levers;
  if (typeof rawLevers !== 'object' || rawLevers === null || Array.isArray(rawLevers)) {
    throw new Error('observer lever tracker state levers must be a JSON object');
  }
  const state = createEmptyObserverLeverTrackerState();
  for (const lever of OBSERVER_EVAL_LEVER_NAMES) {
    const rawLever = (rawLevers as Record<string, unknown>)[lever];
    if (rawLever === undefined) continue;
    if (typeof rawLever !== 'object' || rawLever === null || Array.isArray(rawLever)) {
      throw new Error(`observer lever tracker state for ${lever} must be a JSON object`);
    }
    const entry = rawLever as Record<string, unknown>;
    state.levers[lever] = {
      firstCrossingMs: nullableEpochMs(entry.firstCrossingMs, `${lever}.firstCrossingMs`),
      lastFiredAtMs: nullableEpochMs(entry.lastFiredAtMs, `${lever}.lastFiredAtMs`),
    };
  }
  return state;
}

/**
 * Stateful sustained-condition + cooldown tracker.
 *
 * Evaluation is turn-driven and irregular: observations only arrive when the
 * companion is spoken to. Sustain semantics are therefore defined over the
 * observation stream itself:
 *
 * - `firstCrossingMs` is the timestamp of the first observation where the
 *   condition was met after a not-met (or indeterminate) observation.
 * - Every observation where the condition is not met -- or cannot be
 *   evaluated (`inputs_unavailable`, fail closed: continuity cannot be
 *   attested) -- resets the crossing.
 * - A lever fires when `observedAt - firstCrossingMs >= sustainMs`. Because
 *   resets happen on every non-met observation, "all intermediate
 *   observations above threshold" holds by construction. Silence between two
 *   met observations counts toward sustain (there is no evidence of a drop).
 *
 * Cooldown: after a fire, the lever refires only if the condition fully
 * reset in between (a new crossing began after the last fire) or
 * `cooldownMs` elapsed (bounded re-notification during a very long
 * uninterrupted crossing). At most one event per lever per observation --
 * one event per crossing edge, not per tick.
 *
 * State is a tiny serializable record persisted by the caller
 * (observer_eval_sidecar_lever_state) so sustain/cooldown context survives
 * restarts. Persisting the state was chosen over re-deriving it from recent
 * observation rows because derivation would re-read full emo_sim JSON
 * payloads and replay threshold logic on every turn; the state row keeps
 * evaluation O(1) and restart-safe.
 */
export class ObserverLeverTracker {
  private state: ObserverLeverTrackerState;

  constructor(
    private readonly settings: ObserverEvalSidecarLeverSettings,
    initialState?: ObserverLeverTrackerState,
  ) {
    this.state = initialState
      ? normalizeObserverLeverTrackerState(structuredClone(initialState))
      : createEmptyObserverLeverTrackerState();
  }

  getState(): ObserverLeverTrackerState {
    return structuredClone(this.state);
  }

  evaluate(input: {
    snapshot: ObserverLeverSnapshotInput | null;
    observedAtMs: number;
  }): ObserverLeverEvaluation {
    const observedAtMs = requireEpochMs(input.observedAtMs, 'observedAtMs');
    const conditions = evaluateObserverLeverConditions(input.snapshot, this.settings);
    const entries: ObserverLeverEvaluationEntry[] = [];
    const events: ObserverLeverFiredEvent[] = [];

    for (const condition of conditions) {
      const leverState = this.state.levers[condition.lever];
      const entry = this.advanceLever(condition, leverState, observedAtMs);
      entries.push(entry);
      if (entry.status === 'fired' && entry.firstCrossingMs !== null) {
        events.push({
          lever: condition.lever,
          firedAtMs: observedAtMs,
          detail: OBSERVER_EVAL_LEVER_DETAILS[condition.lever],
          stateValues: { ...condition.stateValues },
          sustainMs: leverSustainMs(condition.lever, this.settings),
          firstCrossingMs: entry.firstCrossingMs,
          cooldown: entry.cooldownContext,
        });
      }
    }

    return { evaluatedAtMs: observedAtMs, entries, events };
  }

  private advanceLever(
    condition: ObserverLeverConditionResult,
    leverState: ObserverLeverTrackerLeverState,
    observedAtMs: number,
  ): ObserverLeverEvaluationEntry & { cooldownContext: ObserverLeverCooldownContext } {
    const sustainMs = leverSustainMs(condition.lever, this.settings);
    const cooldownMs = this.settings.cooldownMs;
    const makeEntry = (
      status: ObserverLeverEvaluationEntry['status'],
      cooldownContext: ObserverLeverCooldownContext,
    ): ObserverLeverEvaluationEntry & { cooldownContext: ObserverLeverCooldownContext } => ({
      ...condition,
      status,
      firstCrossingMs: leverState.firstCrossingMs,
      lastFiredAtMs: leverState.lastFiredAtMs,
      cooldownContext,
    });
    const idleCooldown: ObserverLeverCooldownContext = {
      cooldownMs,
      previousFiredAtMs: leverState.lastFiredAtMs,
      refireReason: 'first_fire',
    };

    if (!condition.enabled) {
      // Disabled levers do not accrue crossings; stale state must not fire
      // the moment a lever is re-enabled.
      leverState.firstCrossingMs = null;
      return makeEntry('disabled', idleCooldown);
    }

    if (condition.outcome === 'inputs_unavailable') {
      // Fail closed: without inputs, continuity of the crossing cannot be
      // attested, so the crossing resets. Recorded, never thrown, never
      // silently skipped.
      leverState.firstCrossingMs = null;
      return makeEntry('inputs_unavailable', idleCooldown);
    }

    if (condition.outcome === 'not_met') {
      leverState.firstCrossingMs = null;
      return makeEntry('inactive', idleCooldown);
    }

    if (leverState.firstCrossingMs === null) {
      leverState.firstCrossingMs = observedAtMs;
    }
    const sustainedMs = observedAtMs - leverState.firstCrossingMs;
    if (sustainedMs < sustainMs) {
      return makeEntry('sustaining', idleCooldown);
    }

    const previousFiredAtMs = leverState.lastFiredAtMs;
    const refireReason: ObserverLeverCooldownContext['refireReason'] | null =
      previousFiredAtMs === null
        ? 'first_fire'
        : leverState.firstCrossingMs > previousFiredAtMs
          ? 'condition_reset'
          : observedAtMs - previousFiredAtMs >= cooldownMs
            ? 'cooldown_elapsed'
            : null;

    if (refireReason === null) {
      return makeEntry('blocked_cooldown', idleCooldown);
    }

    const cooldownContext: ObserverLeverCooldownContext = {
      cooldownMs,
      previousFiredAtMs,
      refireReason,
    };
    const entry = makeEntry('fired', cooldownContext);
    leverState.lastFiredAtMs = observedAtMs;
    return { ...entry, lastFiredAtMs: observedAtMs };
  }
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nullableEpochMs(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  return requireEpochMs(value, field);
}

function requireEpochMs(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${field} must be a finite non-negative timestamp in milliseconds`);
  }
  return Math.floor(value);
}
