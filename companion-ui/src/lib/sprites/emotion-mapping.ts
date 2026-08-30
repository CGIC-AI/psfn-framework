// Sprite v2 emotion + tool mapping (bead psfn-framework-7ang.3).
//
// Pure functions that project a redacted `emotion.snapshot` and the latest
// `tool.activity` entry into the `SpriteResolveInput` fields the catalog seam
// already understands (base / toolDomain / toolPhase). This is the ONLY place
// the three-layer model lives; the catalog (catalog.ts) keeps its single
// priority ladder (touch > tool > base) and is NOT forked.
//
// Design contract from the bead:
//   - emotional BASE picked by VAD quadrant (~16 bases), REFINED by a strong
//     discrete-emotion label, with a MANDATORY fallback to the VAD base for any
//     unknown / open-vocabulary label (the classifier emits up to 28 labels).
//   - tool.activity split into 7 domain buckets via a toolName -> tool-domain
//     table mirrored from src/core/agent/tool-surface/registry.ts.
//   - missing / stale data degrades to a neutral default (never blank, never a
//     stuck expression), so every read is time-gated against `receivedAt`.

import type {
  EmotionSnapshotStreamEntry,
  ToolActivityStreamEntry,
} from '../stream/hub-stream.js';
import type { FirstPartyToolDomain } from '../../../../src/core/agent/tool-surface/registry.js';
import type { EmotionVector } from '../protocol/events.js';
import {
  EMOTIONAL_BASES,
  type EmotionalBase,
  type ToolDomain,
  type ToolPhase,
} from './taxonomy.js';

// ─────────────────────────────────────────────────────────────────────────────
// Staleness windows. Frames arrive at most a few per turn, so a value is only
// honoured while fresh; past the window the layer clears to its default. This
// is what prevents a stuck expression or an endlessly looping tool animation.
// ─────────────────────────────────────────────────────────────────────────────

/** Beyond this age an emotion snapshot decays to the operational default. */
export const EMOTION_SNAPSHOT_STALE_MS = 120_000;
/** A running tool (`started`/`progress`) with no terminal frame clears after this. */
export const TOOL_STARTED_STALE_MS = 45_000;
/** A terminal tool frame (`completed`/`failed`) holds its one-shot for this long. */
export const TOOL_DONE_HOLD_MS = 5_000;

// ─────────────────────────────────────────────────────────────────────────────
// VAD-quadrant base. Valence sign selects the affective family; arousal selects
// energy; dominance splits activated-negative into anger (in control -> grumpy)
// vs fear (out of control -> anxious). Thresholds are boundary-inclusive on the
// stated side and covered by tests.
// ─────────────────────────────────────────────────────────────────────────────

/** |valence| at/above this counts as clearly positive or negative. */
const VALENCE_MARGIN = 0.15;
/** |arousal| below this (with flat valence) is treated as flat/at-rest. */
const AROUSAL_FLAT = 0.15;
/** Negative valence with arousal below this reads as drowsy -> tired. */
const AROUSAL_DROWSY = 0;
/** Arousal below this (given clear valence) is the calm band. */
const AROUSAL_CALM = 0.35;
/** Arousal at/above this is the high-energy band. */
const AROUSAL_HIGH = 0.6;

export function vadQuadrantBase(vector: EmotionVector): EmotionalBase {
  const { valence, arousal, dominance } = vector;
  if (valence >= VALENCE_MARGIN) {
    if (arousal < AROUSAL_CALM) return 'content';
    if (arousal < AROUSAL_HIGH) return 'happy';
    return 'excited';
  }
  if (valence <= -VALENCE_MARGIN) {
    if (arousal < AROUSAL_DROWSY) return 'tired';
    if (arousal < AROUSAL_CALM) return 'sad';
    return dominance >= 0 ? 'grumpy' : 'anxious';
  }
  // Near-neutral valence: only strong arousal is expressive (surprise).
  if (arousal >= AROUSAL_HIGH) return 'surprised';
  return 'neutral';
}

// ─────────────────────────────────────────────────────────────────────────────
// Discrete-label overlay. A strong discrete label refines the base to an
// expression the coarse VAD quadrant cannot distinguish (love vs happy,
// surprised vs excited, smug vs content, ...). The map is intentionally
// open-vocabulary: any label NOT present here leaves the VAD base untouched.
// ─────────────────────────────────────────────────────────────────────────────

