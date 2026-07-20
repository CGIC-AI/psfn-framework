/**
 * emo_sim directed A->B relationship state -> companion advisory.
 *
 * The pinned emo_sim server (`emo_sim/server.py#http-api.v1`, SHA
 * 5bb571d4cec42f6d178f70f529b52640a46018b5) exposes a top-level `relationships`
 * map in the `?full=1` session snapshot. This module reads the companion
 * agent's OUTGOING directed relationships (source = the companion) — liking /
 * trust / dominance / familiarity, plus any emotion delta — from that map and
 * renders them as a companion-readable ADVISORY prose reading.
 *
 * Two hard constraints from the oth4 adjudication and repo working rules:
 *
 * 1. Advisory-only, non-authoritative. Nothing here mutates relationship or
 *    trust state. It is one signal the companion weighs in her end-of-day
 *    review, provenance-marked as classifier-adjacent inference (twa0), never
 *    an automatic promoter/demoter.
 *
 * 2. Fail-closed on malformed, fail-soft to omission. The exact inner shape of
 *    emo_sim's relationship records is NOT vendored in this repo (emo_sim ships
 *    in a separate repo). The parser therefore reads the documented dimensions
 *    defensively and returns `null` on anything it cannot understand — it never
 *    throws into the sidecar observation and never fabricates a neutral reading
 *    (charter 8.5). At the pinned HEAD the only session peer is the synthetic
 *    `baseline-anchor` NPC, so the companion's real directed relationships are
 *    empty and this correctly degrades to no signal until emo_sim carries real
 *    dyad data (e.g. after the oth4.5 per-contact upstream work).
 */
import type { EmotionTelemetryProvenance } from '../../../shared/contracts/emotion-contracts.js';
import type { DyadRelationshipAdvisory } from '../../../shared/contracts/dyad-relationship-advisory.js';
import {
  DyadRelationshipAdvisoryUnavailableError,
  type DyadRelationshipAdvisoryProvider,
} from '../../../shared/contracts/dyad-relationship-advisory.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import { isRecord } from '../../../shared/utils/types.js';
import type { EmoSimAdapterRunResult } from './emosim-adapter.js';

export const EMOSIM_DIRECTED_RELATIONSHIP_FORMAT =
  'emosim.directed-relationship.reading.v1' as const;

/**
 * Provenance reference for the reading. Kept local (not imported from the
 * adapter) to avoid a module cycle; it names the same integration surface
 * (`EMOSIM_INTEGRATION_SURFACE`).
 */
const EMOSIM_DIRECTED_RELATIONSHIP_PROVENANCE_REF = 'emo_sim/server.py#http-api.v1' as const;

/** Candidate field names for each documented directed dimension. */
const LIKING_KEYS = ['liking', 'like', 'affection'] as const;
const TRUST_KEYS = ['trust', 'trusting'] as const;
const DOMINANCE_KEYS = ['dominance', 'dominant', 'power'] as const;
const FAMILIARITY_KEYS = ['familiarity', 'familiar', 'closeness'] as const;
const EMOTION_MAP_KEYS = ['emotions', 'emotion_deltas', 'emotionDeltas', 'kicks'] as const;

/**
 * Aggregate outward directed-relationship reading for one source agent. Means
 * over the targets that carried each dimension; targets excluded by the caller
 * (e.g. the synthetic anchor NPC) never contribute.
 */
export interface EmoSimDirectedRelationshipReading {
  format: typeof EMOSIM_DIRECTED_RELATIONSHIP_FORMAT;
  /** Source agent A (the companion). */
  agentName: string;
  /** Number of contributing targets (>= 1 when the reading is present). */
  sampleCount: number;
  liking: number | null;
  trust: number | null;
  dominance: number | null;
  familiarity: number | null;
  /** Strongest emotion delta toward the peer, if the record carried one. */
  topEmotionShift: { label: string; delta: number } | null;
}

export interface ParseDirectedRelationshipOptions {
  /** Source agent A whose outgoing relationships are read (the companion). */
  agentName: string;
  /** Targets B to exclude (synthetic session peers such as the anchor NPC). */
  excludeTargets?: readonly string[];
}

/**
 * Read the companion agent's outgoing directed relationships from a raw
 * emo_sim `?full=1` session snapshot. Returns `null` on absent OR malformed
 * data — never throws. A non-null result means at least one real target
 * carried at least one of the four documented dimensions.
 */
