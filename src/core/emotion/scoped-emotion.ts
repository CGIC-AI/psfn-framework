import type {
  ConversationScope,
  GroupConversationScope,
} from '../session/conversation-scope.js';
import type { EmotionCarryOverSettings } from '../../system/config/emotion-scoping-config.js';
import type { EmotionStateSnapshot, VADVector } from './state.js';

// ── Scoped emotion primitives (bead E1.5) ──
//
// KEYING AUDIT (state of the world this module changes):
//
// Before E1.5, the companion's affect layer was keyed to a SINGLE active
// CHANNEL, not to a scope or a contact:
//  - `EmotionSelfModelRuntime` held ONE `EmotionState` cached under one
//    `emotionStateSessionId` (= resolveSessionChannelId(channelId)). Switching
//    channels re-hydrated that single slot from the channel's session-message
//    metadata (`emotionState` key). So a DM and a room on the same process
//    fought over one slot, and the companion "mood" (the EMA inside that one
//    EmotionState) was per-channel, not global.
//  - The appraisal chain (`EmotionAppraisal.sessionState`) was keyed by the
//    same channel id, in-memory only (not persisted).
//  - Per-contact `emotionalBaseline` (contacts store) is a SEPARATE thing:
//    it is her read of the CONTACT, not her own mood, and E1.5 leaves it alone.
//
// This module supplies the pure pieces for the operator-ratified model:
//  - per-scope transient state keyed by `scope.key` ('dm:<id>' | 'room:<id>');
//  - a SEPARATE companion-global mood baseline that scope moods modulate (EMA)
//    and that seeds freshly-observed scopes;
//  - a bounded, fast-decaying, DIRECTIONAL carry-over modifier (group→DM only,
//    member-gated) that is applied additively on top of a scope's snapshot.
//
// Direction rules (enforced in `deriveCarryOverModifier`):
//  - group → DM: allowed, ONLY when the DM contact is a member of that group;
//  - DM → group: NEVER (a group never inherits a DM's affect);
//  - DM → DM: no modifier — same canonical contact shares one scope.key across
//    channels (so state is shared, not carried), and different contacts have
//    different keys (so an unrelated DM sees zero delta);
//  - group → group: no modifier (rooms are independent).

const CLAMP_MIN = -1;
const CLAMP_MAX = 1;

export interface EmotionCarryOverModifier {
  /** Signed per-axis VAD nudge captured at switch time (pre-decay). */
  readonly vad: VADVector;
  /** Wall-clock ms when the modifier was created. */
  readonly appliedAtMs: number;
  /** Half-life (seconds) governing this modifier's decay. */
  readonly halfLifeSeconds: number;
  /** Scope key of the group the modifier was carried from (provenance/telemetry). */
  readonly sourceScopeKey: string;
}

function clampSigned(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(CLAMP_MIN, Math.min(CLAMP_MAX, value));
}

function clampMagnitude(value: number, maxMagnitude: number): number {
  const bound = Math.max(0, maxMagnitude);
  return Math.max(-bound, Math.min(bound, value));
}

function decayFactor(halfLifeSeconds: number, elapsedSeconds: number): number {
  if (halfLifeSeconds <= 0) return 0;
  if (elapsedSeconds <= 0) return 1;
  return Math.exp((-Math.LN2 * elapsedSeconds) / halfLifeSeconds);
}

function maxAxisMagnitude(vad: VADVector): number {
  return Math.max(Math.abs(vad.valence), Math.abs(vad.arousal), Math.abs(vad.dominance));
}

/**
 * Membership gate: is the DM contact a member of the group room?
 *
 * Trusts the same two signals retrieval room-visibility already trusts:
 *  - the group scope's recent-speaker roster (authorId match), and
 *  - the contact's own room membership (canonicalContactRoomIds: the group's
 *    channelId appears in the contact's conversationChannels).
 * Either signal is sufficient; both are conservative (no membership → no carry).
 */
export function isDmContactGroupMember(input: {
  dmContactId: string;
  groupScope: GroupConversationScope;
  contactRoomIds?: ReadonlySet<string>;
}): boolean {
  const contactId = input.dmContactId.trim();
  if (!contactId) return false;
  for (const speaker of input.groupScope.recentSpeakers) {
    if (speaker.authorId === contactId) return true;
  }
  if (input.contactRoomIds?.has(input.groupScope.channelId)) return true;
  return false;
}