/** A discrete label must score at least this to override the VAD base. */
export const DISCRETE_OVERRIDE_MIN = 0.4;

const DISCRETE_BASE: ReadonlyMap<string, EmotionalBase> = new Map([
  ['love', 'love'], ['caring', 'love'], ['desire', 'love'], ['admiration', 'love'],
  ['surprise', 'surprised'], ['realization', 'surprised'],
  ['amusement', 'laughing'],
  ['excitement', 'excited'],
  ['joy', 'happy'], ['gratitude', 'happy'],
  ['optimism', 'content'], ['relief', 'content'], ['calm', 'content'],
  ['approval', 'content'], ['trust', 'content'],
  ['pride', 'smug'],
  ['curiosity', 'curious'], ['confusion', 'curious'], ['anticipation', 'curious'],
  ['embarrassment', 'embarrassed'],
  ['fear', 'anxious'], ['nervousness', 'anxious'],
  ['anger', 'grumpy'], ['annoyance', 'grumpy'], ['disgust', 'grumpy'], ['disapproval', 'grumpy'],
  ['sadness', 'sad'], ['disappointment', 'sad'], ['grief', 'sad'],
  ['remorse', 'sad'], ['pessimism', 'sad'],
  ['neutral', 'neutral'],
] as const satisfies ReadonlyArray<readonly [string, EmotionalBase]>);

function strongestDiscreteLabel(
  discrete: ReadonlyArray<{ label: string; score: number }>,
): { label: string; score: number } | null {
  if (discrete.length === 0) return null;
  // The wire contract sends these descending, but pick the max explicitly so a
  // mis-ordered frame can never select a weaker label.
  let best = discrete[0]!;
  for (const entry of discrete) {
    if (entry.score > best.score) best = entry;
  }
  return best;
}

/**
 * Emotional base for a snapshot: VAD quadrant, refined by a strong discrete
 * label. VAD is authoritative; mood is consulted only when VAD is flat (so a
 * settled companion still reads its background mood). Unknown labels always
 * fall back to the VAD base.
 */
