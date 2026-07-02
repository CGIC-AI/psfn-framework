import type { EmotionObservation, VADVector } from './state.js';

// ── Per-participant emotional trend lines (bead E6.3) ──
//
// Inside a group room, one person being cruel and another being protective
// must move the companion's stance toward each of them SEPARATELY. The scoped
// emotion layer (E1.5) keys transient affect per DM/room but cannot tell who
// did what inside a room. This module supplies the deterministic substrate for
// that distinction: a slow EMA trend line per participant, fed ONLY by that
// participant's own messages, using the SAME local classifier output the
// scoped emotion layer already computed for the turn.
//
// Determinism guarantees (charter: no LLM where deterministic signals suffice):
//  - accumulation is pure arithmetic over an already-produced EmotionObservation;
//  - zero LLM/classifier calls happen in this module or its callers' trend path;
//  - orientation moves slowly (EMA) so no single sentence swings a trend line.
//
// Idle participants never appear in a turn's author slot, so they are never
// updated — their trend and any orientation gated on it stay put by construction.

const CLAMP_MIN = -1;
const CLAMP_MAX = 1;
const DISCRETE_MIN = 0;
const DISCRETE_MAX = 1;

/** Below this score a discrete label is dropped from a trend (bounded growth). */
const DISCRETE_PRUNE_EPSILON = 1e-3;
/** Hard cap on discrete labels retained per participant trend. */
const DISCRETE_LABEL_CAP = 16;

export interface ParticipantEmotionTrend {
  /** Stable participant identity (canonical contact key, else authorId). */
  readonly participantKey: string;
  /** Slow EMA of the participant's own message VAD. */
  readonly vad: VADVector;
  /** Slow EMA of discrete emotion scores keyed by label. */
  readonly discrete: Readonly<Record<string, number>>;
  /** Count of that participant's own observed messages (interaction volume). */
  readonly interactionCount: number;
  /** Wall-clock ms of the last update (drives staleness + LRU eviction). */
  readonly updatedAtMs: number;
}

function clampSigned(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(CLAMP_MIN, Math.min(CLAMP_MAX, value));
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(DISCRETE_MIN, Math.min(DISCRETE_MAX, value));
}

function clampRate(alpha: number): number {
  if (!Number.isFinite(alpha)) return 0;
  return Math.max(0, Math.min(1, alpha));
}

export function neutralParticipantVad(): VADVector {
  return { valence: 0, arousal: 0, dominance: 0 };
}

function normalizeObservationVad(observation: EmotionObservation): VADVector {
  const vad = observation.vad ?? {};
  return {
    valence: clampSigned(vad.valence ?? 0),
    arousal: clampSigned(vad.arousal ?? 0),
    dominance: clampSigned(vad.dominance ?? 0),
  };
}

/** Fresh neutral trend for a newly-observed participant. */
export function createParticipantTrend(
  participantKey: string,
  nowMs: number,
): ParticipantEmotionTrend {
  const key = participantKey.trim();
  if (!key) {
    throw new Error('createParticipantTrend requires a non-empty participantKey');
  }
  return {
    participantKey: key,
    vad: neutralParticipantVad(),
    discrete: {},
    interactionCount: 0,
    updatedAtMs: nowMs,
  };
}

function toLowerScoreMap(source: Readonly<Record<string, number>>): Map<string, number> {
  const map = new Map<string, number>();
  for (const [rawLabel, rawScore] of Object.entries(source)) {
    const label = rawLabel.trim().toLowerCase();
    if (!label) continue;
    map.set(label, clampUnit(rawScore));
  }
  return map;
}

function emaDiscrete(
  previous: Readonly<Record<string, number>>,
  observation: Readonly<Record<string, number>>,
  alpha: number,
): Record<string, number> {
  const priorMap = toLowerScoreMap(previous);
  const observedMap = toLowerScoreMap(observation);
  const next: Record<string, number> = {};
  const labels = new Set<string>([...priorMap.keys(), ...observedMap.keys()]);
  for (const label of labels) {
    const prior = priorMap.get(label) ?? 0;
    // Labels absent from this observation decay toward 0; present labels move
    // toward the observed score. Both are the same EMA with target 0 vs score.
    const target = observedMap.get(label) ?? 0;
    const blended = clampUnit(prior + (target - prior) * alpha);
    if (blended <= DISCRETE_PRUNE_EPSILON) continue;
    next[label] = blended;
  }
  // Bounded growth: keep the strongest labels only.
  const entries = Object.entries(next);
  if (entries.length <= DISCRETE_LABEL_CAP) return next;
  entries.sort((left, right) => {
    if (right[1] !== left[1]) return right[1] - left[1];
    return left[0].localeCompare(right[0]);
  });
  const capped: Record<string, number> = {};
  for (const [label, score] of entries.slice(0, DISCRETE_LABEL_CAP)) {
    capped[label] = score;
  }
  return capped;
}

