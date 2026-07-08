import { describe, expect, it } from 'vitest';
import type { EmotionStateSnapshot } from '../../emotion/state.js';
import { createObserverEmotionCrosswalk } from './crosswalk.js';
import {
  EMOSIM_ADAPTER_INPUT_SCHEMA_VERSION,
  EMOSIM_ADAPTER_OUTPUT_SCHEMA_VERSION,
  EMOSIM_ADAPTER_VERSION,
  EMOSIM_APPRAISAL_DIMS,
  EMOSIM_EMOTION_VECTOR,
  EMOSIM_INTEGRATION_SURFACE,
  EMOSIM_SNAPSHOT_FORMAT,
  EMOSIM_TIMESTEP_POLICY,
  EMOSIM_WORLD_SNAPSHOT_FORMAT,
  type EmoSimAdapterInput,
  type EmoSimAdapterOutput,
  type EmoSimAppraisalVector,
  type EmoSimEmotionName,
  type EmoSimEmotionVector,
  type EmoSimEngineSnapshot,
} from './emosim-adapter.js';
import {
  createObserverEvalComparisonSummary,
  type ObserverEvalMetricReasonCode,
} from './metrics.js';
import { projectObserverEvalToEmoSim, type ObserverAppraisalProjectionResult } from './projection.js';
import type { ObserverEvalPrivacyDecision } from './privacy.js';
import type { ObserverEvalInputPayload } from './types.js';

