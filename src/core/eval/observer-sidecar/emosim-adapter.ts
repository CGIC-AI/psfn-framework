import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import { isRecord } from '../../../shared/utils/types.js';

export const EMOSIM_ADAPTER_INPUT_SCHEMA_VERSION = 1 as const;
export const EMOSIM_ADAPTER_OUTPUT_SCHEMA_VERSION = 1 as const;
export const EMOSIM_ADAPTER_VERSION = 'psfn.observer-sidecar.emosim-adapter.v1' as const;
export const EMOSIM_INTEGRATION_SURFACE = 'emo_sim/statemashine.py' as const;
export const EMOSIM_SNAPSHOT_FORMAT = 'emosim.engine-snapshot.full-vector.v1' as const;
export const EMOSIM_WORLD_SNAPSHOT_FORMAT = 'emosim.world-state-dict.full-vector.v1' as const;
export const EMOSIM_TIMESTEP_POLICY = 'fixed-step-seconds.apply-before-tick.v1' as const;
export const DEFAULT_EMOSIM_ROOT = '/home/ada/emo_sim' as const;
export const DEFAULT_EMOSIM_PYTHON_EXECUTABLE = 'python3' as const;
export const DEFAULT_EMOSIM_TIMEOUT_MS = 5_000;

export const EMOSIM_APPRAISAL_DIMS = Object.freeze([
  'valence',
  'novelty',
  'goal_congruence',
  'certainty',
  'control',
  'agency_self',
  'agency_other',
  'fairness',
  'self_norm',
  'threat',
  'loss',
  'gain',
  'other_suffering',
  'attachment',
  'beauty',
  'effort',
  'safety',
] as const);

export const EMOSIM_EMOTION_VECTOR = Object.freeze([
  'Joy',
  'Ecstasy',
  'Excitement',
  'Amusement',
  'Triumph',
  'Pride',
  'Satisfaction',
  'Contentment',
  'Calmness',
  'Relief',
  'Desire',
  'Craving',
  'Interest',
  'Awe',
  'Aesthetic Appreciation',
  'Entrancement',
  'Contemplation',
  'Realization',
  'Nostalgia',
  'Determination',
  'Concentration',
  'Love',
  'Romance',
  'Adoration',
  'Admiration',
  'Sympathy',
  'Empathic Pain',
  'Fear',
  'Anxiety',
  'Horror',
  'Distress',
  'Pain',
  'Sadness',
  'Disappointment',
  'Tiredness',
  'Boredom',
  'Anger',
  'Contempt',
  'Disgust',
  'Envy',
  'Guilt',
  'Shame',
  'Embarrassment',
  'Awkwardness',
  'Doubt',
  'Confusion',
  'Surprise (positive)',
  'Surprise (negative)',
] as const);

export type EmoSimAppraisalDimension = typeof EMOSIM_APPRAISAL_DIMS[number];
export type EmoSimEmotionName = typeof EMOSIM_EMOTION_VECTOR[number];
export type EmoSimAppraisalVector = Record<EmoSimAppraisalDimension, number>;
export type EmoSimEmotionVector = Record<EmoSimEmotionName, number>;

export interface EmoSimPersonality {
  O: number;
  C: number;
  E: number;
  A: number;
  N: number;
}

export interface EmoSimSubject {
  name: string;
  uid: string;
  personality: EmoSimPersonality;
}

export interface EmoSimProjectionMetadata {
  schemaVersion: typeof EMOSIM_ADAPTER_INPUT_SCHEMA_VERSION;
  source: string;
  traceId?: string;
}

export interface EmoSimProjectedStimulus {
  label: string;
  intensity: number;
  importance: number;
  projection: EmoSimProjectionMetadata;
  appraisal: EmoSimAppraisalVector;
}

export interface EmoSimTimestepPolicy {
  policy: typeof EMOSIM_TIMESTEP_POLICY;
  tickSeconds: number;
  steps: number;
}

export interface EmoSimDeterminismPolicy {
  seed: string;
  clock0Seconds: number;
  observedAt: string;
  disableDrives: boolean;
}

export interface EmoSimSnapshotPolicy {
  format: typeof EMOSIM_SNAPSHOT_FORMAT;
  fullEmotionVector: true;
  includeWorldState: boolean;
  precision: number;
}

export interface EmoSimAdapterInput {
  schemaVersion: typeof EMOSIM_ADAPTER_INPUT_SCHEMA_VERSION;
  runId: string;
  subject: EmoSimSubject;
  stimulus: EmoSimProjectedStimulus;
  timestep: EmoSimTimestepPolicy;
  deterministic: EmoSimDeterminismPolicy;
  snapshot: EmoSimSnapshotPolicy;
}

export interface EmoSimDrivesSnapshot {
  hunger: number;
  thirst: number;
  sleepPressure: number;
  socialNeed: number;
  stimulationNeed: number;
  esteemNeed: number;
  insecurity: number;
  health: number;
  asleep: number;
}

