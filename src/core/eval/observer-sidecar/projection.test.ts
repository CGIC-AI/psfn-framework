import { describe, expect, it } from 'vitest';
import type { EmotionStateSnapshot } from '../../emotion/state.js';
import {
  EMOSIM_APPRAISAL_DIMS,
  parseEmoSimAdapterInput,
  type EmoSimAppraisalVector,
} from './emosim-adapter.js';
import {
  OBSERVER_AGENCY_OTHER_UNDERDETERMINED_CAVEAT,
  OBSERVER_APPRAISAL_PROJECTION_CAVEAT,
  OBSERVER_APPRAISAL_PROJECTION_VERSION,
  OBSERVER_ATTACHMENT_NEUTRAL_PRIOR_CAVEAT,
  OBSERVER_SAFETY_NEUTRAL_PRIOR_CAVEAT,
  projectObserverEvalToEmoSim,
  type ObserverAppraisalProjectionFailure,
  type ObserverAppraisalProjectionResult,
  type ObserverAppraisalProjectionSuccess,
} from './projection.js';
import type { ObserverEvalInputPayload } from './types.js';

const RAW_SECRET = 'raw-user-secret: hidden fixture words';

const EMOTION_SNAPSHOT: EmotionStateSnapshot = {
  vad: { valence: 0.58, arousal: 0.34, dominance: 0.22 },
  mood: { valence: 0.32, arousal: 0.18, dominance: 0.12 },
  discrete: {
    joy: 0.62,
    trust: 0.44,
    curiosity: 0.3,
  },
  confidence: 0.84,
};