describe('observer sidecar comparison metrics', () => {
  it('marks matching PSFN and EmoSim emotion evidence as aligned', () => {
    const crosswalk = createObserverEmotionCrosswalk({
      psfn: makePsfnSnapshot({
        vad: { valence: 0.82, arousal: 0.62, dominance: 0.22 },
        mood: { valence: 0.7, arousal: 0.5, dominance: 0.18 },
        discrete: { joy: 0.9 },
        confidence: 0.9,
      }),
      emosim: makeEmoSimOutput({
        afterStimulus: { Joy: 0.5, Amusement: 0.05 },
        afterTick: { Joy: 0.88, Amusement: 0.1 },
        afterTickMood: { valence: 0.8, arousal: 0.6 },
        dominant: 'Joy',
      }),
    });

    const summary = createObserverEvalComparisonSummary({
      crosswalk,
      projection: makeProjection(0.92),
      privacy: publicPrivacy(),
    });

    expect(summary.status).toBe('available');
    expect(summary.agreementBand).toBe('aligned');
    expect(summary.familyConfusion).toMatchObject({
      psfnPrimaryFamily: 'positive_high_activation',
      emosimPrimaryFamily: 'positive_high_activation',
      familyMismatch: false,
    });
    expect(summary.persistence.divergenceScore).toBe(summary.score.confidenceWeightedDivergenceScore);
    expect(summary.persistence.details?.agreementBand).toBe('aligned');
    expect(reasonCodes(summary)).toEqual([]);
  });

  it('summarizes strong family and VAD mismatch as divergent triage data', () => {
    const crosswalk = createObserverEmotionCrosswalk({
      psfn: makePsfnSnapshot({
        vad: { valence: -0.76, arousal: 0.68, dominance: -0.1 },
        mood: { valence: -0.5, arousal: 0.45, dominance: -0.08 },
        discrete: { anger: 0.84 },
        confidence: 0.82,
      }),
      emosim: makeEmoSimOutput({
        afterTick: { Joy: 0.82, Amusement: 0.22 },
        afterTickMood: { valence: 0.78, arousal: 0.62 },
        dominant: 'Joy',
      }),
    });

    const summary = createObserverEvalComparisonSummary({
      crosswalk,
      projection: makeProjection(0.86),
      privacy: publicPrivacy(),
    });

    expect(summary.agreementBand).toBe('divergent');
    expect(summary.score.rawDivergenceScore).toBeGreaterThan(0.42);
    expect(summary.persistence.familyMismatch).toBe(true);
    expect(summary.deltas.vadDistance).toBeGreaterThan(1);
    expect(reasonCodes(summary)).toContain('family_mismatch');
  });

  it('keeps missing projection provenance separate from model disagreement', () => {
    const crosswalk = createObserverEmotionCrosswalk({
      psfn: makePsfnSnapshot({
        vad: { valence: 0.48, arousal: 0.2, dominance: 0.12 },
        mood: { valence: 0.4, arousal: 0.18, dominance: 0.1 },
        discrete: { contentment: 0.7 },
        confidence: 0.76,
      }),
      emosim: makeEmoSimOutput({
        afterTick: { Contentment: 0.66, Calmness: 0.24 },
        afterTickMood: { valence: 0.46, arousal: 0.18 },
        dominant: 'Contentment',
      }),
    });

    const summary = createObserverEvalComparisonSummary({
      crosswalk,
      privacy: publicPrivacy(),
    });

    expect(summary.status).toBe('partial');
    expect(summary.score.rawDivergenceScore).not.toBeNull();
    expect(summary.projection).toMatchObject({
      projectionAvailable: false,
      projectionFailed: false,
      projectionConfidence: null,
    });
    expect(reasonCodes(summary)).toContain('projection_missing');
    expect(summary.persistence.details?.projection).toMatchObject({
      projectionAvailable: false,
    });
  });

  it('confidence-weights low-confidence projection divergence without hiding raw mismatch', () => {
    const crosswalk = createObserverEmotionCrosswalk({
      psfn: makePsfnSnapshot({
        vad: { valence: -0.7, arousal: 0.6, dominance: -0.4 },
        mood: { valence: -0.42, arousal: 0.35, dominance: -0.25 },
        discrete: { sadness: 0.78 },
        confidence: 0.72,
      }),
      emosim: makeEmoSimOutput({
        afterTick: { Interest: 0.78, Determination: 0.2 },
        afterTickMood: { valence: 0.42, arousal: 0.58 },
        dominant: 'Interest',
      }),
    });

    const summary = createObserverEvalComparisonSummary({
      crosswalk,
      projection: makeProjection(0.16),
      privacy: publicPrivacy(),
    });

    expect(summary.status).toBe('partial');
    expect(summary.projection.lowConfidence).toBe(true);
    expect(summary.score.rawDivergenceScore).toBeGreaterThan(summary.score.confidenceWeightedDivergenceScore ?? 0);
    expect(summary.persistence.divergenceScore).toBe(summary.score.confidenceWeightedDivergenceScore);
    expect(reasonCodes(summary)).toContain('projection_low_confidence');
  });

  it('records redacted observations as partial while preserving derived comparison telemetry', () => {
    const crosswalk = createObserverEmotionCrosswalk({
      psfn: makePsfnSnapshot({
        vad: { valence: -0.62, arousal: 0.38, dominance: -0.58 },
        mood: { valence: -0.4, arousal: 0.22, dominance: -0.4 },
        discrete: { shame: 0.74 },
        confidence: 0.78,
      }),
      emosim: makeEmoSimOutput({
        afterTick: { Shame: 0.76 },
        afterTickMood: { valence: -0.64, arousal: 0.35 },
        dominant: 'Shame',
      }),
    });

    const summary = createObserverEvalComparisonSummary({
      crosswalk,
      projection: makeProjection(0.82),
      privacy: privatePrivacy(),
    });

    expect(summary.status).toBe('partial');
    expect(summary.agreementBand).toBe('aligned');
    expect(summary.privacy).toMatchObject({
      privacyClass: 'private',
      redactedObservation: true,
      derivedTelemetryPermitted: true,
    });
    expect(reasonCodes(summary)).toContain('redacted_observation');
  });

  it('fails closed when privacy blocks derived telemetry and no crosswalk exists', () => {
    const summary = createObserverEvalComparisonSummary({
      privacy: failClosedPrivacy(),
    });

    expect(summary.status).toBe('unavailable');
    expect(summary.agreementBand).toBe('unavailable');
    expect(summary.persistence).toMatchObject({
      divergenceScore: null,
      vadDistance: null,
      familyMismatch: null,
      directionMismatch: null,
    });
    expect(reasonCodes(summary)).toEqual(expect.arrayContaining([
      'crosswalk_missing',
      'derived_telemetry_not_permitted',
    ]));
  });
});

function reasonCodes(summary: ReturnType<typeof createObserverEvalComparisonSummary>): ObserverEvalMetricReasonCode[] {
  return summary.reasons.map(reason => reason.code);
}

function makePsfnSnapshot(overrides: EmotionStateSnapshot): EmotionStateSnapshot {
  return {
    vad: { ...overrides.vad },
    mood: { ...overrides.mood },
    discrete: { ...overrides.discrete },
    confidence: overrides.confidence,
  };
}