export function emotionalBaseFromSnapshot(snapshot: EmotionSnapshotStreamEntry): EmotionalBase {
  const vadFlat = Math.abs(snapshot.vad.valence) < VALENCE_MARGIN
    && Math.abs(snapshot.vad.arousal) < AROUSAL_FLAT;
  const source = vadFlat ? snapshot.mood : snapshot.vad;
  const base = vadQuadrantBase(source);

  const top = strongestDiscreteLabel(snapshot.discrete);
  if (top && top.score >= DISCRETE_OVERRIDE_MIN) {
    const refined = DISCRETE_BASE.get(top.label.trim().toLowerCase());
    if (refined && EMOTIONAL_BASES.includes(refined)) return refined;
  }
  return base;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool-domain buckets. `tool.activity.data.tool` is the raw tool NAME (see
// src/channels/backplane/companion-relay/redaction.ts). Map name -> canonical
// FirstPartyToolDomain -> one of the 7 sprite icon buckets. Both tables are a
// MIRROR of src/core/agent/tool-surface/registry.ts and are drift-guarded by
// emotion-mapping.test.ts (which imports the real registry). An unknown tool
// name degrades to the default `wrench` bucket (fail-visible, matches the
// catalog's DEFAULT_TOOL_DOMAIN).
// ─────────────────────────────────────────────────────────────────────────────

/** Default icon bucket for an unrecognised tool name (matches catalog default). */
export const DEFAULT_TOOL_ICON: ToolDomain = 'wrench';

/** FirstPartyToolDomain -> sprite icon bucket (16 domains -> 7 icons). */
export const TOOL_DOMAIN_ICON: Readonly<Record<FirstPartyToolDomain, ToolDomain>> = Object.freeze({
  memory: 'notebook',
  knowledge: 'notebook',
  analysis: 'magnifier',
  orientation: 'magnifier',
  boundary: 'wrench',
  system: 'wrench',
  tracked_work: 'wrench',
  identity: 'wrench',
  media: 'painting',
  self_expression: 'painting',
  contacts: 'envelope',
  sessions: 'envelope',
  notification: 'envelope',
  scheduler: 'clock',
  subagents: 'clones',
  adaptive_tooling: 'clones',
});

/** Canonical tool NAME -> FirstPartyToolDomain (mirror of registry entries). */
export const TOOL_NAME_DOMAIN: Readonly<Record<string, FirstPartyToolDomain>> = Object.freeze({
  tool_search: 'adaptive_tooling',
  toolset: 'adaptive_tooling',
  response_control: 'system',
  fs: 'boundary',
  repo: 'boundary',
  shell: 'boundary',
  mcp: 'boundary',
  web: 'boundary',
  world: 'boundary',
  analysis_workbench: 'analysis',
  orient: 'orientation',
  identity: 'identity',
  memory: 'memory',
  scratchpad: 'memory',
  automata_bus: 'memory',
  contact: 'contacts',
  session: 'sessions',
  self_status: 'system',
  system: 'system',
  skill: 'knowledge',
  wiki: 'knowledge',
  schedule: 'scheduler',
  north_star: 'orientation',
  beads: 'tracked_work',
  notify: 'notification',
  generate_image: 'media',
  selfie_create: 'self_expression',
  publication: 'self_expression',
  letter: 'self_expression',
  subagent: 'subagents',
  vault: 'knowledge',
  journal: 'memory',
});

/** Map a raw tool name to its sprite icon bucket (never null: default wrench). */
export function toolIconForName(toolName: string): ToolDomain {
  const domain = TOOL_NAME_DOMAIN[toolName.trim()];
  return domain ? TOOL_DOMAIN_ICON[domain] : DEFAULT_TOOL_ICON;
}

/** Map a tool.activity phase to a sprite tool phase (`progress` reuses `started`). */
export function toolPhaseForActivity(
  phase: ToolActivityStreamEntry['phase'],
): ToolPhase {
  switch (phase) {
    case 'started':
    case 'progress':
      return 'started';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Combined derivation. Produces the three sprite inputs, each independently
// time-gated so absent/stale data degrades rather than sticking.
// ─────────────────────────────────────────────────────────────────────────────

export interface SpriteInputSources {
  /** Latest redacted emotion snapshot, or null. */
  readonly emotion: EmotionSnapshotStreamEntry | null;
  /** Most recent tool-activity entry, or null. */
  readonly toolActivity: ToolActivityStreamEntry | null;
  /** Current time in epoch ms (injected for testability / staleness). */
  readonly nowMs: number;
}

export interface DerivedSpriteInputs {
  readonly base: EmotionalBase | null;
  readonly toolDomain: ToolDomain | null;
  readonly toolPhase: ToolPhase | null;
}

function ageMs(receivedAt: string, nowMs: number): number {
  const received = Date.parse(receivedAt);
  // A malformed timestamp is treated as infinitely stale (fail-visible: drop it).
  return Number.isNaN(received) ? Number.POSITIVE_INFINITY : nowMs - received;
}

/**
 * Derive `{ base, toolDomain, toolPhase }` for `resolveSpriteEntryId`. A fresh
 * emotion snapshot drives the base; a stale/absent one yields `base: null` so
 * the catalog uses its per-operational-state default. A running tool shows its
 * loop while fresh; a terminal tool shows its one-shot briefly then clears.
 */
export function deriveSpriteInputs(sources: SpriteInputSources): DerivedSpriteInputs {
  const { emotion, toolActivity, nowMs } = sources;

  const base = emotion && ageMs(emotion.receivedAt, nowMs) <= EMOTION_SNAPSHOT_STALE_MS
    ? emotionalBaseFromSnapshot(emotion)
    : null;

  let toolDomain: ToolDomain | null = null;
  let toolPhase: ToolPhase | null = null;
  if (toolActivity) {
    const age = ageMs(toolActivity.receivedAt, nowMs);
    const phase = toolPhaseForActivity(toolActivity.phase);
    const withinWindow = phase === 'started'
      ? age <= TOOL_STARTED_STALE_MS
      : age <= TOOL_DONE_HOLD_MS;
    if (withinWindow) {
      toolDomain = toolIconForName(toolActivity.tool);
      toolPhase = phase;
    }
  }

  return { base, toolDomain, toolPhase };
}