describe('observer sidecar appraisal projection', () => {
  it('projects complete sanitized observer data into appraisal and adapter input with provenance', () => {
    const result = projectObserverEvalToEmoSim(withRawLeakFields(makeObserverInput()));

    expectSuccess(result);
    expect(result.schemaVersion).toBe(1);
    expect(result.projectionVersion).toBe('psfn.observer-sidecar.appraisal-projection.v2');
    expect(result.source).toBe('observer-derived');
    expect(result.projectedAppraisal.dimensions).toEqual(result.adapterInput.stimulus.appraisal);
    expect(Object.keys(result.projectedAppraisal.dimensions)).toEqual([...EMOSIM_APPRAISAL_DIMS]);
    expect(parseEmoSimAdapterInput(result.adapterInput)).toEqual(result.adapterInput);
    expect(result.confidence).toBeGreaterThan(0.85);
    expect(result.missingInputs).toEqual([]);
    expect(result.projectedAppraisal.privacyClass).toBe('public');
    expect(result.projectedAppraisal.sensitivity).toBe('public');
    expect(result.projectedAppraisal.caveats).toContain(OBSERVER_APPRAISAL_PROJECTION_CAVEAT);
    expect(result.projectedAppraisal.dimensionProvenance.valence.provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'observer-emotion-snapshot',
          path: 'emotion.snapshot',
        }),
        expect.objectContaining({
          source: 'observer-privacy-decision',
          privacyClass: 'public',
        }),
      ]),
    );
    expect(result.adapterInput.stimulus.appraisal.gain).toBeGreaterThan(
      result.adapterInput.stimulus.appraisal.loss,
    );
    expect(result.adapterInput.stimulus.appraisal.agency_other).toBeGreaterThan(
      result.adapterInput.stimulus.appraisal.agency_self,
    );
    expectNoRawLeak(result);
  });

  it('keeps sparse null emotion data projectable while surfacing missing inputs and lower confidence', () => {
    const result = projectObserverEvalToEmoSim(makeObserverInput({
      emotion: {
        snapshot: null,
        appraisalEntryCount: 0,
      },
      metadata: {
        trustLevel: 'regular',
        speakerRole: 'user',
        contactResolved: false,
        contentLength: 0,
        attachmentCount: 0,
        hasVisionInput: false,
        sensitivity: 'public',
      },
    }));

    expectSuccess(result);
    expect(parseEmoSimAdapterInput(result.adapterInput)).toEqual(result.adapterInput);
    expect(result.confidence).toBeLessThan(0.35);
    expect(result.projectedAppraisal.dimensions.valence).toBe(0);
    expect(result.missingInputs.map((missing) => missing.reason)).toEqual(
      expect.arrayContaining([
        'emotion_snapshot_missing',
        'emotion_discrete_empty',
        'appraisal_chain_empty',
        'content_length_empty',
        'contact_unresolved',
      ]),
    );
    expect(result.projectedAppraisal.dimensionProvenance.certainty.provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'observer-turn-metadata',
        }),
      ]),
    );
  });

  it('fails closed for privacy-redacted data before building an EmoSim adapter input', () => {
    const result = projectObserverEvalToEmoSim(withRawLeakFields(makeObserverInput({
      metadata: {
        trustLevel: 'regular',
        speakerRole: 'user',
        contactResolved: true,
        contentLength: RAW_SECRET.length,
        attachmentCount: 0,
        hasVisionInput: false,
      },
    })));

    expectFailure(result);
    expect(result.privacy).toMatchObject({
      privacyClass: 'fail_closed',
      derivedTelemetryPermitted: false,
      redactionReason: 'missing_sensitivity_metadata',
    });
    expect(result.error).toMatchObject({
      code: 'projection-unavailable',
      reason: 'privacy-derived-telemetry-unavailable',
      recoverable: true,
    });
    expect(result.missingInputs.map((missing) => missing.reason)).toEqual(
      expect.arrayContaining([
        'derived_telemetry_not_permitted',
        'emotion_snapshot_redacted',
        'sensitivity_missing',
      ]),
    );
    expect(Object.hasOwn(result, 'adapterInput')).toBe(false);
    expectNoRawLeak(result);
  });

  it('uses explicit direct fixture appraisal dimensions for eval scenarios', () => {
    const fixtureAppraisal = makeFixtureAppraisal();
    const result = projectObserverEvalToEmoSim(makeObserverInput(), {
      directFixtureAppraisal: {
        appraisal: fixtureAppraisal,
        confidence: 0.92,
        label: 'fixture warm direct',
      },
      runId: 'fixture-run',
    });

    expectSuccess(result);
    expect(result.source).toBe('direct-fixture-appraisal');
    expect(result.projectedAppraisal.source).toBe('direct-fixture-appraisal');
    expect(result.confidence).toBeGreaterThan(0.9);
    expect(result.adapterInput.runId).toBe('fixture-run');
    expect(result.adapterInput.stimulus.label).toBe('fixture warm direct');
    expect(result.adapterInput.stimulus.appraisal).toEqual(fixtureAppraisal);
    expect(parseEmoSimAdapterInput(result.adapterInput)).toEqual(result.adapterInput);
    expect(result.projectedAppraisal.dimensionProvenance.valence.provenance).toEqual([
      expect.objectContaining({
        source: 'direct-fixture-appraisal',
        path: 'options.directFixtureAppraisal.appraisal',
      }),
    ]);
    expect(result.caveats).toEqual(
      expect.arrayContaining([
        'Direct fixture appraisal is explicit eval input, not inferred live appraisal.',
      ]),
    );
  });

  it('emits the v2 projection version on every projection surface', () => {
    expect(OBSERVER_APPRAISAL_PROJECTION_VERSION).toBe('psfn.observer-sidecar.appraisal-projection.v2');

    const result = projectObserverEvalToEmoSim(makeObserverInput());
    expectSuccess(result);
    expect(result.projectionVersion).toBe(OBSERVER_APPRAISAL_PROJECTION_VERSION);
    expect(result.projectedAppraisal.projectionVersion).toBe(OBSERVER_APPRAISAL_PROJECTION_VERSION);
    expect(result.adapterInput.stimulus.projection.source).toBe(OBSERVER_APPRAISAL_PROJECTION_VERSION);
  });

  it('projects a neutral snapshot to midpoint attachment, safety, and agency_other despite intimate static context', () => {
    const result = projectLiveContextSnapshot(makeSnapshot());

    expectSuccess(result);
    const dims = result.projectedAppraisal.dimensions;
    // Static context (primary trust, direct message, resolved contact) must not
    // inflate these dims: absent per-turn evidence they sit near the neutral midpoint.
    expect(dims.attachment).toBeGreaterThanOrEqual(0.4);
    expect(dims.attachment).toBeLessThanOrEqual(0.55);
    expect(dims.safety).toBeGreaterThanOrEqual(0.45);
    expect(dims.safety).toBeLessThanOrEqual(0.55);
    expect(dims.agency_other).toBeGreaterThanOrEqual(0.45);
    expect(dims.agency_other).toBeLessThanOrEqual(0.55);
  });

  it('raises attachment on affiliative evidence and documents the neutral prior', () => {
    const neutral = projectLiveContextSnapshot(makeSnapshot());
    const affiliative = projectLiveContextSnapshot(makeSnapshot({
      vad: { valence: 0.6, arousal: 0.25, dominance: 0.15 },
      mood: { valence: 0.45, arousal: 0.15, dominance: 0.1 },
      discrete: { love: 0.82, caring: 0.66, gratitude: 0.4, joy: 0.5 },
      confidence: 0.85,
    }));

    expectSuccess(neutral);
    expectSuccess(affiliative);
    expect(affiliative.projectedAppraisal.dimensions.attachment).toBeGreaterThan(
      neutral.projectedAppraisal.dimensions.attachment + 0.15,
    );
    expect(affiliative.projectedAppraisal.dimensions.attachment).toBeGreaterThan(0.65);
    expect(affiliative.projectedAppraisal.dimensionProvenance.attachment.caveats).toContain(
      OBSERVER_ATTACHMENT_NEUTRAL_PRIOR_CAVEAT,
    );
  });

  it('drops safety on threat evidence and documents the neutral prior', () => {
    const neutral = projectLiveContextSnapshot(makeSnapshot());
    const threatened = projectLiveContextSnapshot(makeSnapshot({
      vad: { valence: -0.6, arousal: 0.7, dominance: -0.35 },
      mood: { valence: -0.3, arousal: 0.4, dominance: -0.2 },
      discrete: { fear: 0.85, nervousness: 0.6, anger: 0.3 },
      confidence: 0.8,
    }));

    expectSuccess(neutral);
    expectSuccess(threatened);
    expect(threatened.projectedAppraisal.dimensions.safety).toBeLessThan(
      neutral.projectedAppraisal.dimensions.safety - 0.15,
    );
    expect(threatened.projectedAppraisal.dimensions.safety).toBeLessThan(0.3);
    expect(threatened.projectedAppraisal.dimensionProvenance.safety.caveats).toContain(
      OBSERVER_SAFETY_NEUTRAL_PRIOR_CAVEAT,
    );
  });

  it('derives agency_other from speaker role and other-directed labels with an explicit underdetermination caveat', () => {
    const partnerTurn = projectLiveContextSnapshot(makeSnapshot());
    const systemTurn = projectLiveContextSnapshot(makeSnapshot(), { speakerRole: 'system' });
    const otherBlame = projectLiveContextSnapshot(makeSnapshot({
      vad: { valence: -0.4, arousal: 0.5, dominance: 0.1 },
      discrete: { anger: 0.75, annoyance: 0.5 },
      confidence: 0.8,
    }));

    expectSuccess(partnerTurn);
    expectSuccess(systemTurn);
    expectSuccess(otherBlame);
    // Partner-authored turn implies more other-agency than a system turn.
    expect(partnerTurn.projectedAppraisal.dimensions.agency_other).toBeGreaterThan(
      systemTurn.projectedAppraisal.dimensions.agency_other,
    );
    // Other-directed emotion labels (other-blame) raise it above the midpoint.
    expect(otherBlame.projectedAppraisal.dimensions.agency_other).toBeGreaterThan(
      partnerTurn.projectedAppraisal.dimensions.agency_other + 0.1,
    );
    expect(partnerTurn.projectedAppraisal.dimensionProvenance.agency_other.caveats).toContain(
      OBSERVER_AGENCY_OTHER_UNDERDETERMINED_CAVEAT,
    );
  });

  it('produces meaningfully distinct appraisals across realistic snapshots with constant static context', () => {
    const battery: Array<{ label: string; snapshot: EmotionStateSnapshot }> = [
      { label: 'calm-neutral', snapshot: makeSnapshot() },
      {
        label: 'warm-affiliative',
        snapshot: makeSnapshot({
          vad: { valence: 0.62, arousal: 0.3, dominance: 0.2 },
          mood: { valence: 0.4, arousal: 0.2, dominance: 0.15 },
          discrete: { love: 0.8, caring: 0.6, joy: 0.55, gratitude: 0.45 },
          confidence: 0.85,
        }),
      },
      {
        label: 'threatened-anxious',
        snapshot: makeSnapshot({
          vad: { valence: -0.55, arousal: 0.72, dominance: -0.4 },
          mood: { valence: -0.25, arousal: 0.45, dominance: -0.2 },
          discrete: { fear: 0.82, nervousness: 0.6 },
          confidence: 0.78,
        }),
      },
      {
        label: 'angry-conflict',
        snapshot: makeSnapshot({
          vad: { valence: -0.5, arousal: 0.6, dominance: 0.35 },
          mood: { valence: -0.2, arousal: 0.35, dominance: 0.2 },
          discrete: { anger: 0.78, annoyance: 0.55, disgust: 0.3 },
          confidence: 0.8,
        }),
      },
      {
        label: 'sad-loss',
        snapshot: makeSnapshot({
          vad: { valence: -0.48, arousal: 0.15, dominance: -0.3 },
          mood: { valence: -0.35, arousal: 0.1, dominance: -0.25 },
          discrete: { sadness: 0.8, grief: 0.55, disappointment: 0.4 },
          confidence: 0.75,
        }),
      },
      {
        label: 'excited-curious',
        snapshot: makeSnapshot({
          vad: { valence: 0.45, arousal: 0.65, dominance: 0.3 },
          mood: { valence: 0.3, arousal: 0.4, dominance: 0.2 },
          discrete: { curiosity: 0.75, surprise: 0.5, joy: 0.4 },
          confidence: 0.82,
        }),
      },
    ];

    const vectors = battery.map(({ snapshot }) => {
      const result = projectLiveContextSnapshot(snapshot);
      expectSuccess(result);
      return result.projectedAppraisal.dimensions;
    });

    // The v1 disease: attachment/safety/agency_other were near-constant across all
    // live turns. v2 must spread them when the underlying affect actually differs.
    expect(stdev(vectors.map((vector) => vector.attachment))).toBeGreaterThanOrEqual(0.08);
    expect(stdev(vectors.map((vector) => vector.safety))).toBeGreaterThanOrEqual(0.1);
    expect(stdev(vectors.map((vector) => vector.agency_other))).toBeGreaterThanOrEqual(0.05);

    // Every pair of distinct snapshots must produce a distinguishable appraisal vector.
    for (let a = 0; a < vectors.length; a += 1) {
      for (let b = a + 1; b < vectors.length; b += 1) {
        const maxDiff = Math.max(
          ...EMOSIM_APPRAISAL_DIMS.map((dimension) => Math.abs(vectors[a][dimension] - vectors[b][dimension])),
        );
        expect(maxDiff).toBeGreaterThan(0.05);
      }
    }
  });
});