export interface EmoSimEngineSnapshot {
  format: typeof EMOSIM_SNAPSHOT_FORMAT;
  t: number;
  dominant: EmoSimEmotionName;
  mood: {
    valence: number;
    arousal: number;
  };
  emotions: EmoSimEmotionVector;
  drives: EmoSimDrivesSnapshot;
}

export interface EmoSimEmotionSpecMetadata {
  valence: number;
  arousal: number;
  halfLifeSeconds: number;
}

export interface EmoSimRuntimeMetadata {
  integrationSurface: typeof EMOSIM_INTEGRATION_SURFACE;
  appraisalDimensions: readonly EmoSimAppraisalDimension[];
  emotionVector: readonly EmoSimEmotionName[];
  timestepPolicy: typeof EMOSIM_TIMESTEP_POLICY;
  snapshotFormat: typeof EMOSIM_SNAPSHOT_FORMAT;
  worldSnapshotFormat: typeof EMOSIM_WORLD_SNAPSHOT_FORMAT;
  timeScale: number;
  decay: {
    moodHalfLifeSeconds: number;
    maxStepDtSeconds: number;
    residueMultiplier: number;
    emotionHalfLivesSeconds: EmoSimEmotionVector;
  };
  emotionSpecs: Record<EmoSimEmotionName, EmoSimEmotionSpecMetadata>;
}

export interface EmoSimWorldSnapshot {
  format: typeof EMOSIM_WORLD_SNAPSHOT_FORMAT;
  fullEmotionVector: true;
  state: Record<string, unknown>;
}

export interface EmoSimAdapterOutput {
  schemaVersion: typeof EMOSIM_ADAPTER_OUTPUT_SCHEMA_VERSION;
  adapterVersion: typeof EMOSIM_ADAPTER_VERSION;
  runtime: EmoSimRuntimeMetadata;
  input: EmoSimAdapterInput;
  stimulus: EmoSimProjectedStimulus;
  kicks: EmoSimEmotionVector;
  snapshots: {
    before: EmoSimEngineSnapshot;
    afterStimulus: EmoSimEngineSnapshot;
    afterTick: EmoSimEngineSnapshot;
  };
  world?: EmoSimWorldSnapshot;
}

export type EmoSimSidecarUnavailableReason =
  | 'missing-runtime'
  | 'incompatible-runtime'
  | 'runtime-error'
  | 'timeout';

export type EmoSimAdapterErrorCode = 'invalid-input' | 'sidecar-unavailable';
export type EmoSimAdapterErrorReason = 'schema-validation' | EmoSimSidecarUnavailableReason;

export interface EmoSimAdapterError {
  code: EmoSimAdapterErrorCode;
  reason: EmoSimAdapterErrorReason;
  message: string;
  recoverable: true;
  details?: Record<string, boolean | number | string | null>;
}

export type EmoSimAdapterRunResult =
  | {
      ok: true;
      schemaVersion: typeof EMOSIM_ADAPTER_OUTPUT_SCHEMA_VERSION;
      adapterVersion: typeof EMOSIM_ADAPTER_VERSION;
      output: EmoSimAdapterOutput;
    }
  | {
      ok: false;
      schemaVersion: typeof EMOSIM_ADAPTER_OUTPUT_SCHEMA_VERSION;
      adapterVersion: typeof EMOSIM_ADAPTER_VERSION;
      error: EmoSimAdapterError;
      input?: EmoSimAdapterInput;
    };

export interface EmoSimRunner {
  run(input: EmoSimAdapterInput): Promise<unknown>;
}

export interface PythonEmoSimRunnerOptions {
  emoSimRoot?: string;
  pythonExecutable?: string;
  timeoutMs?: number;
}

export interface RunEmoSimAdapterOptions extends PythonEmoSimRunnerOptions {
  runner?: EmoSimRunner;
}

export class EmoSimSidecarUnavailableError extends Error {
  readonly reason: EmoSimSidecarUnavailableReason;
  readonly details?: Record<string, boolean | number | string | null>;

  constructor(
    reason: EmoSimSidecarUnavailableReason,
    message: string,
    details?: Record<string, boolean | number | string | null>,
  ) {
    super(message);
    this.name = 'EmoSimSidecarUnavailableError';
    this.reason = reason;
    this.details = details;
  }
}

const SIGNED_APPRAISAL_DIMS = new Set<EmoSimAppraisalDimension>([
  'valence',
  'goal_congruence',
  'certainty',
  'control',
  'fairness',
  'self_norm',
]);

const PERSONALITY_KEYS = Object.freeze(['O', 'C', 'E', 'A', 'N'] as const);
const DRIVES_KEYS = Object.freeze([
  'hunger',
  'thirst',
  'sleepPressure',
  'socialNeed',
  'stimulationNeed',
  'esteemNeed',
  'insecurity',
  'health',
  'asleep',
] as const);