export function parseEmoSimDirectedRelationshipReading(
  rawSessionState: unknown,
  options: ParseDirectedRelationshipOptions,
): EmoSimDirectedRelationshipReading | null {
  if (!isRecord(rawSessionState)) return null;
  const relationships = rawSessionState.relationships;
  if (!isRecord(relationships)) return null;

  const bySource = relationships[options.agentName];
  // Supported shape: relationships[source][target] = { liking, trust, ... }.
  // Anything else (flat keys, arrays, scalars) is treated as not-understood.
  if (!isRecord(bySource)) return null;

  const exclude = new Set(options.excludeTargets ?? []);
  const liking: number[] = [];
  const trust: number[] = [];
  const dominance: number[] = [];
  const familiarity: number[] = [];
  let topEmotionShift: { label: string; delta: number } | null = null;
  let contributingTargets = 0;

  for (const [target, record] of Object.entries(bySource)) {
    if (exclude.has(target)) continue;
    if (!isRecord(record)) continue;
    const l = readFirstFinite(record, LIKING_KEYS);
    const t = readFirstFinite(record, TRUST_KEYS);
    const d = readFirstFinite(record, DOMINANCE_KEYS);
    const f = readFirstFinite(record, FAMILIARITY_KEYS);
    const emotion = readTopEmotionShift(record);
    if (l === null && t === null && d === null && f === null) continue;
    contributingTargets += 1;
    if (l !== null) liking.push(l);
    if (t !== null) trust.push(t);
    if (d !== null) dominance.push(d);
    if (f !== null) familiarity.push(f);
    if (emotion && (!topEmotionShift || Math.abs(emotion.delta) > Math.abs(topEmotionShift.delta))) {
      topEmotionShift = emotion;
    }
  }

  if (contributingTargets === 0) return null;

  return {
    format: EMOSIM_DIRECTED_RELATIONSHIP_FORMAT,
    agentName: options.agentName,
    sampleCount: contributingTargets,
    liking: mean(liking),
    trust: mean(trust),
    dominance: mean(dominance),
    familiarity: mean(familiarity),
    topEmotionShift,
  };
}

/**
 * Strict, fail-closed normalizer for a persisted/emitted reading (untrusted
 * JSON on the read path). Throws on a structurally invalid reading so the
 * caller can decide whether to omit; used both by the adapter output schema
 * and the read-path provider.
 */
export function normalizeEmoSimDirectedRelationshipReading(
  value: unknown,
  field: string,
): EmoSimDirectedRelationshipReading {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  if (value.format !== EMOSIM_DIRECTED_RELATIONSHIP_FORMAT) {
    throw new Error(`${field}.format must be ${EMOSIM_DIRECTED_RELATIONSHIP_FORMAT}`);
  }
  const agentName = value.agentName;
  if (typeof agentName !== 'string' || agentName.trim().length === 0) {
    throw new Error(`${field}.agentName must be a non-empty string`);
  }
  const sampleCount = value.sampleCount;
  if (typeof sampleCount !== 'number' || !Number.isInteger(sampleCount) || sampleCount < 1) {
    throw new Error(`${field}.sampleCount must be a positive integer`);
  }
  return {
    format: EMOSIM_DIRECTED_RELATIONSHIP_FORMAT,
    agentName: agentName.trim(),
    sampleCount,
    liking: normalizeNullableFinite(value.liking, `${field}.liking`),
    trust: normalizeNullableFinite(value.trust, `${field}.trust`),
    dominance: normalizeNullableFinite(value.dominance, `${field}.dominance`),
    familiarity: normalizeNullableFinite(value.familiarity, `${field}.familiarity`),
    topEmotionShift: normalizeTopEmotionShift(value.topEmotionShift, `${field}.topEmotionShift`),
  };
}

/**
 * Render a directed-relationship reading as charter-8.6 companion-readable
 * prose with twa0 classifier-inferred provenance. Returns `null` when no
 * dimension is present (nothing honest to say).
 */
export function renderDyadRelationshipAdvisory(
  reading: EmoSimDirectedRelationshipReading,
  observedAtMs: number | null,
): DyadRelationshipAdvisory | null {
  const clauses: string[] = [];
  if (reading.liking !== null) clauses.push(`warmth reads ${describeLiking(reading.liking)}`);
  if (reading.familiarity !== null) clauses.push(`familiarity feels ${describeFamiliarity(reading.familiarity)}`);
  if (reading.trust !== null) clauses.push(`the trust lean is ${describeTrustLean(reading.trust)}`);
  if (reading.dominance !== null) clauses.push(`your footing sits ${describeDominance(reading.dominance)}`);
  if (clauses.length === 0) return null;

  let prose = `Your background affect model's sense of recent company: ${joinClauses(clauses)}.`;
  if (reading.topEmotionShift) {
    prose += ` The strongest recent shift leans toward ${reading.topEmotionShift.label.toLowerCase()}.`;
  }

  const provenance: EmotionTelemetryProvenance = {
    source: 'classifier_inferred',
    modality: 'runtime',
    classifier: 'emo_sim',
    model: EMOSIM_DIRECTED_RELATIONSHIP_PROVENANCE_REF,
    provenanceRef: EMOSIM_DIRECTED_RELATIONSHIP_PROVENANCE_REF,
    ...(observedAtMs !== null ? { observedAtMs } : {}),
  };

  return { prose, provenance, observedAtMs };
}

export interface CreateEmoSimDyadRelationshipAdvisoryProviderOptions {
  /**
   * Read-only accessor for the latest persisted sidecar observation. Kept
   * narrow so this provider never depends on the full persistence surface.
   */
  getLatestObservation: () => Promise<{ emosim?: EmoSimAdapterRunResult } | null>;
}