function makeSnapshot(overrides: Partial<EmotionStateSnapshot> = {}): EmotionStateSnapshot {
  return {
    vad: { valence: 0, arousal: 0, dominance: 0 },
    mood: { valence: 0, arousal: 0, dominance: 0 },
    discrete: {},
    confidence: 0.7,
    ...overrides,
  };
}

/**
 * Projects a snapshot inside a static high-intimacy context (primary trust, direct
 * message, resolved contact) that mirrors the live single-partner deployment where
 * v1 attachment/safety/agency_other collapsed into near-constants.
 */
function projectLiveContextSnapshot(
  snapshot: EmotionStateSnapshot,
  metadataOverrides: Partial<ObserverEvalInputPayload['metadata']> = {},
): ObserverAppraisalProjectionResult {
  return projectObserverEvalToEmoSim(makeObserverInput({
    source: {
      routingSource: 'api',
      isDirectMessage: true,
      channelPrivacy: 'private',
    },
    emotion: {
      snapshot: structuredClone(snapshot),
      appraisalEntryCount: 2,
    },
    metadata: {
      trustLevel: 'primary',
      speakerRole: 'user',
      contactResolved: true,
      contentLength: 320,
      attachmentCount: 0,
      hasVisionInput: false,
      sensitivity: 'public',
      ...metadataOverrides,
    },
  }));
}

