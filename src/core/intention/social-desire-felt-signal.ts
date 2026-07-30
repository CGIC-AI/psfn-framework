// ── Social-desire felt-signal derivation + writer (psfn-framework-hrmrq.85) ──
//
// The accumulation half of the social-desire lane. social-desire.ts carves the
// invariant that pressure derives ONLY from felt state via the emotion/appraisal
// signal path — but until hrmrq.85 recordSocialDesireFeltSignal had zero
// production callers, so socialDesire.enabled registered a consent-moment lane
// over a store nothing could ever write. This module closes that gap:
//
//  - `deriveSocialDesireFeltSignal` is the PURE projection from the per-turn
//    emotion-appraisal state snapshot (the exact felt state the emotion path
//    already persists into the durable emotion_appraisal background job) to a
//    SocialDesireFeltSignal. Deterministic, zero LLM, zero I/O.
//  - `createSocialDesireFeltSignalWriter` binds the derivation to the durable
//    store through recordSocialDesireFeltSignal — the single documented write
//    entry. The writer is composed at boot and threaded into the post-turn
//    emotion-appraisal branch (see background-work/post-turn-runtime.ts); the
//    social-desire lane registration fails closed when the lane is enabled and
//    no writer was composed.
//
// Derivation semantics:
//  - contact: the appraisal snapshot's relational.contactId (the canonical
//    contact key of the turn partner). Internal channels / group rooms with no
//    bound contact produce no signal.
//  - orientation: the sign of her felt valence in that conversation scope —
//    positive → 'warm' (wanting to connect), negative → 'repair'
//    (negative-origin desire to talk it over). Exactly zero valence is the
//    "nothing is felt" case.
//  - intensity: |valence| scaled by the emotion pipeline's own confidence in
//    the automata-derived state. Zero confidence fails closed to zero intensity
//    — an unattributed emotional read never accumulates relational pressure.
//
// Over-counting is handled downstream by design: the tier cadence throttle
// (tickGapMs) absorbs repeated signals inside the natural think-about-them
// cadence, so one signal per recorded turn is the intended input rate.

import type { EmotionAppraisalStateSnapshot } from '../emotion/appraisal-state.js';
import {
  recordSocialDesireFeltSignal,
  type RecordSocialDesireFeltSignalResult,
  type SocialDesireRelationshipTierSource,
  type SocialDesireStorePort,
} from './social-desire-store-port.js';
import type {
  SocialDesireFeltSignal,
  SocialDesireLifecycleConfig,
} from './social-desire.js';

/**
 * Project one per-turn emotion-appraisal state snapshot to a felt social
 * signal, or null when nothing accumulable was felt (no bound contact, zero
 * valence, or zero pipeline confidence).
 */
export function deriveSocialDesireFeltSignal(
  appraisalState: EmotionAppraisalStateSnapshot,
  sourceRef: string,
): SocialDesireFeltSignal | null {
  const contactId = appraisalState.relational.contactId?.trim();
  if (!contactId) return null;
  const valence = appraisalState.emotional.vad.valence;
  const confidence = appraisalState.emotional.confidence;
  if (!Number.isFinite(valence) || !Number.isFinite(confidence)) {
    // The snapshot parser already rejects non-finite values; fail closed here
    // too so a malformed snapshot can never manufacture relational pressure.
    return null;
  }
  const intensity = Math.min(1, Math.abs(valence)) * Math.min(1, Math.max(0, confidence));
  if (intensity === 0) return null;
  return {
    contactId,
    orientation: valence > 0 ? 'warm' : 'repair',
    intensity,
    sourceRef,
  };
}

/**
 * The production accumulation writer: derives a felt signal from the turn's
 * appraisal state and records it through the store's single write entry.
 * Errors propagate (fail closed) — the durable background job that hosts the
 * call owns retry semantics.
 */
export interface SocialDesireFeltSignalWriter {
  record(
    appraisalState: EmotionAppraisalStateSnapshot,
    input: { sourceRef: string; nowMs: number },
  ): Promise<RecordSocialDesireFeltSignalResult | null>;
}

export function createSocialDesireFeltSignalWriter(deps: {
  store: Pick<SocialDesireStorePort, 'getByContactId' | 'save'>;
  tierSource: SocialDesireRelationshipTierSource;
  lifecycle: SocialDesireLifecycleConfig;
}): SocialDesireFeltSignalWriter {
  return {
    record: async (appraisalState, input) => {
      const signal = deriveSocialDesireFeltSignal(appraisalState, input.sourceRef);
      if (!signal) return null;
      return await recordSocialDesireFeltSignal(
        deps.store,
        deps.tierSource,
        deps.lifecycle,
        signal,
        input.nowMs,
      );
    },
  };
}
