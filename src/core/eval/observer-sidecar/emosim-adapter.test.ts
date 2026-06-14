import { describe, expect, it } from 'vitest';
import {
  createPythonEmoSimRunner,
  EMOSIM_ADAPTER_INPUT_SCHEMA_VERSION,
  EMOSIM_ADAPTER_OUTPUT_SCHEMA_VERSION,
  EMOSIM_ADAPTER_VERSION,
  EMOSIM_APPRAISAL_DIMS,
  EMOSIM_EMOTION_VECTOR,
  EMOSIM_INTEGRATION_SURFACE,
  EMOSIM_SNAPSHOT_FORMAT,
  EMOSIM_TIMESTEP_POLICY,
  EMOSIM_WORLD_SNAPSHOT_FORMAT,
  parseEmoSimAdapterInput,
  parseEmoSimAdapterOutput,
  runEmoSimProjectedStimulus,
  type EmoSimAdapterInput,
  type EmoSimAdapterOutput,
  type EmoSimEmotionVector,
  type EmoSimRunner,
} from './emosim-adapter.js';

describe('EmoSim observer sidecar adapter', () => {
  it('runs a single projected stimulus through an injected deterministic runner', async () => {
    const input = makeInput();
    const runner: EmoSimRunner = {
      run: async (runnerInput) => makeOutput(runnerInput),
    };

    const first = await runEmoSimProjectedStimulus(input, { runner });
    const second = await runEmoSimProjectedStimulus(input, { runner });

    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.output.schemaVersion).toBe(EMOSIM_ADAPTER_OUTPUT_SCHEMA_VERSION);
    expect(first.output.adapterVersion).toBe(EMOSIM_ADAPTER_VERSION);
    expect(first.output.runtime.appraisalDimensions).toEqual([...EMOSIM_APPRAISAL_DIMS]);
    expect(first.output.runtime.emotionVector).toEqual([...EMOSIM_EMOTION_VECTOR]);
    expect(Object.keys(first.output.snapshots.afterTick.emotions)).toEqual([...EMOSIM_EMOTION_VECTOR]);
    expect(first.output.snapshots.afterTick.emotions.Joy).toBe(0.42);
    expect(first.output.kicks.Joy).toBe(0.12);
    expect(first.output.world?.fullEmotionVector).toBe(true);
  });

  it('schema-validates versioned inputs and rejects unknown appraisal dimensions', () => {
    const input = makeInput();
    expect(parseEmoSimAdapterInput(input)).toEqual(input);

    const malformed = {
      ...input,
      stimulus: {
        ...input.stimulus,
        appraisal: {
          ...input.stimulus.appraisal,
          unsupported: 0.4,
        },
      },
    };

    expect(() => parseEmoSimAdapterInput(malformed)).toThrow(
      'input.stimulus.appraisal.unsupported is not part of the EmoSim adapter schema',
    );
  });

  it('schema-validates outputs and requires the full emotion vector', () => {
    const output = makeOutput(makeInput());
    expect(parseEmoSimAdapterOutput(output)).toEqual(output);

    const incompleteVector = { ...output.snapshots.afterTick.emotions };
    delete incompleteVector.Joy;
    const malformed = {
      ...output,
      snapshots: {
        ...output.snapshots,
        afterTick: {
          ...output.snapshots.afterTick,
          emotions: incompleteVector,
        },
      },
    };

    expect(() => parseEmoSimAdapterOutput(malformed)).toThrow(
      'output.snapshots.afterTick.emotions.Joy is required',
    );
  });

  it('returns invalid-input instead of throwing for malformed adapter input', async () => {
    const result = await runEmoSimProjectedStimulus({
      ...makeInput(),
      schemaVersion: 2,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'invalid-input',
        reason: 'schema-validation',
        recoverable: true,
      },
    });
  });

  it('reports missing EmoSim runtime as sidecar-unavailable', async () => {
    const missingRunner = createPythonEmoSimRunner({
      emoSimRoot: '/tmp/psfn-framework-missing-emosim-runtime',
    });

    const result = await runEmoSimProjectedStimulus(makeInput(), { runner: missingRunner });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'sidecar-unavailable',
        reason: 'missing-runtime',
        recoverable: true,
      },
    });
  });
});

function makeInput(): EmoSimAdapterInput {
  return {
    schemaVersion: EMOSIM_ADAPTER_INPUT_SCHEMA_VERSION,
    runId: 'emosim-adapter-test-run',
    subject: {
      name: 'observer',
      uid: 'observer-fixture-uid',
      personality: {
        O: 0.72,
        C: 0.61,
        E: 0.58,
        A: 0.8,
        N: 0.35,
      },
    },
    stimulus: {
      label: 'warm recognition',
      intensity: 0.7,
      importance: 0.5,
      projection: {
        schemaVersion: EMOSIM_ADAPTER_INPUT_SCHEMA_VERSION,
        source: 'fixture.projected-turn.v1',
        traceId: 'turn-fixture-1',
      },
      appraisal: {
        valence: 0.7,
        novelty: 0.2,
        goal_congruence: 0.5,
        certainty: 0.4,
        control: 0.3,
        agency_self: 0,
        agency_other: 0.8,
        fairness: 0.6,
        self_norm: 0.1,
        threat: 0,
        loss: 0,
        gain: 0.55,
        other_suffering: 0,
        attachment: 0.7,
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
      seed: 'emosim-adapter-seed',
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

function makeOutput(input: EmoSimAdapterInput): EmoSimAdapterOutput {
  const before = makeEmotionVector(0);
  const afterStimulus = makeEmotionVector(0);
  const afterTick = makeEmotionVector(0);
  const kicks = makeEmotionVector(0);
  afterStimulus.Joy = 0.28;
  afterTick.Joy = 0.42;
  kicks.Joy = 0.12;

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
    kicks,
    snapshots: {
      before: makeSnapshot(0, 'Calmness', before),
      afterStimulus: makeSnapshot(0, 'Joy', afterStimulus),
      afterTick: makeSnapshot(1, 'Joy', afterTick),
    },
    world: {
      format: EMOSIM_WORLD_SNAPSHOT_FORMAT,
      fullEmotionVector: true,
      state: {
        time: input.deterministic.observedAt,
        t: 1,
        agents: {
          observer: {
            intensities: afterTick,
          },
        },
      },
    },
  };
}

function makeEmotionVector(value: number): EmoSimEmotionVector {
  return Object.fromEntries(EMOSIM_EMOTION_VECTOR.map((emotion) => [emotion, value])) as EmoSimEmotionVector;
}

function makeSnapshot(t: number, dominant: 'Calmness' | 'Joy', emotions: EmoSimEmotionVector) {
  return {
    format: EMOSIM_SNAPSHOT_FORMAT,
    t,
    dominant,
    mood: {
      valence: dominant === 'Joy' ? 0.3 : 0,
      arousal: dominant === 'Joy' ? 0.2 : 0,
    },
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

function makeEmotionSpecs() {
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