function stdev(values: readonly number[]): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
  return Math.sqrt(variance);
}

function makeObserverInput(
  overrides: Partial<ObserverEvalInputPayload> = {},
): ObserverEvalInputPayload {
  return {
    schemaVersion: 1,
    turn: {
      turnId: 'turn-projection',
      requestId: 'request-projection',
      sourceMessageId: 'source-message-projection',
      channelId: 'channel-projection',
      channelType: 'api',
      messageTimestampMs: 1_780_000_000_000,
    },
    source: {
      routingSource: 'api',
      isDirectMessage: false,
      channelPrivacy: 'public',
    },
    emotion: {
      snapshot: structuredClone(EMOTION_SNAPSHOT),
      appraisalEntryCount: 2,
    },
    metadata: {
      trustLevel: 'trusted',
      speakerRole: 'user',
      contactResolved: true,
      contentLength: 420,
      attachmentCount: 1,
      hasVisionInput: true,
      sensitivity: 'public',
    },
    provenance: {
      seam: 'substrate-agent.pre-turn.emotion-observed',
      capturedAt: 1_780_000_000_100,
      emotionSessionId: 'emotion-session-projection',
      emotionSnapshotSource: 'observeEmotionState',
      correlation: {
        callType: 'chat',
        purpose: 'agent.turn',
      },
    },
    ...overrides,
  };
}