/**
 * Directional carry-over derivation. Returns a bounded modifier only for the
 * one allowed transition (group → member DM); every other transition — and any
 * modifier that lands below the configured `minEffectThreshold` — returns null.
 */
export function deriveCarryOverModifier(input: {
  previousScope: ConversationScope;
  /** Source (group) scope's current transient VAD. */
  previousScopeVad: VADVector;
  currentScope: ConversationScope;
  /** Precomputed membership of the DM contact in the previous group scope. */
  dmContactIsGroupMember: boolean;
  nowMs: number;
  config: EmotionCarryOverSettings;
}): EmotionCarryOverModifier | null {
  if (!input.config.enabled) return null;
  // Only a DM scope may RECEIVE a modifier (DM→group / group→group never).
  if (input.currentScope.kind !== 'dm') return null;
  // Only a group scope may SOURCE a modifier (DM→DM never).
  if (input.previousScope.kind !== 'group') return null;
  // Member-gated: an unrelated / non-member DM contact carries nothing.
  if (!input.dmContactIsGroupMember) return null;

  const strength = Math.max(0, Math.min(1, input.config.modifierStrength));
  const vad: VADVector = {
    valence: clampMagnitude(input.previousScopeVad.valence * strength, input.config.modifierMaxMagnitude),
    arousal: clampMagnitude(input.previousScopeVad.arousal * strength, input.config.modifierMaxMagnitude),
    dominance: clampMagnitude(input.previousScopeVad.dominance * strength, input.config.modifierMaxMagnitude),
  };
  if (maxAxisMagnitude(vad) < input.config.minEffectThreshold) return null;

  return {
    vad,
    appliedAtMs: input.nowMs,
    halfLifeSeconds: input.config.halfLifeSeconds,
    sourceScopeKey: input.previousScope.key,
  };
}

/** Live-decayed value of a carry-over modifier at `nowMs`. */
export function decayCarryOverModifier(
  modifier: EmotionCarryOverModifier,
  nowMs: number,
): VADVector {
  const elapsedSeconds = Math.max(0, (nowMs - modifier.appliedAtMs) / 1000);
  const factor = decayFactor(modifier.halfLifeSeconds, elapsedSeconds);
  return {
    valence: clampSigned(modifier.vad.valence * factor),
    arousal: clampSigned(modifier.vad.arousal * factor),
    dominance: clampSigned(modifier.vad.dominance * factor),
  };
}

/** True once the decayed modifier has dropped below the effect threshold. */
export function carryOverModifierIsSpent(
  modifier: EmotionCarryOverModifier,
  nowMs: number,
  minEffectThreshold: number,
): boolean {
  return maxAxisMagnitude(decayCarryOverModifier(modifier, nowMs)) < minEffectThreshold;
}

/**
 * Apply a decayed carry-over VAD on top of a scope snapshot. Only the transient
 * `vad` is nudged (bounded to [-1, 1]); mood/discrete/confidence are untouched,
 * so the modifier is a surface modulation, not a mutation of stored state.
 */
export function applyCarryOverToSnapshot(
  snapshot: EmotionStateSnapshot,
  decayedVad: VADVector,
): EmotionStateSnapshot {
  return {
    vad: {
      valence: clampSigned(snapshot.vad.valence + decayedVad.valence),
      arousal: clampSigned(snapshot.vad.arousal + decayedVad.arousal),
      dominance: clampSigned(snapshot.vad.dominance + decayedVad.dominance),
    },
    mood: { ...snapshot.mood },
    discrete: { ...snapshot.discrete },
    confidence: snapshot.confidence,
  };
}

/**
 * EMA blend of the companion-global mood baseline toward a scope's post-update
 * mood. This is how per-scope states MODULATE (not replace) her overall mood:
 * every scope nudges the single shared baseline a little.
 */
export function blendGlobalMoodBaseline(
  baseline: VADVector,
  scopeMood: VADVector,
  alpha: number,
): VADVector {
  const rate = Math.max(0, Math.min(1, alpha));
  return {
    valence: clampSigned(baseline.valence + (scopeMood.valence - baseline.valence) * rate),
    arousal: clampSigned(baseline.arousal + (scopeMood.arousal - baseline.arousal) * rate),
    dominance: clampSigned(baseline.dominance + (scopeMood.dominance - baseline.dominance) * rate),
  };
}

export function neutralVad(): VADVector {
  return { valence: 0, arousal: 0, dominance: 0 };
}