function publicPrivacy(): ObserverEvalPrivacyDecision {
  return {
    privacyClass: 'public',
    sensitivity: 'public',
    channelVisibility: 'public',
    rawContentRedacted: true,
    sensitiveIdentifiersRedacted: true,
    derivedTelemetryPermitted: true,
    redactionReason: 'public_metadata_only',
  };
}

function privatePrivacy(): ObserverEvalPrivacyDecision {
  return {
    privacyClass: 'private',
    sensitivity: 'personal',
    channelVisibility: 'private',
    rawContentRedacted: true,
    sensitiveIdentifiersRedacted: true,
    derivedTelemetryPermitted: true,
    redactionReason: 'private_channel_metadata_only',
  };
}

function failClosedPrivacy(): ObserverEvalPrivacyDecision {
  return {
    privacyClass: 'fail_closed',
    sensitivity: null,
    channelVisibility: null,
    rawContentRedacted: true,
    sensitiveIdentifiersRedacted: true,
    derivedTelemetryPermitted: false,
    redactionReason: 'missing_sensitivity_metadata',
  };
}

function makeProjection(confidence: number): ObserverAppraisalProjectionResult {
  return projectObserverEvalToEmoSim(makeObserverInput(), {
    directFixtureAppraisal: {
      appraisal: makeAppraisalVector(0.2),
      confidence,
      label: 'metrics fixture appraisal',
    },
  });
}

function makeObserverInput(): ObserverEvalInputPayload {
  return {
    schemaVersion: 1,
    turn: {
      turnId: 'turn-metrics',
      requestId: 'request-metrics',
      sourceMessageId: 'source-message-metrics',
      channelId: 'channel-metrics',
      channelType: 'api',
      messageTimestampMs: 1_780_000_000_000,
    },
    source: {
      routingSource: 'api',
      isDirectMessage: false,
      channelPrivacy: 'public',
    },
    emotion: {
      snapshot: makePsfnSnapshot({
        vad: { valence: 0.2, arousal: 0.3, dominance: 0.1 },
        mood: { valence: 0.1, arousal: 0.2, dominance: 0.05 },
        discrete: { joy: 0.3 },
        confidence: 0.8,
      }),
      appraisalEntryCount: 1,
    },
    metadata: {
      trustLevel: 'regular',
      speakerRole: 'user',
      contactResolved: true,
      contentLength: 18,
      attachmentCount: 0,
      hasVisionInput: false,
      sensitivity: 'public',
    },
    provenance: {
      seam: 'substrate-agent.pre-turn.emotion-observed',
      capturedAt: 1_780_000_000_100,
      emotionSessionId: 'emotion-session-metrics',
      emotionSnapshotSource: 'observeEmotionState',
      correlation: {
        callType: 'chat',
        purpose: 'agent.turn',
      },
    },
  };
}

interface MakeEmoSimOutputOptions {
  before?: Partial<Record<EmoSimEmotionName, number>>;
  afterStimulus?: Partial<Record<EmoSimEmotionName, number>>;
  afterTick: Partial<Record<EmoSimEmotionName, number>>;
  afterTickMood: {
    valence: number;
    arousal: number;
  };
  dominant: EmoSimEmotionName;
}

function makeEmoSimOutput(options: MakeEmoSimOutputOptions): EmoSimAdapterOutput {
  const input = makeInput();
  const before = makeEmotionVector(options.before);
  const afterStimulus = makeEmotionVector(options.afterStimulus ?? options.afterTick);
  const afterTick = makeEmotionVector(options.afterTick);

  return {
    schemaVersion: EMOSIM_ADAPTER_OUTPUT_SCHEMA_VERSION,
    adapterVersion: EMOSIM_ADAPTER_VERSION,
    runtime: {
      integrationSurface: EMOSIM_INTEGRATION_SURFACE,
      appraisalDimensions: [...EMOSIM_APPRAISAL_DIMS],
      emotionVector: [...EMOSIM_EMOTION_VECTOR],
      timestepPolicy: EMOSIM_TIMESTEP_POLICY,
      snapshotFormat: EMOSIM_SNAPSHOT_FORMAT,
      worldSnapshotFormat: EMOSIM_WORLD_SNAPSHOT_FORMAT,
      timeScale: 1,
      decay: {
        moodHalfLifeSeconds: 25,
        maxStepDtSeconds: 0.25,
        residueMultiplier: 6,
        emotionHalfLivesSeconds: makeEmotionVector(30),
      },
      emotionSpecs: makeEmotionSpecs(),
    },
    input,
    stimulus: input.stimulus,
    kicks: makeEmotionVector(0),
    snapshots: {
      before: makeSnapshot(0, 'Calmness', before, { valence: 0, arousal: 0 }),
      afterStimulus: makeSnapshot(0, options.dominant, afterStimulus, options.afterTickMood),
      afterTick: makeSnapshot(1, options.dominant, afterTick, options.afterTickMood),
    },
    world: {
      format: EMOSIM_WORLD_SNAPSHOT_FORMAT,
      fullEmotionVector: true,
      state: {
        agents: {
          observer: {
            intensities: afterTick,
          },
        },
      },
    },
  };
}