function withRawLeakFields(input: ObserverEvalInputPayload): ObserverEvalInputPayload {
  return {
    ...input,
    turn: {
      ...input.turn,
      requestId: RAW_SECRET,
      sourceMessageId: RAW_SECRET,
      channelId: RAW_SECRET,
    },
    provenance: {
      ...input.provenance,
      emotionSessionId: RAW_SECRET,
      correlation: {
        ...input.provenance.correlation,
        purpose: RAW_SECRET,
      },
    },
    rawUserText: RAW_SECRET,
  } as ObserverEvalInputPayload;
}

function makeFixtureAppraisal(): EmoSimAppraisalVector {
  return {
    valence: 0.72,
    novelty: 0.18,
    goal_congruence: 0.64,
    certainty: 0.52,
    control: 0.28,
    agency_self: 0.1,
    agency_other: 0.88,
    fairness: 0.5,
    self_norm: 0.08,
    threat: 0.02,
    loss: 0,
    gain: 0.7,
    other_suffering: 0.03,
    attachment: 0.66,
    beauty: 0.22,
    effort: 0.31,
    safety: 0.84,
  };
}

function expectSuccess(
  result: ObserverAppraisalProjectionResult,
): asserts result is ObserverAppraisalProjectionSuccess {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
}

function expectFailure(
  result: ObserverAppraisalProjectionResult,
): asserts result is ObserverAppraisalProjectionFailure {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error('Expected projection failure');
  }
}

function expectNoRawLeak(value: unknown): void {
  expect(JSON.stringify(value)).not.toContain(RAW_SECRET);
}
