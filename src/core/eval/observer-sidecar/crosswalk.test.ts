import { describe, expect, it } from 'vitest';
import type { EmotionStateSnapshot } from '../../emotion/state.js';
import {
  createObserverEmotionCrosswalk,
  OBSERVER_EMOTION_CROSSWALK_VERSION,
} from './crosswalk.js';
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
  type EmoSimEmotionName,
  type EmoSimEmotionVector,
  type EmoSimEngineSnapshot,
} from './emosim-adapter.js';

describe('observer emotion crosswalk', () => {
  it('preserves raw inputs and aligns high-valence PSFN joy with EmoSim joy', () => {
    const psfn = makePsfnSnapshot({
      vad: { valence: 0.82, arousal: 0.62, dominance: 0.22 },
      mood: { valence: 0.6, arousal: 0.4, dominance: 0.1 },
      discrete: { joy: 0.9 },
      confidence: 0.86,
    });
    const emosim = makeEmoSimOutput({
      afterTick: { Joy: 0.86, Amusement: 0.2 },
      afterTickMood: { valence: 0.78, arousal: 0.58 },
      dominant: 'Joy',
    });

    const crosswalk = createObserverEmotionCrosswalk({ psfn, emosim });

    expect(crosswalk.crosswalkVersion).toBe(OBSERVER_EMOTION_CROSSWALK_VERSION);
    expect(crosswalk.raw.psfn).toBe(psfn);
    expect(crosswalk.raw.emosim).toBe(emosim);
    expect(crosswalk.derived.psfn.primaryLabel?.label).toBe('joy');
    expect(crosswalk.derived.emosim.primaryEmotion?.emotion).toBe('Joy');
    expect(crosswalk.derived.comparison.labels.familyMismatch).toBe(false);
    expect(crosswalk.derived.comparison.labels.familyOverlap).toBeGreaterThan(0.5);
    expect(crosswalk.derived.comparison.valenceArousal.delta.euclideanDistance).toBeLessThan(0.08);
    expect(crosswalk.derived.comparison.unknowns.psfnUnmappedCount).toBe(0);
  });

  it('compares low-arousal PSFN trust against EmoSim calmness with an explicit dominance caveat', () => {
    const psfn = makePsfnSnapshot({
      vad: { valence: 0.56, arousal: 0.12, dominance: 0.36 },
      mood: { valence: 0.54, arousal: 0.1, dominance: 0.34 },
      discrete: { trust: 0.72 },
      confidence: 0.8,
    });
    const emosim = makeEmoSimOutput({
      afterTick: { Calmness: 0.7, Contentment: 0.2 },
      afterTickMood: { valence: 0.5, arousal: 0.1 },
      dominant: 'Calmness',
    });

    const crosswalk = createObserverEmotionCrosswalk({ psfn, emosim });

    expect(crosswalk.derived.psfn.valenceArousalDominance?.arousal).toBeCloseTo(0.12, 6);
    expect(crosswalk.derived.emosim.valenceArousal.arousal).toBeCloseTo(0.1, 6);
    expect(crosswalk.derived.psfn.weaklyMappedLabels.map((label) => label.label)).toContain('trust');
    expect(crosswalk.derived.emosim.weaklyMappedEmotions.map((emotion) => emotion.emotion)).toContain('Calmness');
    expect(crosswalk.derived.emosim.dominanceProxy.caveat).toContain('no dominance axis');
    expect(crosswalk.derived.comparison.dominance.absoluteDelta).not.toBeNull();
  });

  it('keeps self-conscious labels visible instead of folding them into canonical PSFN labels', () => {
    const psfn = makePsfnSnapshot({
      vad: { valence: -0.62, arousal: 0.38, dominance: -0.58 },
      mood: { valence: -0.4, arousal: 0.22, dominance: -0.4 },
      discrete: { shame: 0.74 },
      confidence: 0.78,
    });
    const emosim = makeEmoSimOutput({
      afterTick: { Shame: 0.76 },
      afterTickMood: { valence: -0.64, arousal: 0.35 },
      dominant: 'Shame',
    });

    const crosswalk = createObserverEmotionCrosswalk({ psfn, emosim });

    expect(crosswalk.derived.psfn.primaryLabel).toMatchObject({
      label: 'shame',
      canonicalTextLabel: false,
      family: 'self_conscious',
    });
    expect(crosswalk.derived.psfn.primaryLabel?.caveat).toContain('not a current canonical PSFN text label');
    expect(crosswalk.derived.emosim.weaklyMappedEmotions.map((emotion) => emotion.emotion)).toContain('Shame');
    expect(crosswalk.derived.comparison.labels.familyMismatch).toBe(false);
  });

  it('retains mixed-emotion category evidence on both sides', () => {
    const psfn = makePsfnSnapshot({
      vad: { valence: 0.1, arousal: 0.46, dominance: -0.08 },
      mood: { valence: 0.04, arousal: 0.35, dominance: -0.04 },
      discrete: { joy: 0.58, sadness: 0.55 },
      confidence: 0.82,
    });
    const emosim = makeEmoSimOutput({
      afterTick: { Joy: 0.52, Sadness: 0.5, Disappointment: 0.18 },
      afterTickMood: { valence: 0.05, arousal: 0.42 },
      dominant: 'Joy',
    });

    const crosswalk = createObserverEmotionCrosswalk({ psfn, emosim });

    expect(crosswalk.derived.psfn.labels.map((label) => label.label)).toEqual(['joy', 'sadness']);
    expect(crosswalk.derived.emosim.emotions.map((emotion) => emotion.emotion)).toEqual([
      'Joy',
      'Sadness',
      'Disappointment',
    ]);
    expect(crosswalk.derived.psfn.familyScores.positive_high_activation).toBeGreaterThan(0);
    expect(crosswalk.derived.psfn.familyScores.distress_loss).toBeGreaterThan(0);
    expect(crosswalk.derived.emosim.familyScores.positive_high_activation).toBeGreaterThan(0);
    expect(crosswalk.derived.emosim.familyScores.distress_loss).toBeGreaterThan(0);
    expect(crosswalk.derived.comparison.labels.familyOverlap).toBeGreaterThan(0.45);
  });

  it('reports weak and unmapped PSFN labels explicitly', () => {
    const psfn = makePsfnSnapshot({
      vad: { valence: 0.18, arousal: 0.5, dominance: -0.1 },
      mood: { valence: 0.05, arousal: 0.3, dominance: -0.05 },
      discrete: { anticipation: 0.66, alienation: 0.6 },
      confidence: 0.7,
    });
    const emosim = makeEmoSimOutput({
      afterTick: { Interest: 0.5, Doubt: 0.28 },
      afterTickMood: { valence: 0.12, arousal: 0.46 },
      dominant: 'Interest',
    });

    const crosswalk = createObserverEmotionCrosswalk({ psfn, emosim });

    expect(crosswalk.derived.psfn.weaklyMappedLabels.map((label) => label.label)).toContain('anticipation');
    expect(crosswalk.derived.psfn.unmappedLabels).toEqual([{ label: 'alienation', score: 0.6 }]);
    expect(crosswalk.derived.psfn.labels.find((label) => label.label === 'alienation')).toMatchObject({
      mappingKind: 'unmapped',
      family: null,
      mappingConfidence: 0,
    });
    expect(crosswalk.derived.comparison.unknowns).toMatchObject({
      psfnUnmappedCount: 1,
      psfnWeakMappingCount: 1,
    });
    expect(crosswalk.derived.comparison.unknowns.unmappedIntensity).toBeCloseTo(0.6, 6);
  });
});

