// ── EmoSim felt-impulse gain for per-contact social desires (psfn-framework-vcq8v.4) ──
//
// A qualified EmoSim `would_message` impulse is felt state ("I want to talk to
// someone") without a contact. Social pressure is tracked per contact, so the
// impulse contributes gain only where a relationship basis already exists:
// every desire above the pressure floor receives warm pressure proportional to
// its share of the strongest live desire. A dormant or absent desire receives
// nothing — an impulse never manufactures a desire (carved invariant in
// social-desire.ts). Pure and deterministic; persistence and the follow-on
// per-contact evaluation live with the caller.

import {
  decayedSocialDesirePressure,
  type SocialDesire,
  type SocialDesireLifecycleConfig,
} from './social-desire.js';

export interface SocialDesireImpulseInput {
  /** 0..1 source confidence of the qualified impulse. */
  confidence: number;
  /** Warm pressure the strongest live desire receives at full confidence. */
  gain: number;
}

export interface SocialDesireImpulseBoost {
  desire: SocialDesire;
  added: number;
}

export function applySocialDesireImpulseGain(
  desires: readonly SocialDesire[],
  input: SocialDesireImpulseInput,
  config: SocialDesireLifecycleConfig,
  nowMs: number,
): SocialDesireImpulseBoost[] {
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new Error(`Social desire impulse confidence must be within [0, 1], received ${String(input.confidence)}`);
  }
  if (!Number.isFinite(input.gain) || input.gain < 0) {
    throw new Error(`Social desire impulse gain must be a finite number >= 0, received ${String(input.gain)}`);
  }
  const live = desires
    .map(desire => ({ desire, pressure: decayedSocialDesirePressure(desire, config, nowMs) }))
    .filter(entry => entry.pressure.total >= config.pressureFloor);
  const strongest = Math.max(0, ...live.map(entry => entry.pressure.total));
  if (!(strongest > 0) || input.gain === 0 || input.confidence === 0) return [];
  const anchorAt = new Date(nowMs).toISOString();
  return live.map(({ desire, pressure }) => {
    const share = pressure.total / strongest;
    const headroom = Math.max(0, config.pressureCap - pressure.total);
    const added = Math.min(headroom, input.gain * input.confidence * share);
    return {
      added,
      desire: {
        ...desire,
        warmPressure: pressure.warm + added,
        repairPressure: pressure.repair,
        pressureAnchorAt: anchorAt,
      },
    };
  }).filter(boost => boost.added > 0);
}