const PYTHON_BRIDGE_SCRIPT = String.raw`
import json
import os
import random
import sys
import traceback

def emit_sidecar_error(reason, message):
    print(json.dumps({"sidecarError": {"reason": reason, "message": message}}))

try:
    request = json.load(sys.stdin)
    sys.path.insert(0, os.getcwd())
    import statemashine as emosim

    expected = request["expected"]
    input_payload = request["input"]
    expected_dims = expected["appraisalDimensions"]
    expected_emotions = expected["emotionVector"]

    if list(emosim.APPRAISAL_DIMS) != expected_dims:
        emit_sidecar_error(
            "incompatible-runtime",
            "statemashine.py APPRAISAL_DIMS does not match the adapter contract",
        )
        sys.exit(0)

    if list(emosim.EMOTIONS.keys()) != expected_emotions:
        emit_sidecar_error(
            "incompatible-runtime",
            "statemashine.py EMOTIONS order does not match the adapter contract",
        )
        sys.exit(0)

    subject = input_payload["subject"]
    personality = subject["personality"]
    engine = emosim.EmotionEngine(
        emosim.Personality(
            O=float(personality["O"]),
            C=float(personality["C"]),
            E=float(personality["E"]),
            A=float(personality["A"]),
            N=float(personality["N"]),
        ),
        name=subject["name"],
        uid=subject["uid"],
    )
    deterministic = input_payload["deterministic"]
    engine.clock0 = float(deterministic["clock0Seconds"])
    engine.drives_enabled = not bool(deterministic["disableDrives"])

    world = emosim.SocialWorld({subject["name"]: engine}, label="observer-sidecar:" + input_payload["runId"])
    world.wid = deterministic["seed"]
    world._rng = random.Random(deterministic["seed"])
    world.clock0 = float(deterministic["clock0Seconds"])
    world.autonomy = False

    stimulus_payload = input_payload["stimulus"]
    stimulus = emosim.Stimulus(
        label=stimulus_payload["label"],
        intensity=float(stimulus_payload["intensity"]),
        importance=float(stimulus_payload["importance"]),
    )
    for dim in expected_dims:
        setattr(stimulus, dim, float(stimulus_payload["appraisal"][dim]))

    def full_emotion_vector(values):
        return {emotion: float(values.get(emotion, 0.0)) for emotion in expected_emotions}

    def snapshot(engine):
        snap = engine.snapshot()
        return {
            "format": expected["snapshotFormat"],
            "t": float(snap.t),
            "dominant": snap.dominant,
            "mood": {
                "valence": float(snap.mood_valence),
                "arousal": float(snap.mood_arousal),
            },
            "emotions": full_emotion_vector(snap.intensities),
            "drives": {
                "hunger": float(engine.hunger),
                "thirst": float(engine.thirst),
                "sleepPressure": float(engine.sleep_pressure),
                "socialNeed": float(engine.social_need),
                "stimulationNeed": float(engine.stimulation_need),
                "esteemNeed": float(engine.esteem_need),
                "insecurity": float(engine.insecurity),
                "health": float(engine.health),
                "asleep": float(engine.asleep),
            },
        }

    before = snapshot(engine)
    kicks = full_emotion_vector(engine.apply_stimulus(stimulus))
    after_stimulus = snapshot(engine)

    timestep = input_payload["timestep"]
    for _ in range(int(timestep["steps"])):
        world.tick(float(timestep["tickSeconds"]))

    after_tick = snapshot(engine)
    world_state = emosim.world_state_dict(world, full=True)
    world_state["time"] = deterministic["observedAt"]

    emotion_specs = {
        emotion: {
            "valence": float(emosim.EMOTIONS[emotion].valence),
            "arousal": float(emosim.EMOTIONS[emotion].arousal),
            "halfLifeSeconds": float(emosim.EMOTIONS[emotion].half_life),
        }
        for emotion in expected_emotions
    }

    output = {
        "schemaVersion": expected["outputSchemaVersion"],
        "adapterVersion": expected["adapterVersion"],
        "runtime": {
            "integrationSurface": expected["integrationSurface"],
            "appraisalDimensions": expected_dims,
            "emotionVector": expected_emotions,
            "timestepPolicy": expected["timestepPolicy"],
            "snapshotFormat": expected["snapshotFormat"],
            "worldSnapshotFormat": expected["worldSnapshotFormat"],
            "timeScale": float(emosim.TIME_SCALE),
            "decay": {
                "moodHalfLifeSeconds": float(emosim.MOOD_HALFLIFE),
                "maxStepDtSeconds": float(emosim.MAX_STEP_DT),
                "residueMultiplier": float(emosim.RESIDUE_MULT),
                "emotionHalfLivesSeconds": {
                    emotion: float(emosim.EMOTIONS[emotion].half_life)
                    for emotion in expected_emotions
                },
            },
            "emotionSpecs": emotion_specs,
        },
        "input": input_payload,
        "stimulus": stimulus_payload,
        "kicks": kicks,
        "snapshots": {
            "before": before,
            "afterStimulus": after_stimulus,
            "afterTick": after_tick,
        },
    }
    if input_payload["snapshot"]["includeWorldState"]:
        output["world"] = {
            "format": expected["worldSnapshotFormat"],
            "fullEmotionVector": True,
            "state": world_state,
        }
    print(json.dumps(output, sort_keys=True, separators=(",", ":")))
except Exception:
    emit_sidecar_error("runtime-error", traceback.format_exc(limit=6))
`;