function makePsfnSnapshot(overrides: EmotionStateSnapshot): EmotionStateSnapshot {
  return {
    vad: { ...overrides.vad },
    mood: { ...overrides.mood },
    discrete: { ...overrides.discrete },
    confidence: overrides.confidence,
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
    runId: 'crosswalk-test-run',
    subject: {
      name: 'observer',
      uid: 'observer-crosswalk-fixture',
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
        traceId: 'turn-crosswalk-fixture',
      },
      appraisal: {
        valence: 0.2,
        novelty: 0.2,
        goal_congruence: 0.2,
        certainty: 0.4,
        control: 0.3,
        agency_self: 0,
        agency_other: 0.8,
        fairness: 0.6,
        self_norm: 0.1,
        threat: 0,
        loss: 0,
        gain: 0.25,
        other_suffering: 0,
        attachment: 0.4,
        beauty: 0.1,
        effort: 0.2,
        safety: 0.8,
      },
    },
    timestep: {
      policy: EMOSIM_TIMESTEP_POLICY,
      tickSeconds: 0.25,
      steps: 4,
    },
    deterministic: {
      seed: 'crosswalk-test-seed',
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

function makeEmotionSpecs(): EmoSimAdapterOutput['runtime']['emotionSpecs'] {
  return Object.fromEntries(
    EMOSIM_EMOTION_VECTOR.map((emotion) => [
      emotion,
      {
        valence: emotion === 'Joy' ? 0.9 : 0,
        arousal: emotion === 'Joy' ? 0.6 : 0.2,
        halfLifeSeconds: 30,
      },
    ]),
  ) as EmoSimAdapterOutput['runtime']['emotionSpecs'];
}
