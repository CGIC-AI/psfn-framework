import { describe, expect, it } from 'vitest';
import {
  createDmConversationScope,
  createGroupConversationScope,
} from '../session/conversation-scope.js';
import { createDefaultEmotionScopingSettings } from '../../system/config/emotion-scoping-config.js';
import {
  applyCarryOverToSnapshot,
  blendGlobalMoodBaseline,
  carryOverModifierIsSpent,
  decayCarryOverModifier,
  deriveCarryOverModifier,
  isDmContactGroupMember,
} from './scoped-emotion.js';
import type { EmotionStateSnapshot, VADVector } from './state.js';

const CONFIG = createDefaultEmotionScopingSettings();
const CARRY = CONFIG.carryOver;
const HOT_VAD: VADVector = { valence: -0.8, arousal: 1, dominance: 0.6 };

const groupScope = createGroupConversationScope({
  channelId: 'roomR',
  recentSpeakers: [{ authorId: 'contactA', name: 'A' }],
});
const dmMember = createDmConversationScope({
  channelId: 'chanA',
  contact: { contactId: 'contactA' },
});
const dmNonMember = createDmConversationScope({
  channelId: 'chanB',
  contact: { contactId: 'contactB' },
});

function snapshot(vad: VADVector): EmotionStateSnapshot {
  return { vad, mood: { valence: 0, arousal: 0, dominance: 0 }, discrete: {}, confidence: 0.5 };
}

describe('deriveCarryOverModifier direction gate', () => {
  const base = { previousScopeVad: HOT_VAD, dmContactIsGroupMember: true, nowMs: 1000, config: CARRY };

  it('carries group→DM for a group member (bounded)', () => {
    const mod = deriveCarryOverModifier({
      ...base,
      previousScope: groupScope,
      currentScope: dmMember,
    });
    expect(mod).not.toBeNull();
    expect(mod!.sourceScopeKey).toBe('room:roomR');
    // strength 0.5 * arousal 1 = 0.5, clamped to modifierMaxMagnitude 0.35.
    expect(mod!.vad.arousal).toBeCloseTo(CARRY.modifierMaxMagnitude, 5);
    expect(Math.abs(mod!.vad.valence)).toBeLessThanOrEqual(CARRY.modifierMaxMagnitude);
  });

  it('never carries DM→group', () => {
    expect(deriveCarryOverModifier({
      ...base,
      previousScope: dmMember,
      currentScope: groupScope,
    })).toBeNull();
  });

  it('never carries group→group', () => {
    const otherRoom = createGroupConversationScope({ channelId: 'roomS' });
    expect(deriveCarryOverModifier({
      ...base,
      previousScope: groupScope,
      currentScope: otherRoom,
    })).toBeNull();
  });

  it('never carries DM→DM (same-contact sharing handled by scope.key, not a modifier)', () => {
    expect(deriveCarryOverModifier({
      ...base,
      previousScope: dmMember,
      currentScope: dmNonMember,
    })).toBeNull();
  });

  it('gives a non-member DM zero modifier', () => {
    expect(deriveCarryOverModifier({
      ...base,
      dmContactIsGroupMember: false,
      previousScope: groupScope,
      currentScope: dmNonMember,
    })).toBeNull();
  });

  it('returns null when disabled', () => {
    expect(deriveCarryOverModifier({
      ...base,
      previousScope: groupScope,
      currentScope: dmMember,
      config: { ...CARRY, enabled: false },
    })).toBeNull();
  });

  it('returns null when the derived nudge is below the effect threshold', () => {
    expect(deriveCarryOverModifier({
      ...base,
      previousScopeVad: { valence: 0.01, arousal: 0.01, dominance: 0 },
      previousScope: groupScope,
      currentScope: dmMember,
    })).toBeNull();
  });
});

describe('carry-over decay (fast, config half-life)', () => {
  const mod = deriveCarryOverModifier({
    previousScope: groupScope,
    previousScopeVad: HOT_VAD,
    currentScope: dmMember,
    dmContactIsGroupMember: true,
    nowMs: 0,
    config: CARRY,
  })!;

  it('is still felt shortly after the switch', () => {
    expect(carryOverModifierIsSpent(mod, 60_000, CARRY.minEffectThreshold)).toBe(false);
    expect(decayCarryOverModifier(mod, 60_000).arousal).toBeGreaterThan(CARRY.minEffectThreshold);
  });

  it('decays below threshold within a small multiple of the half-life', () => {
    // 0.35 → <0.02 needs ~4.1 half-lives; 5 half-lives = 900s.
    const spentAtMs = 15 * 60 * 1000;
    expect(carryOverModifierIsSpent(mod, spentAtMs, CARRY.minEffectThreshold)).toBe(true);
    expect(decayCarryOverModifier(mod, spentAtMs).arousal).toBeLessThan(CARRY.minEffectThreshold);
  });

  it('decays monotonically', () => {
    const a = decayCarryOverModifier(mod, 30_000).arousal;
    const b = decayCarryOverModifier(mod, 90_000).arousal;
    const c = decayCarryOverModifier(mod, 300_000).arousal;
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
  });
});

describe('membership gate', () => {
  it('accepts via group recent-speaker roster', () => {
    expect(isDmContactGroupMember({ dmContactId: 'contactA', groupScope })).toBe(true);
  });

  it('accepts via contact room membership (canonicalContactRoomIds)', () => {
    expect(isDmContactGroupMember({
      dmContactId: 'contactZ',
      groupScope,
      contactRoomIds: new Set(['roomR']),
    })).toBe(true);
  });

  it('rejects a contact absent from both signals', () => {
    expect(isDmContactGroupMember({
      dmContactId: 'contactB',
      groupScope,
      contactRoomIds: new Set(['roomOther']),
    })).toBe(false);
  });
});

describe('baseline blend and snapshot modulation', () => {
  it('EMA-blends the global baseline toward a scope mood', () => {
    const blended = blendGlobalMoodBaseline(
      { valence: 0, arousal: 0, dominance: 0 },
      { valence: 1, arousal: 1, dominance: 1 },
      0.1,
    );
    expect(blended.valence).toBeCloseTo(0.1, 5);
  });

  it('adds the decayed modifier onto the transient VAD, clamped', () => {
    const decayed: VADVector = { valence: -0.3, arousal: 0.3, dominance: 0.1 };
    const effective = applyCarryOverToSnapshot(snapshot({ valence: 0.9, arousal: 0.9, dominance: 0 }), decayed);
    expect(effective.vad.arousal).toBeCloseTo(1, 5); // clamped at 1
    expect(effective.vad.valence).toBeCloseTo(0.6, 5);
    // mood/discrete/confidence untouched
    expect(effective.confidence).toBe(0.5);
  });
});