export async function runEmoSimProjectedStimulus(
  rawInput: unknown,
  options: RunEmoSimAdapterOptions = {},
): Promise<EmoSimAdapterRunResult> {
  let input: EmoSimAdapterInput;
  try {
    input = parseEmoSimAdapterInput(rawInput);
  } catch (error) {
    return buildFailure(
      undefined,
      'invalid-input',
      'schema-validation',
      toErrorMessage(error),
    );
  }

  const runner = options.runner ?? createPythonEmoSimRunner(options);
  let rawOutput: unknown;
  try {
    rawOutput = await runner.run(input);
  } catch (error) {
    if (error instanceof EmoSimSidecarUnavailableError) {
      return buildFailure(input, 'sidecar-unavailable', error.reason, error.message, error.details);
    }
    return buildFailure(input, 'sidecar-unavailable', 'runtime-error', toErrorMessage(error));
  }

  try {
    return {
      ok: true,
      schemaVersion: EMOSIM_ADAPTER_OUTPUT_SCHEMA_VERSION,
      adapterVersion: EMOSIM_ADAPTER_VERSION,
      output: parseEmoSimAdapterOutput(rawOutput),
    };
  } catch (error) {
    return buildFailure(input, 'sidecar-unavailable', 'incompatible-runtime', toErrorMessage(error));
  }
}

export function createPythonEmoSimRunner(options: PythonEmoSimRunnerOptions = {}): EmoSimRunner {
  const emoSimRoot = options.emoSimRoot ?? DEFAULT_EMOSIM_ROOT;
  const pythonExecutable = options.pythonExecutable ?? DEFAULT_EMOSIM_PYTHON_EXECUTABLE;
  const timeoutMs = normalizeRunnerTimeout(options.timeoutMs);

  return {
    run: async (input: EmoSimAdapterInput): Promise<unknown> => runPythonBridge(
      input,
      emoSimRoot,
      pythonExecutable,
      timeoutMs,
    ),
  };
}

export function parseEmoSimAdapterInput(value: unknown): EmoSimAdapterInput {
  const record = expectRecord(value, 'input');
  assertKnownKeys(record, 'input', [
    'schemaVersion',
    'runId',
    'subject',
    'stimulus',
    'timestep',
    'deterministic',
    'snapshot',
  ]);

  return {
    schemaVersion: expectConst(
      record.schemaVersion,
      'input.schemaVersion',
      EMOSIM_ADAPTER_INPUT_SCHEMA_VERSION,
    ),
    runId: normalizeNonEmptyString(record.runId, 'input.runId'),
    subject: normalizeSubject(record.subject, 'input.subject'),
    stimulus: normalizeStimulus(record.stimulus, 'input.stimulus'),
    timestep: normalizeTimestep(record.timestep, 'input.timestep'),
    deterministic: normalizeDeterminism(record.deterministic, 'input.deterministic'),
    snapshot: normalizeSnapshotPolicy(record.snapshot, 'input.snapshot'),
  };
}

export function parseEmoSimAdapterOutput(value: unknown): EmoSimAdapterOutput {
  const record = expectRecord(value, 'output');
  assertKnownKeys(record, 'output', [
    'schemaVersion',
    'adapterVersion',
    'runtime',
    'input',
    'stimulus',
    'kicks',
    'snapshots',
    'world',
  ]);

  const output: EmoSimAdapterOutput = {
    schemaVersion: expectConst(
      record.schemaVersion,
      'output.schemaVersion',
      EMOSIM_ADAPTER_OUTPUT_SCHEMA_VERSION,
    ),
    adapterVersion: expectConst(record.adapterVersion, 'output.adapterVersion', EMOSIM_ADAPTER_VERSION),
    runtime: normalizeRuntimeMetadata(record.runtime, 'output.runtime'),
    input: parseEmoSimAdapterInput(record.input),
    stimulus: normalizeStimulus(record.stimulus, 'output.stimulus'),
    kicks: normalizeEmotionFiniteVector(record.kicks, 'output.kicks', { min: 0 }),
    snapshots: normalizeSnapshots(record.snapshots, 'output.snapshots'),
  };

  if (record.world !== undefined) {
    output.world = normalizeWorldSnapshot(record.world, 'output.world');
  }
  return output;
}