function makeInput(): EmoSimAdapterInput {
  return {
    schemaVersion: EMOSIM_ADAPTER_INPUT_SCHEMA_VERSION,
    runId: 'metrics-test-run',
    subject: {
      name: 'observer',
      uid: 'observer-metrics-fixture',
      personality: {
        O: 0.72,
        C: 0.61,
        E: 0.58,
        A: 0.8,
        N: 0.35,
      },
    },
    stimulus: {
      label: 'fixture stimulus',
      intensity: 0.7,
      importance: 0.5,
      projection: {
        schemaVersion: EMOSIM_ADAPTER_INPUT_SCHEMA_VERSION,
        source: 'fixture.projected-turn.v1',
        traceId: 'turn-metrics-fixture',
      },
      appraisal: makeAppraisalVector(0.2),
    },
    timestep: {
      policy: EMOSIM_TIMESTEP_POLICY,
      tickSeconds: 0.25,
      steps: 4,
    },
    deterministic: {
      seed: 'metrics-test-seed',
      clock0Seconds: 36_000,
      observedAt: '2026-01-01T00:00:00.000Z',
      disableDrives: true,
    },
    snapshot: {
      format: EMOSIM_SNAPSHOT_FORMAT,
      fullEmotionVector: true,
      includeWorldState: true,
      precision: 6,
    },
  };
}

function makeSnapshot(
  t: number,
  dominant: EmoSimEmotionName,
  emotions: EmoSimEmotionVector,
  mood: { valence: number; arousal: number },
): EmoSimEngineSnapshot {
  return {
    format: EMOSIM_SNAPSHOT_FORMAT,
    t,
    dominant,
    mood,
    emotions,
    drives: {
      hunger: 0.25,
      thirst: 0.25,
      sleepPressure: 0.25,
      socialNeed: 0.25,
      stimulationNeed: 0.25,
      esteemNeed: 0.25,
      insecurity: 0.2,
      health: 1,
      asleep: 0,
    },
  };
}

function makeEmotionVector(value: number): EmoSimEmotionVector;
function makeEmotionVector(overrides?: Partial<Record<EmoSimEmotionName, number>>): EmoSimEmotionVector;
function makeEmotionVector(
  valueOrOverrides: number | Partial<Record<EmoSimEmotionName, number>> = 0,
): EmoSimEmotionVector {
  const value = typeof valueOrOverrides === 'number' ? valueOrOverrides : 0;
  const overrides = typeof valueOrOverrides === 'number' ? {} : valueOrOverrides;
  return Object.fromEntries(
    EMOSIM_EMOTION_VECTOR.map((emotion) => [emotion, overrides[emotion] ?? value]),
  ) as EmoSimEmotionVector;
}

function makeAppraisalVector(value: number): EmoSimAppraisalVector {
  return Object.fromEntries(
    EMOSIM_APPRAISAL_DIMS.map((dimension) => [dimension, value]),
  ) as EmoSimAppraisalVector;
}

function makeEmotionSpecs(): EmoSimAdapterOutput['runtime']['emotionSpecs'] {
  return Object.fromEntries(
    EMOSIM_EMOTION_VECTOR.map((emotion) => [
      emotion,
      {
        valence: emotion === 'Joy' || emotion === 'Contentment' ? 0.8 : 0,
        arousal: emotion === 'Joy' || emotion === 'Interest' ? 0.6 : 0.2,
        halfLifeSeconds: 30,
      },
    ]),
  ) as EmoSimAdapterOutput['runtime']['emotionSpecs'];
}