/**
 * Build the read-only advisory provider consumed by the companion's end-of-day
 * relationship/trust analysis. Fail-closed at the infrastructure boundary
 * (store errors are logged and thrown as unavailable); fail-soft (null) when
 * there is simply no reading to show.
 */
export function createEmoSimDyadRelationshipAdvisoryProvider(
  options: CreateEmoSimDyadRelationshipAdvisoryProviderOptions,
): DyadRelationshipAdvisoryProvider {
  const log = createComponentLogger('EmoSimDyadRelationshipAdvisory');
  return {
    async describeLatestDirectedRelationship(): Promise<DyadRelationshipAdvisory | null> {
      let observation: { emosim?: EmoSimAdapterRunResult } | null;
      try {
        observation = await options.getLatestObservation();
      } catch (error) {
        // Infrastructure boundary: surface, never swallow.
        log.warn('emo_sim dyad advisory read failed (store unavailable)', {
          error: toErrorMessage(error),
        });
        throw new DyadRelationshipAdvisoryUnavailableError(
          `emo_sim dyad advisory store read failed: ${toErrorMessage(error)}`,
          error,
        );
      }

      const emosim = observation?.emosim;
      if (!emosim || !emosim.ok) return null;
      // Persisted JSON is untrusted: read as unknown, validate defensively.
      const rawReading: unknown = emosim.output.relationship;
      if (rawReading === undefined || rawReading === null) return null;

      let reading: EmoSimDirectedRelationshipReading;
      try {
        reading = normalizeEmoSimDirectedRelationshipReading(rawReading, 'persisted emosim relationship');
      } catch (error) {
        // Persisted JSON is untrusted; a malformed row is a logged degradation,
        // not a fabricated reading and not a thrown observation failure.
        log.warn('emo_sim dyad advisory reading malformed; omitting', {
          error: toErrorMessage(error),
        });
        return null;
      }

      const observedAtMs = resolveObservedAtMs(emosim);
      return renderDyadRelationshipAdvisory(reading, observedAtMs);
    },
  };
}

function resolveObservedAtMs(emosim: EmoSimAdapterRunResult): number | null {
  if (!emosim.ok) return null;
  const observedAt = emosim.output.input.deterministic.observedAt;
  const parsed = Date.parse(observedAt);
  return Number.isFinite(parsed) ? parsed : null;
}

function readFirstFinite(record: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function readTopEmotionShift(record: Record<string, unknown>): { label: string; delta: number } | null {
  for (const key of EMOTION_MAP_KEYS) {
    const map = record[key];
    if (!isRecord(map)) continue;
    let best: { label: string; delta: number } | null = null;
    for (const [label, raw] of Object.entries(map)) {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
      if (!best || Math.abs(raw) > Math.abs(best.delta)) best = { label, delta: raw };
    }
    if (best) return best;
  }
  return null;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function normalizeNullableFinite(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number or null`);
  }
  return value;
}

function normalizeTopEmotionShift(
  value: unknown,
  field: string,
): { label: string; delta: number } | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) throw new Error(`${field} must be an object or null`);
  const label = value.label;
  const delta = value.delta;
  if (typeof label !== 'string' || label.trim().length === 0) {
    throw new Error(`${field}.label must be a non-empty string`);
  }
  if (typeof delta !== 'number' || !Number.isFinite(delta)) {
    throw new Error(`${field}.delta must be a finite number`);
  }
  return { label: label.trim(), delta };
}

// ── Charter 8.6 describe helpers: words, never raw scores. Ranges are not
// guaranteed by the unvendored emo_sim contract, so thresholds are sign- and
// magnitude-based and tolerate either 0..1 or -1..1 scales. ──

function describeLiking(value: number): string {
  if (value >= 0.5) return 'clearly warm';
  if (value >= 0.15) return 'gently warm';
  if (value <= -0.5) return 'notably cool';
  if (value <= -0.15) return 'slightly cool';
  return 'even';
}

function describeFamiliarity(value: number): string {
  if (value >= 0.5) return 'well-worn';
  if (value >= 0.15) return 'growing';
  if (value <= 0.05) return 'still new';
  return 'settling in';
}

function describeTrustLean(value: number): string {
  if (value >= 0.5) return 'firm';
  if (value >= 0.15) return 'tentatively open';
  if (value <= -0.15) return 'guarded';
  return 'neutral';
}

function describeDominance(value: number): string {
  if (value >= 0.25) return 'more in the lead';
  if (value <= -0.25) return 'more deferring';
  return 'on level footing';
}

function joinClauses(clauses: readonly string[]): string {
  if (clauses.length === 1) return clauses[0] ?? '';
  if (clauses.length === 2) return `${clauses[0]} and ${clauses[1]}`;
  return `${clauses.slice(0, -1).join(', ')}, and ${clauses[clauses.length - 1]}`;
}