function runPythonBridge(
  input: EmoSimAdapterInput,
  emoSimRoot: string,
  pythonExecutable: string,
  timeoutMs: number,
): Promise<unknown> {
  const statemashinePath = path.join(emoSimRoot, 'statemashine.py');
  if (!existsSync(statemashinePath)) {
    throw new EmoSimSidecarUnavailableError(
      'missing-runtime',
      `EmoSim statemashine.py was not found at ${statemashinePath}`,
      { statemashinePath },
    );
  }

  const request = JSON.stringify({
    input,
    expected: {
      adapterVersion: EMOSIM_ADAPTER_VERSION,
      outputSchemaVersion: EMOSIM_ADAPTER_OUTPUT_SCHEMA_VERSION,
      integrationSurface: EMOSIM_INTEGRATION_SURFACE,
      appraisalDimensions: EMOSIM_APPRAISAL_DIMS,
      emotionVector: EMOSIM_EMOTION_VECTOR,
      timestepPolicy: EMOSIM_TIMESTEP_POLICY,
      snapshotFormat: EMOSIM_SNAPSHOT_FORMAT,
      worldSnapshotFormat: EMOSIM_WORLD_SNAPSHOT_FORMAT,
    },
  });

  return new Promise<unknown>((resolve, reject) => {
    const child = spawn(pythonExecutable, ['-c', PYTHON_BRIDGE_SCRIPT], {
      cwd: emoSimRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      if (!child.killed) {
        child.kill('SIGTERM');
      }
    }, timeoutMs);

    child.on('error', (error) => {
      settle(() => {
        reject(new EmoSimSidecarUnavailableError(
          'missing-runtime',
          `Failed to start EmoSim Python runner: ${error.message}`,
          { pythonExecutable },
        ));
      });
    });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.end(request);

    child.on('close', (code, signal) => {
      settle(() => {
        if (timedOut) {
          reject(new EmoSimSidecarUnavailableError(
            'timeout',
            `EmoSim Python runner timed out after ${timeoutMs}ms`,
            { timeoutMs },
          ));
          return;
        }
        if (code !== 0) {
          reject(new EmoSimSidecarUnavailableError(
            'runtime-error',
            compactProcessError('EmoSim Python runner exited nonzero', code, signal, stderr),
            { exitCode: code, signal },
          ));
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(stdout);
        } catch (error) {
          reject(new EmoSimSidecarUnavailableError(
            'incompatible-runtime',
            `EmoSim Python runner did not emit valid JSON: ${toErrorMessage(error)}`,
          ));
          return;
        }

        if (isRecord(parsed) && isRecord(parsed.sidecarError)) {
          reject(new EmoSimSidecarUnavailableError(
            normalizeSidecarUnavailableReason(parsed.sidecarError.reason),
            normalizeOptionalErrorMessage(parsed.sidecarError.message),
          ));
          return;
        }

        resolve(parsed);
      });
    });
  });
}

function buildFailure(
  input: EmoSimAdapterInput | undefined,
  code: EmoSimAdapterErrorCode,
  reason: EmoSimAdapterErrorReason,
  message: string,
  details?: Record<string, boolean | number | string | null>,
): EmoSimAdapterRunResult {
  const result: EmoSimAdapterRunResult = {
    ok: false,
    schemaVersion: EMOSIM_ADAPTER_OUTPUT_SCHEMA_VERSION,
    adapterVersion: EMOSIM_ADAPTER_VERSION,
    error: {
      code,
      reason,
      message,
      recoverable: true,
      ...(details ? { details } : {}),
    },
  };
  if (input) {
    result.input = input;
  }
  return result;
}

function normalizeSubject(value: unknown, field: string): EmoSimSubject {
  const record = expectRecord(value, field);
  assertKnownKeys(record, field, ['name', 'uid', 'personality']);
  return {
    name: normalizeNonEmptyString(record.name, `${field}.name`),
    uid: normalizeNonEmptyString(record.uid, `${field}.uid`),
    personality: normalizePersonality(record.personality, `${field}.personality`),
  };
}

function normalizePersonality(value: unknown, field: string): EmoSimPersonality {
  const record = expectRecord(value, field);
  assertKnownKeys(record, field, PERSONALITY_KEYS);
  return {
    O: normalizeFiniteNumber(record.O, `${field}.O`, { min: 0, max: 1 }),
    C: normalizeFiniteNumber(record.C, `${field}.C`, { min: 0, max: 1 }),
    E: normalizeFiniteNumber(record.E, `${field}.E`, { min: 0, max: 1 }),
    A: normalizeFiniteNumber(record.A, `${field}.A`, { min: 0, max: 1 }),
    N: normalizeFiniteNumber(record.N, `${field}.N`, { min: 0, max: 1 }),
  };
}

function normalizeStimulus(value: unknown, field: string): EmoSimProjectedStimulus {
  const record = expectRecord(value, field);
  assertKnownKeys(record, field, [
    'label',
    'intensity',
    'importance',
    'projection',
    'appraisal',
  ]);
  return {
    label: normalizeNonEmptyString(record.label, `${field}.label`),
    intensity: normalizeFiniteNumber(record.intensity, `${field}.intensity`, { min: 0, max: 2 }),
    importance: normalizeFiniteNumber(record.importance, `${field}.importance`, { min: 0, max: 1 }),
    projection: normalizeProjection(record.projection, `${field}.projection`),
    appraisal: normalizeAppraisalVector(record.appraisal, `${field}.appraisal`),
  };
}

function normalizeProjection(value: unknown, field: string): EmoSimProjectionMetadata {
  const record = expectRecord(value, field);
  assertKnownKeys(record, field, ['schemaVersion', 'source', 'traceId']);
  const projection: EmoSimProjectionMetadata = {
    schemaVersion: expectConst(
      record.schemaVersion,
      `${field}.schemaVersion`,
      EMOSIM_ADAPTER_INPUT_SCHEMA_VERSION,
    ),
    source: normalizeNonEmptyString(record.source, `${field}.source`),
  };
  if (record.traceId !== undefined) {
    projection.traceId = normalizeNonEmptyString(record.traceId, `${field}.traceId`);
  }
  return projection;
}