/**
 * Advance a participant's trend line by one of THEIR OWN observations. Pure EMA
 * over the already-computed EmotionObservation — no LLM, no classifier call.
 */
export function updateParticipantTrend(
  previous: ParticipantEmotionTrend,
  observation: EmotionObservation,
  alpha: number,
  nowMs: number,
): ParticipantEmotionTrend {
  const rate = clampRate(alpha);
  const observedVad = normalizeObservationVad(observation);
  const vad: VADVector = {
    valence: clampSigned(previous.vad.valence + (observedVad.valence - previous.vad.valence) * rate),
    arousal: clampSigned(previous.vad.arousal + (observedVad.arousal - previous.vad.arousal) * rate),
    dominance: clampSigned(previous.vad.dominance + (observedVad.dominance - previous.vad.dominance) * rate),
  };
  const discrete = emaDiscrete(previous.discrete, observation.discrete ?? {}, rate);
  return {
    participantKey: previous.participantKey,
    vad,
    discrete,
    interactionCount: previous.interactionCount + 1,
    updatedAtMs: nowMs,
  };
}

export function cloneParticipantTrend(
  trend: ParticipantEmotionTrend,
): ParticipantEmotionTrend {
  return {
    participantKey: trend.participantKey,
    vad: { ...trend.vad },
    discrete: { ...trend.discrete },
    interactionCount: trend.interactionCount,
    updatedAtMs: trend.updatedAtMs,
  };
}

/** Max per-axis magnitude of a trend's VAD (displacement from neutral). */
export function participantTrendMagnitude(trend: ParticipantEmotionTrend): number {
  return Math.max(
    Math.abs(trend.vad.valence),
    Math.abs(trend.vad.arousal),
    Math.abs(trend.vad.dominance),
  );
}

export interface MeaningfulMovementThresholds {
  /** Minimum interaction volume before a trend may move orientation. */
  readonly minInteractions: number;
  /** Minimum VAD displacement (max axis) before a trend is "meaningful". */
  readonly minTrendDelta: number;
}

/**
 * Gate for consumers: has THIS participant produced enough signal to move
 * orientation toward them? Requires both a minimum interaction volume and a
 * minimum VAD displacement, so a single sentence or a barely-nonzero drift
 * never counts.
 */
export function participantMovementIsMeaningful(
  trend: ParticipantEmotionTrend,
  thresholds: MeaningfulMovementThresholds,
): boolean {
  if (trend.interactionCount < Math.max(0, thresholds.minInteractions)) return false;
  return participantTrendMagnitude(trend) >= Math.max(0, thresholds.minTrendDelta);
}

export interface RoomTrendMaintenancePolicy {
  /** Max participants tracked per room (small-room design point). */
  readonly maxTrackedParticipants: number;
  /** Trends untouched for longer than this are evicted. */
  readonly staleEvictionSeconds: number;
}

export interface RoomTrendMaintenanceResult {
  /** Participant keys evicted (stale-window or over-cap). */
  readonly evictedKeys: readonly string[];
}

/**
 * Enforce the two bounded-scale rules on a room's trend map IN PLACE:
 *  - evict trends untouched for longer than the stale window;
 *  - if still over the participant cap, evict the least-recently-updated first.
 *
 * Returns the evicted keys so the caller can delete them from the store too.
 */
export function maintainRoomTrends(
  trends: Map<string, ParticipantEmotionTrend>,
  policy: RoomTrendMaintenancePolicy,
  nowMs: number,
): RoomTrendMaintenanceResult {
  const evicted: string[] = [];
  const staleMs = Math.max(0, policy.staleEvictionSeconds) * 1000;

  if (staleMs > 0) {
    for (const [key, trend] of trends) {
      if (nowMs - trend.updatedAtMs > staleMs) {
        trends.delete(key);
        evicted.push(key);
      }
    }
  }

  const cap = Math.max(0, Math.floor(policy.maxTrackedParticipants));
  if (trends.size > cap) {
    const byRecency = [...trends.entries()].sort(
      (left, right) => left[1].updatedAtMs - right[1].updatedAtMs,
    );
    const overflow = trends.size - cap;
    for (let index = 0; index < overflow; index += 1) {
      const [key] = byRecency[index];
      trends.delete(key);
      evicted.push(key);
    }
  }

  return { evictedKeys: evicted };
}
