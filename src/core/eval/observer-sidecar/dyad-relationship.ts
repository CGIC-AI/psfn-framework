/**
 * emo_sim directed A->B relationship state -> companion advisory.
 *
 * The pinned emo_sim server (`emo_sim/server.py#http-api.v1`, SHA
 * 854ce6a787a29911008b193629a8f8e51d7f9507) exposes a top-level `relationships`
 * map in the `?full=1` session snapshot. That map is FLAT: each key is the two
 * participant NAMES joined by the literal `->` separator (`"<source>-><target>"`,
 * statemashine.py) and each value is a record carrying `from`/`to` participant
 * uids, the directed `liking` / `trust` / `dominance` / `familiarity`
 * dimensions, and a `feelings` emotion-delta map (top emotions). This module
 * reads the companion agent's OUTGOING directed relationships (source name = the
 * companion) from that map and renders them as a companion-readable ADVISORY
 * prose reading.
 *
 * Two hard constraints from the oth4 adjudication and repo working rules:
 *
 * 1. Advisory-only, non-authoritative. Nothing here mutates relationship or
 *    trust state. It is one signal the companion weighs in her end-of-day
 *    review, provenance-marked as classifier-adjacent inference (twa0), never
 *    an automatic promoter/demoter.
 *
 * 2. Fail-closed on malformed, fail-soft to omission. The parser reads the
 *    documented dimensions defensively and returns `null` on anything it cannot
 *    understand (a key without the `->` separator, a non-record value, no numeric
 *    dimension) — it never throws into the sidecar observation and never
 *    fabricates a neutral reading (charter 8.5). At the pinned HEAD the synthetic
 *    `baseline-anchor` NPC is the ONLY other agent in the session, so the only
 *    directed relationship the companion can have is toward that anchor — which
 *    the caller excludes as a session artifact. Real dyads therefore appear only
 *    once upstream per-contact work (e.g. oth4.5) seeds the companion's actual
 *    contacts as session agents; until then this correctly degrades to no signal.
 */
import type { EmotionTelemetryProvenance } from '../../../shared/contracts/emotion-contracts.js';
import type { DyadRelationshipAdvisory } from '../../../shared/contracts/dyad-relationship-advisory.js';
import { isRecord } from '../../../shared/utils/types.js';

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
const EMOTION_MAP_KEYS = ['feelings', 'emotions', 'emotion_deltas', 'emotionDeltas', 'kicks'] as const;

/** Literal separator joining source and target NAMES in an emo_sim relationship key. */
const RELATIONSHIP_KEY_SEPARATOR = '->' as const;

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
 *
 * The pinned emo_sim server (statemashine.py) emits `relationships` as a FLAT
 * map keyed by the two participant NAMES joined by the literal `->` separator
 * (`"<source>-><target>"`), each value a record carrying `from`/`to` uids, the
 * four directed dimensions, and a `feelings` emotion-delta map. This reads the
 * entries whose SOURCE name is the companion, excludes the configured target
 * names (e.g. the synthetic anchor NPC), and averages the dimensions present.
 */
export function parseEmoSimDirectedRelationshipReading(
  rawSessionState: unknown,
  options: ParseDirectedRelationshipOptions,
): EmoSimDirectedRelationshipReading | null {
  if (!isRecord(rawSessionState)) return null;
  const relationships = rawSessionState.relationships;
  if (!isRecord(relationships)) return null;

  const exclude = new Set(options.excludeTargets ?? []);
  const liking: number[] = [];
  const trust: number[] = [];
  const dominance: number[] = [];
  const familiarity: number[] = [];
  let topEmotionShift: { label: string; delta: number } | null = null;
  let contributingTargets = 0;

  for (const [key, record] of Object.entries(relationships)) {
    const dyad = splitRelationshipKey(key);
    // Not-understood key shape (no `->` separator, empty source/target): skip.
    if (dyad === null) continue;
    if (dyad.source !== options.agentName) continue;
    if (exclude.has(dyad.target)) continue;
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

/**
 * Split an emo_sim relationship key `"<source>-><target>"` into its two
 * participant NAMES. Returns `null` for any key lacking the `->` separator or
 * with an empty source/target — those are not-understood and skipped. Splits on
 * the FIRST separator so a target name is preserved intact even in the (unlikely)
 * event it embeds the separator sequence.
 */
function splitRelationshipKey(key: string): { source: string; target: string } | null {
  const at = key.indexOf(RELATIONSHIP_KEY_SEPARATOR);
  if (at < 0) return null;
  const source = key.slice(0, at);
  const target = key.slice(at + RELATIONSHIP_KEY_SEPARATOR.length);
  if (source.length === 0 || target.length === 0) return null;
  return { source, target };
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