function normalizeAppraisalVector(value: unknown, field: string): EmoSimAppraisalVector {
  const record = expectRecord(value, field);
  assertExactKeys(record, field, EMOSIM_APPRAISAL_DIMS);
  const appraisal = {} as Partial<EmoSimAppraisalVector>;
  for (const dimension of EMOSIM_APPRAISAL_DIMS) {
    const range = SIGNED_APPRAISAL_DIMS.has(dimension)
      ? { min: -1, max: 1 }
      : { min: 0, max: 1 };
    appraisal[dimension] = normalizeFiniteNumber(record[dimension], `${field}.${dimension}`, range);
  }
  return appraisal as EmoSimAppraisalVector;
}

function normalizeTimestep(value: unknown, field: string): EmoSimTimestepPolicy {
  const record = expectRecord(value, field);
  assertKnownKeys(record, field, ['policy', 'tickSeconds', 'steps']);
  return {
    policy: expectConst(record.policy, `${field}.policy`, EMOSIM_TIMESTEP_POLICY),
    tickSeconds: normalizeFiniteNumber(record.tickSeconds, `${field}.tickSeconds`, { minExclusive: 0, max: 3_600 }),
    steps: normalizeFiniteNumber(record.steps, `${field}.steps`, { min: 0, max: 10_000, integer: true }),
  };
}

function normalizeDeterminism(value: unknown, field: string): EmoSimDeterminismPolicy {
  const record = expectRecord(value, field);
  assertKnownKeys(record, field, ['seed', 'clock0Seconds', 'observedAt', 'disableDrives']);
  return {
    seed: normalizeNonEmptyString(record.seed, `${field}.seed`),
    clock0Seconds: normalizeFiniteNumber(record.clock0Seconds, `${field}.clock0Seconds`, {
      min: 0,
      maxExclusive: 86_400,
    }),
    observedAt: normalizeNonEmptyString(record.observedAt, `${field}.observedAt`),
    disableDrives: normalizeBoolean(record.disableDrives, `${field}.disableDrives`),
  };
}

function normalizeSnapshotPolicy(value: unknown, field: string): EmoSimSnapshotPolicy {
  const record = expectRecord(value, field);
  assertKnownKeys(record, field, ['format', 'fullEmotionVector', 'includeWorldState', 'precision']);
  return {
    format: expectConst(record.format, `${field}.format`, EMOSIM_SNAPSHOT_FORMAT),
    fullEmotionVector: expectConst(record.fullEmotionVector, `${field}.fullEmotionVector`, true),
    includeWorldState: normalizeBoolean(record.includeWorldState, `${field}.includeWorldState`),
    precision: normalizeFiniteNumber(record.precision, `${field}.precision`, {
      min: 0,
      max: 12,
      integer: true,
    }),
  };
}

function normalizeRuntimeMetadata(value: unknown, field: string): EmoSimRuntimeMetadata {
  const record = expectRecord(value, field);
  assertKnownKeys(record, field, [
    'integrationSurface',
    'appraisalDimensions',
    'emotionVector',
    'timestepPolicy',
    'snapshotFormat',
    'worldSnapshotFormat',
    'timeScale',
    'decay',
    'emotionSpecs',
  ]);
  return {
    integrationSurface: expectConst(record.integrationSurface, `${field}.integrationSurface`, EMOSIM_INTEGRATION_SURFACE),
    appraisalDimensions: normalizeLiteralArray(record.appraisalDimensions, `${field}.appraisalDimensions`, EMOSIM_APPRAISAL_DIMS),
    emotionVector: normalizeLiteralArray(record.emotionVector, `${field}.emotionVector`, EMOSIM_EMOTION_VECTOR),
    timestepPolicy: expectConst(record.timestepPolicy, `${field}.timestepPolicy`, EMOSIM_TIMESTEP_POLICY),
    snapshotFormat: expectConst(record.snapshotFormat, `${field}.snapshotFormat`, EMOSIM_SNAPSHOT_FORMAT),
    worldSnapshotFormat: expectConst(
      record.worldSnapshotFormat,
      `${field}.worldSnapshotFormat`,
      EMOSIM_WORLD_SNAPSHOT_FORMAT,
    ),
    timeScale: normalizeFiniteNumber(record.timeScale, `${field}.timeScale`, { minExclusive: 0 }),
    decay: normalizeDecayMetadata(record.decay, `${field}.decay`),
    emotionSpecs: normalizeEmotionSpecs(record.emotionSpecs, `${field}.emotionSpecs`),
  };
}

function normalizeDecayMetadata(value: unknown, field: string): EmoSimRuntimeMetadata['decay'] {
  const record = expectRecord(value, field);
  assertKnownKeys(record, field, [
    'moodHalfLifeSeconds',
    'maxStepDtSeconds',
    'residueMultiplier',
    'emotionHalfLivesSeconds',
  ]);
  return {
    moodHalfLifeSeconds: normalizeFiniteNumber(record.moodHalfLifeSeconds, `${field}.moodHalfLifeSeconds`, { minExclusive: 0 }),
    maxStepDtSeconds: normalizeFiniteNumber(record.maxStepDtSeconds, `${field}.maxStepDtSeconds`, { minExclusive: 0 }),
    residueMultiplier: normalizeFiniteNumber(record.residueMultiplier, `${field}.residueMultiplier`, { minExclusive: 0 }),
    emotionHalfLivesSeconds: normalizeEmotionFiniteVector(
      record.emotionHalfLivesSeconds,
      `${field}.emotionHalfLivesSeconds`,
      { minExclusive: 0 },
    ),
  };
}

function normalizeEmotionSpecs(value: unknown, field: string): Record<EmoSimEmotionName, EmoSimEmotionSpecMetadata> {
  const record = expectRecord(value, field);
  assertExactKeys(record, field, EMOSIM_EMOTION_VECTOR);
  const specs = {} as Partial<Record<EmoSimEmotionName, EmoSimEmotionSpecMetadata>>;
  for (const emotion of EMOSIM_EMOTION_VECTOR) {
    const spec = expectRecord(record[emotion], `${field}.${emotion}`);
    assertKnownKeys(spec, `${field}.${emotion}`, ['valence', 'arousal', 'halfLifeSeconds']);
    specs[emotion] = {
      valence: normalizeFiniteNumber(spec.valence, `${field}.${emotion}.valence`, { min: -1, max: 1 }),
      arousal: normalizeFiniteNumber(spec.arousal, `${field}.${emotion}.arousal`, { min: 0, max: 1 }),
      halfLifeSeconds: normalizeFiniteNumber(spec.halfLifeSeconds, `${field}.${emotion}.halfLifeSeconds`, {
        minExclusive: 0,
      }),
    };
  }
  return specs as Record<EmoSimEmotionName, EmoSimEmotionSpecMetadata>;
}

function normalizeSnapshots(value: unknown, field: string): EmoSimAdapterOutput['snapshots'] {
  const record = expectRecord(value, field);
  assertKnownKeys(record, field, ['before', 'afterStimulus', 'afterTick']);
  return {
    before: normalizeEngineSnapshot(record.before, `${field}.before`),
    afterStimulus: normalizeEngineSnapshot(record.afterStimulus, `${field}.afterStimulus`),
    afterTick: normalizeEngineSnapshot(record.afterTick, `${field}.afterTick`),
  };
}

function normalizeEngineSnapshot(value: unknown, field: string): EmoSimEngineSnapshot {
  const record = expectRecord(value, field);
  assertKnownKeys(record, field, ['format', 't', 'dominant', 'mood', 'emotions', 'drives']);
  return {
    format: expectConst(record.format, `${field}.format`, EMOSIM_SNAPSHOT_FORMAT),
    t: normalizeFiniteNumber(record.t, `${field}.t`, { min: 0 }),
    dominant: normalizeEmotionName(record.dominant, `${field}.dominant`),
    mood: normalizeMood(record.mood, `${field}.mood`),
    emotions: normalizeEmotionFiniteVector(record.emotions, `${field}.emotions`, { min: 0, max: 1 }),
    drives: normalizeDrives(record.drives, `${field}.drives`),
  };
}

function normalizeMood(value: unknown, field: string): EmoSimEngineSnapshot['mood'] {
  const record = expectRecord(value, field);
  assertKnownKeys(record, field, ['valence', 'arousal']);
  return {
    valence: normalizeFiniteNumber(record.valence, `${field}.valence`, { min: -1, max: 1 }),
    arousal: normalizeFiniteNumber(record.arousal, `${field}.arousal`, { min: 0, max: 1 }),
  };
}

function normalizeDrives(value: unknown, field: string): EmoSimDrivesSnapshot {
  const record = expectRecord(value, field);
  assertKnownKeys(record, field, DRIVES_KEYS);
  return {
    hunger: normalizeFiniteNumber(record.hunger, `${field}.hunger`, { min: 0, max: 1 }),
    thirst: normalizeFiniteNumber(record.thirst, `${field}.thirst`, { min: 0, max: 1 }),
    sleepPressure: normalizeFiniteNumber(record.sleepPressure, `${field}.sleepPressure`, { min: 0, max: 1 }),
    socialNeed: normalizeFiniteNumber(record.socialNeed, `${field}.socialNeed`, { min: 0, max: 1 }),
    stimulationNeed: normalizeFiniteNumber(record.stimulationNeed, `${field}.stimulationNeed`, { min: 0, max: 1 }),
    esteemNeed: normalizeFiniteNumber(record.esteemNeed, `${field}.esteemNeed`, { min: 0, max: 1 }),
    insecurity: normalizeFiniteNumber(record.insecurity, `${field}.insecurity`, { min: 0, max: 1 }),
    health: normalizeFiniteNumber(record.health, `${field}.health`, { min: 0, max: 1 }),
    asleep: normalizeFiniteNumber(record.asleep, `${field}.asleep`, { min: 0 }),
  };
}

function normalizeWorldSnapshot(value: unknown, field: string): EmoSimWorldSnapshot {
  const record = expectRecord(value, field);
  assertKnownKeys(record, field, ['format', 'fullEmotionVector', 'state']);
  const state = expectRecord(record.state, `${field}.state`);
  const agents = expectRecord(state.agents, `${field}.state.agents`);
  for (const [name, agent] of Object.entries(agents)) {
    const agentRecord = expectRecord(agent, `${field}.state.agents.${name}`);
    normalizeEmotionFiniteVector(agentRecord.intensities, `${field}.state.agents.${name}.intensities`, {
      min: 0,
      max: 1,
    });
  }

  return {
    format: expectConst(record.format, `${field}.format`, EMOSIM_WORLD_SNAPSHOT_FORMAT),
    fullEmotionVector: expectConst(record.fullEmotionVector, `${field}.fullEmotionVector`, true),
    state,
  };
}

function normalizeEmotionFiniteVector(
  value: unknown,
  field: string,
  range: NumberRange,
): EmoSimEmotionVector {
  const record = expectRecord(value, field);
  assertExactKeys(record, field, EMOSIM_EMOTION_VECTOR);
  const vector = {} as Partial<EmoSimEmotionVector>;
  for (const emotion of EMOSIM_EMOTION_VECTOR) {
    vector[emotion] = normalizeFiniteNumber(record[emotion], `${field}.${emotion}`, range);
  }
  return vector as EmoSimEmotionVector;
}

function normalizeLiteralArray<const T extends readonly string[]>(
  value: unknown,
  field: string,
  expected: T,
): readonly T[number][] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  if (value.length !== expected.length) {
    throw new Error(`${field} must contain ${expected.length} entries`);
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (value[index] !== expected[index]) {
      throw new Error(`${field}[${index}] must be ${expected[index]}`);
    }
  }
  return [...expected];
}

function normalizeEmotionName(value: unknown, field: string): EmoSimEmotionName {
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string`);
  }
  if (!EMOSIM_EMOTION_VECTOR.includes(value as EmoSimEmotionName)) {
    throw new Error(`${field} must be a known EmoSim emotion`);
  }
  return value as EmoSimEmotionName;
}

function normalizeBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${field} must be a boolean`);
  }
  return value;
}

function normalizeNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${field} must be non-empty`);
  }
  return trimmed;
}

interface NumberRange {
  min?: number;
  minExclusive?: number;
  max?: number;
  maxExclusive?: number;
  integer?: boolean;
}

function normalizeFiniteNumber(value: unknown, field: string, range: NumberRange = {}): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  if (range.integer === true && !Number.isInteger(value)) {
    throw new Error(`${field} must be an integer`);
  }
  if (range.min !== undefined && value < range.min) {
    throw new Error(`${field} must be >= ${range.min}`);
  }
  if (range.minExclusive !== undefined && value <= range.minExclusive) {
    throw new Error(`${field} must be > ${range.minExclusive}`);
  }
  if (range.max !== undefined && value > range.max) {
    throw new Error(`${field} must be <= ${range.max}`);
  }
  if (range.maxExclusive !== undefined && value >= range.maxExclusive) {
    throw new Error(`${field} must be < ${range.maxExclusive}`);
  }
  return value;
}

function normalizeRunnerTimeout(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_EMOSIM_TIMEOUT_MS;
  }
  return normalizeFiniteNumber(value, 'timeoutMs', { min: 1, max: 120_000, integer: true });
}

function normalizeOptionalErrorMessage(value: unknown): string {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : 'EmoSim sidecar unavailable';
}

function normalizeSidecarUnavailableReason(value: unknown): EmoSimSidecarUnavailableReason {
  switch (value) {
    case 'missing-runtime':
    case 'incompatible-runtime':
    case 'runtime-error':
    case 'timeout':
      return value;
    default:
      return 'runtime-error';
  }
}

function expectRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

function expectConst<const T extends boolean | number | string>(
  value: unknown,
  field: string,
  expected: T,
): T {
  if (value !== expected) {
    throw new Error(`${field} must be ${String(expected)}`);
  }
  return expected;
}

function assertKnownKeys(
  record: Record<string, unknown>,
  field: string,
  allowedKeys: readonly string[],
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new Error(`${field}.${key} is not part of the EmoSim adapter schema`);
    }
  }
}

function assertExactKeys(
  record: Record<string, unknown>,
  field: string,
  expectedKeys: readonly string[],
): void {
  assertKnownKeys(record, field, expectedKeys);
  for (const key of expectedKeys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new Error(`${field}.${key} is required`);
    }
  }
}

function compactProcessError(
  message: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): string {
  const details = [
    `code=${String(code)}`,
    `signal=${String(signal)}`,
  ];
  const stderrSummary = stderr.trim().replace(/\s+/g, ' ').slice(0, 500);
  if (stderrSummary) {
    details.push(`stderr=${stderrSummary}`);
  }
  return `${message} (${details.join(', ')})`;
}
