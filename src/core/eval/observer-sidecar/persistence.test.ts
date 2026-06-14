import { describe, expect, it } from 'vitest';
import type { Pool, QueryResult } from 'pg';
import type { EmotionStateSnapshot } from '../../emotion/state.js';
import { POSTGRES_OBSERVER_EVAL_SIDECAR_MIGRATIONS } from '../../../persistence/postgres/migrations.js';
import { createObserverEmotionCrosswalk } from './crosswalk.js';
import {
  EMOSIM_APPRAISAL_DIMS,
  EMOSIM_ADAPTER_OUTPUT_SCHEMA_VERSION,
  EMOSIM_ADAPTER_VERSION,
  EMOSIM_EMOTION_VECTOR,
  EMOSIM_INTEGRATION_SURFACE,
  EMOSIM_SNAPSHOT_FORMAT,
  EMOSIM_TIMESTEP_POLICY,
  EMOSIM_WORLD_SNAPSHOT_FORMAT,
  type EmoSimAdapterInput,
  type EmoSimAdapterRunResult,
  type EmoSimEmotionName,
  type EmoSimEmotionSpecMetadata,
  type EmoSimEmotionVector,
  type EmoSimEngineSnapshot,
} from './emosim-adapter.js';
import {
  createObserverEvalComparisonMetrics,
  OBSERVER_EVAL_SIDECAR_EVAL_OWNER,
  OBSERVER_EVAL_SIDECAR_NON_AUTHORITATIVE_NOTICE,
  PostgresObserverEvalSidecarStore,
  type ObserverEvalSidecarObservationInput,
  type ObserverEvalSidecarRetentionMetadata,
  type ObserverEvalSidecarRunInput,
} from './persistence.js';
import { projectObserverEvalToEmoSim } from './projection.js';
import { sanitizeObserverEvalInput } from './privacy.js';
import type { ObserverEvalInputPayload } from './types.js';

const NOW_MS = 1_780_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

interface StoredRunRow {
  run_id: string;
  schema_version: number;
  eval_owner: string;
  authoritative: boolean;
  sidecar_id: string;
  deployment: 'live' | 'eval' | 'test';
  eval_session_id: string | null;
  scenario_id: string | null;
  test_run_id: string | null;
  status: string;
  started_at_ms: number;
  completed_at_ms: number | null;
  metadata_json: unknown;
  retention_json: unknown;
  retain_until_ms: number;
  created_at_ms: number;
  updated_at_ms: number;
}

interface StoredObservationRow {
  observation_id: string;
  run_id: string;
  schema_version: number;
  eval_owner: string;
  authoritative: boolean;
  turn_id: string;
  captured_at_ms: number;
  observed_at_ms: number;
  status: string;
  privacy_class: string;
  sensitivity: string | null;
  channel_visibility: string | null;
  redaction_reason: string;
  raw_content_redacted: boolean;
  sensitive_identifiers_redacted: boolean;
  derived_telemetry_permitted: boolean;
  psfn_emotion_snapshot_ref: string | null;
  psfn_emotion_snapshot_json: unknown;
  observer_input_json: unknown;
  projected_appraisal_json: unknown;
  emosim_output_json: unknown;
  crosswalk_json: unknown;
  comparison_metrics_json: unknown;
  divergence_score: number | null;
  error_json: unknown;
  degraded_state_json: unknown;
  metadata_json: unknown;
  retention_json: unknown;
  retain_until_ms: number;
  created_at_ms: number;
}

interface ObserverInputOverrides
  extends Omit<Partial<ObserverEvalInputPayload>, 'turn' | 'source' | 'emotion' | 'metadata' | 'provenance'> {
  turn?: Partial<ObserverEvalInputPayload['turn']>;
  source?: Partial<ObserverEvalInputPayload['source']>;
  emotion?: Partial<ObserverEvalInputPayload['emotion']>;
  metadata?: Partial<ObserverEvalInputPayload['metadata']>;
  provenance?: Partial<ObserverEvalInputPayload['provenance']>;
}

function queryResult(rows: unknown[] = [], command = 'SELECT'): QueryResult {
  return {
    rows,
    command,
    rowCount: rows.length,
    oid: 0,
    fields: [],
  } as QueryResult;
}

function normalizeSql(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function parseLimit(normalized: string): number {
  const match = / limit (\d+)\b/.exec(normalized);
  return match ? Number(match[1]) : 100;
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return JSON.parse(value) as unknown;
}

class FakeObserverEvalPool {
  readonly runs = new Map<string, StoredRunRow>();
  readonly observations = new Map<string, StoredObservationRow>();
  readonly queries: Array<{ text: string; values: readonly unknown[] }> = [];

  async connect(): Promise<{ query: (text: string, values?: readonly unknown[]) => Promise<QueryResult>; release: () => void }> {
    return {
      query: (text: string, values: readonly unknown[] = []) => this.query(text, values),
      release: () => undefined,
    };
  }

  async query(text: string, values: readonly unknown[] = []): Promise<QueryResult> {
    this.queries.push({ text, values });
    const normalized = normalizeSql(text);

    if (normalized === 'begin' || normalized === 'commit' || normalized === 'rollback') {
      return queryResult([], normalized.toUpperCase());
    }
    if (normalized.startsWith('create table') || normalized.startsWith('create index')) {
      return queryResult([], 'DDL');
    }
    if (normalized.startsWith('insert into observer_eval_sidecar_runs')) {
      const row: StoredRunRow = {
        run_id: String(values[0]),
        schema_version: Number(values[1]),
        eval_owner: String(values[2]),
        authoritative: Boolean(values[3]),
        sidecar_id: String(values[4]),
        deployment: values[5] as StoredRunRow['deployment'],
        eval_session_id: values[6] === null ? null : String(values[6]),
        scenario_id: values[7] === null ? null : String(values[7]),
        test_run_id: values[8] === null ? null : String(values[8]),
        status: String(values[9]),
        started_at_ms: Number(values[10]),
        completed_at_ms: values[11] === null ? null : Number(values[11]),
        metadata_json: jsonValue(values[12]),
        retention_json: jsonValue(values[13]),
        retain_until_ms: Number(values[14]),
        created_at_ms: Number(values[15]),
        updated_at_ms: Number(values[16]),
      };
      this.runs.set(row.run_id, row);
      return queryResult([], 'INSERT');
    }
    if (normalized.startsWith('insert into observer_eval_sidecar_observations')) {
      const row: StoredObservationRow = {
        observation_id: String(values[0]),
        run_id: String(values[1]),
        schema_version: Number(values[2]),
        eval_owner: String(values[3]),
        authoritative: Boolean(values[4]),
        turn_id: String(values[5]),
        captured_at_ms: Number(values[6]),
        observed_at_ms: Number(values[7]),
        status: String(values[8]),
        privacy_class: String(values[9]),
        sensitivity: values[10] === null ? null : String(values[10]),
        channel_visibility: values[11] === null ? null : String(values[11]),
        redaction_reason: String(values[12]),
        raw_content_redacted: Boolean(values[13]),
        sensitive_identifiers_redacted: Boolean(values[14]),
        derived_telemetry_permitted: Boolean(values[15]),
        psfn_emotion_snapshot_ref: values[16] === null ? null : String(values[16]),
        psfn_emotion_snapshot_json: jsonValue(values[17]),
        observer_input_json: jsonValue(values[18]),
        projected_appraisal_json: jsonValue(values[19]),
        emosim_output_json: jsonValue(values[20]),
        crosswalk_json: jsonValue(values[21]),
        comparison_metrics_json: jsonValue(values[22]),
        divergence_score: values[23] === null ? null : Number(values[23]),
        error_json: jsonValue(values[24]),
        degraded_state_json: jsonValue(values[25]),
        metadata_json: jsonValue(values[26]),
        retention_json: jsonValue(values[27]),
        retain_until_ms: Number(values[28]),
        created_at_ms: Number(values[29]),
      };
      this.observations.set(row.observation_id, row);
      return queryResult([], 'INSERT');
    }
    if (normalized.startsWith('select * from observer_eval_sidecar_runs where run_id =')) {
      return queryResult(rowOrEmpty(this.runs.get(String(values[0]))));
    }
    if (normalized.startsWith('select * from observer_eval_sidecar_runs')) {
      return queryResult(this.filterRuns(normalized, values));
    }
    if (normalized.startsWith('select * from observer_eval_sidecar_observations where observation_id =')) {
      return queryResult(rowOrEmpty(this.observations.get(String(values[0]))));
    }
    if (normalized.startsWith('select o.* from observer_eval_sidecar_observations')) {
      return queryResult(this.filterObservations(normalized, values));
    }
    if (normalized.startsWith('delete from observer_eval_sidecar_observations')) {
      const cutoff = Number(values[0]);
      const deleted: Array<{ observation_id: string }> = [];
      for (const row of this.observations.values()) {
        if (row.retain_until_ms <= cutoff) {
          deleted.push({ observation_id: row.observation_id });
        }
      }
      for (const row of deleted) {
        this.observations.delete(row.observation_id);
      }
      return queryResult(deleted, 'DELETE');
    }
    if (normalized.startsWith('delete from observer_eval_sidecar_runs')) {
      const cutoff = Number(values[0]);
      const deleted: Array<{ run_id: string }> = [];
      for (const row of this.runs.values()) {
        const hasObservations = [...this.observations.values()].some(observation => observation.run_id === row.run_id);
        if (row.retain_until_ms <= cutoff && !hasObservations) {
          deleted.push({ run_id: row.run_id });
        }
      }
      for (const row of deleted) {
        this.runs.delete(row.run_id);
      }
      return queryResult(deleted, 'DELETE');
    }

    throw new Error(`Unhandled fake SQL: ${text}`);
  }

  private filterRuns(normalized: string, values: readonly unknown[]): StoredRunRow[] {
    let cursor = 0;
    let rows = [...this.runs.values()];
    if (normalized.includes('eval_session_id =')) {
      const value = String(values[cursor++]);
      rows = rows.filter(row => row.eval_session_id === value);
    }
    if (normalized.includes('scenario_id =')) {
      const value = String(values[cursor++]);
      rows = rows.filter(row => row.scenario_id === value);
    }
    if (normalized.includes('test_run_id =')) {
      const value = String(values[cursor++]);
      rows = rows.filter(row => row.test_run_id === value);
    }
    if (normalized.includes('status =')) {
      const value = String(values[cursor++]);
      rows = rows.filter(row => row.status === value);
    }
    if (normalized.includes('started_at_ms >=')) {
      const value = Number(values[cursor++]);
      rows = rows.filter(row => row.started_at_ms >= value);
    }
    if (normalized.includes('started_at_ms <=')) {
      const value = Number(values[cursor++]);
      rows = rows.filter(row => row.started_at_ms <= value);
    }
    return rows
      .sort((left, right) => right.started_at_ms - left.started_at_ms || right.run_id.localeCompare(left.run_id))
      .slice(0, parseLimit(normalized));
  }

  private filterObservations(normalized: string, values: readonly unknown[]): StoredObservationRow[] {
    let cursor = 0;
    let rows = [...this.observations.values()];
    if (normalized.includes('o.run_id =')) {
      const value = String(values[cursor++]);
      rows = rows.filter(row => row.run_id === value);
    }
    if (normalized.includes('r.eval_session_id =')) {
      const value = String(values[cursor++]);
      rows = rows.filter(row => this.runs.get(row.run_id)?.eval_session_id === value);
    }
    if (normalized.includes('r.scenario_id =')) {
      const value = String(values[cursor++]);
      rows = rows.filter(row => this.runs.get(row.run_id)?.scenario_id === value);
    }
    if (normalized.includes('r.test_run_id =')) {
      const value = String(values[cursor++]);
      rows = rows.filter(row => this.runs.get(row.run_id)?.test_run_id === value);
    }
    if (normalized.includes('o.turn_id =')) {
      const value = String(values[cursor++]);
      rows = rows.filter(row => row.turn_id === value);
    }
    if (normalized.includes('o.privacy_class =')) {
      const value = String(values[cursor++]);
      rows = rows.filter(row => row.privacy_class === value);
    }
    if (normalized.includes('o.status =')) {
      const value = String(values[cursor++]);
      rows = rows.filter(row => row.status === value);
    }
    if (normalized.includes('o.observed_at_ms >=')) {
      const value = Number(values[cursor++]);
      rows = rows.filter(row => row.observed_at_ms >= value);
    }
    if (normalized.includes('o.observed_at_ms <=')) {
      const value = Number(values[cursor++]);
      rows = rows.filter(row => row.observed_at_ms <= value);
    }
    if (normalized.includes('o.divergence_score is not null and o.divergence_score >=')) {
      const value = Number(values[cursor++]);
      rows = rows.filter(row => row.divergence_score !== null && row.divergence_score >= value);
    }
    return rows
      .sort((left, right) => right.observed_at_ms - left.observed_at_ms || right.observation_id.localeCompare(left.observation_id))
      .slice(0, parseLimit(normalized));
  }
}

function rowOrEmpty<T>(row: T | undefined): T[] {
  return row ? [row] : [];
}

function makeStore(pool: FakeObserverEvalPool): PostgresObserverEvalSidecarStore {
  return new PostgresObserverEvalSidecarStore(pool as unknown as Pool, {
    nowMs: () => NOW_MS,
  });
}

function makeRetention(capturedAtMs: number, ttlMs = DAY_MS): ObserverEvalSidecarRetentionMetadata {
  return {
    retentionClass: 'short',
    policyId: 'observer-sidecar-short-retention',
    capturedAtMs,
    retainUntilMs: capturedAtMs + ttlMs,
    reason: 'eval-sidecar-observation-retention',
    tags: ['observer-sidecar', 'non-authoritative'],
  };
}

function makeRun(overrides: Partial<ObserverEvalSidecarRunInput> = {}): ObserverEvalSidecarRunInput {
  return {
    runId: 'run-1',
    sidecarId: 'observer-sidecar-test',
    deployment: 'test',
    evalSessionId: 'eval-session-1',
    scenarioId: 'scenario-joy',
    testRunId: 'test-run-1',
    status: 'running',
    startedAtMs: NOW_MS,
    metadata: { fixture: true },
    retention: makeRetention(NOW_MS, 3 * DAY_MS),
    ...overrides,
  };
}

function makeObserverInput(overrides: ObserverInputOverrides = {}): ObserverEvalInputPayload {
  const base: ObserverEvalInputPayload = {
    schemaVersion: 1,
    turn: {
      turnId: 'turn-1',
      requestId: 'request-redacted',
      sourceMessageId: 'message-redacted',
      channelId: 'channel-redacted',
      channelType: 'api',
      messageTimestampMs: NOW_MS + 20,
    },
    source: {
      routingSource: 'api',
      isDirectMessage: true,
      channelPrivacy: 'private',
    },
    emotion: {
      snapshot: makeEmotionSnapshot(),
      appraisalEntryCount: 2,
    },
    metadata: {
      trustLevel: 'regular',
      speakerRole: 'user',
      contactResolved: true,
      contentLength: 140,
      attachmentCount: 0,
      hasVisionInput: false,
      sensitivity: 'personal',
    },
    provenance: {
      seam: 'substrate-agent.pre-turn.emotion-observed',
      capturedAt: NOW_MS + 25,
      emotionSessionId: 'emotion-session-redacted',
      emotionSnapshotSource: 'observeEmotionState',
      correlation: {
        callType: 'chat',
        purpose: 'agent.turn',
      },
    },
  };
  return {
    ...base,
    ...overrides,
    turn: { ...base.turn, ...overrides.turn },
    source: { ...base.source, ...overrides.source },
    emotion: { ...base.emotion, ...overrides.emotion },
    metadata: { ...base.metadata, ...overrides.metadata },
    provenance: { ...base.provenance, ...overrides.provenance },
  };
}

function makeEmotionSnapshot(): EmotionStateSnapshot {
  return {
    vad: { valence: 0.45, arousal: 0.32, dominance: 0.2 },
    mood: { valence: 0.22, arousal: 0.16, dominance: 0.1 },
    discrete: { joy: 0.72, trust: 0.31 },
    confidence: 0.84,
  };
}

function makeObservation(
  overrides: Partial<ObserverEvalSidecarObservationInput> = {},
): ObserverEvalSidecarObservationInput {
  const rawInput = makeObserverInput();
  const sanitizedInput = sanitizeObserverEvalInput(rawInput);
  const projection = projectObserverEvalToEmoSim(rawInput, { runId: 'run-1' });
  if (!projection.ok) {
    throw new Error('expected projection fixture to succeed');
  }
  const emosim = makeEmoSimResult(projection.adapterInput);
  if (!emosim.ok) {
    throw new Error('expected emosim fixture to succeed');
  }
  const crosswalk = createObserverEmotionCrosswalk({
    psfn: rawInput.emotion.snapshot,
    emosim: emosim.output,
  });
  return {
    observationId: 'observation-1',
    runId: 'run-1',
    sanitizedInput,
    observedAtMs: NOW_MS + 50,
    projection,
    emosim,
    crosswalk,
    comparisonMetrics: createObserverEvalComparisonMetrics(crosswalk, { fixture: 'joy' }),
    retention: makeRetention(NOW_MS + 50, DAY_MS),
    ...overrides,
  };
}

function makeEmoSimResult(input: EmoSimAdapterInput): EmoSimAdapterRunResult {
  const before = makeEngineSnapshot('Calmness', 0.1, 0.1, makeEmotionVector({ Calmness: 0.35 }));
  const afterStimulus = makeEngineSnapshot('Joy', 0.52, 0.34, makeEmotionVector({ Joy: 0.82, Interest: 0.28 }));
  const afterTick = makeEngineSnapshot('Joy', 0.48, 0.3, makeEmotionVector({ Joy: 0.74, Interest: 0.22 }));
  return {
    ok: true,
    schemaVersion: EMOSIM_ADAPTER_OUTPUT_SCHEMA_VERSION,
    adapterVersion: EMOSIM_ADAPTER_VERSION,
    output: {
      schemaVersion: EMOSIM_ADAPTER_OUTPUT_SCHEMA_VERSION,
      adapterVersion: EMOSIM_ADAPTER_VERSION,
      runtime: {
        integrationSurface: EMOSIM_INTEGRATION_SURFACE,
        appraisalDimensions: EMOSIM_APPRAISAL_DIMS,
        emotionVector: EMOSIM_EMOTION_VECTOR,
        timestepPolicy: EMOSIM_TIMESTEP_POLICY,
        snapshotFormat: EMOSIM_SNAPSHOT_FORMAT,
        worldSnapshotFormat: EMOSIM_WORLD_SNAPSHOT_FORMAT,
        timeScale: 1,
        decay: {
          moodHalfLifeSeconds: 120,
          maxStepDtSeconds: 0.5,
          residueMultiplier: 0.8,
          emotionHalfLivesSeconds: makeEmotionVector(30),
        },
        emotionSpecs: makeEmotionSpecs(),
      },
      input,
      stimulus: input.stimulus,
      kicks: makeEmotionVector({ Joy: 0.6 }),
      snapshots: {
        before,
        afterStimulus,
        afterTick,
      },
    },
  };
}

function makeEmotionVector(
  defaultOrOverrides: number | Partial<Record<EmoSimEmotionName, number>> = 0,
): EmoSimEmotionVector {
  const defaultValue = typeof defaultOrOverrides === 'number' ? defaultOrOverrides : 0;
  const overrides = typeof defaultOrOverrides === 'number' ? {} : defaultOrOverrides;
  return Object.fromEntries(
    EMOSIM_EMOTION_VECTOR.map(emotion => [emotion, overrides[emotion] ?? defaultValue]),
  ) as EmoSimEmotionVector;
}

function makeEngineSnapshot(
  dominant: EmoSimEmotionName,
  valence: number,
  arousal: number,
  emotions: EmoSimEmotionVector,
): EmoSimEngineSnapshot {
  return {
    format: EMOSIM_SNAPSHOT_FORMAT,
    t: 0.25,
    dominant,
    mood: { valence, arousal },
    emotions,
    drives: {
      hunger: 0,
      thirst: 0,
      sleepPressure: 0,
      socialNeed: 0,
      stimulationNeed: 0,
      esteemNeed: 0,
      insecurity: 0,
      health: 1,
      asleep: 0,
    },
  };
}

function makeEmotionSpecs(): Record<EmoSimEmotionName, EmoSimEmotionSpecMetadata> {
  return Object.fromEntries(
    EMOSIM_EMOTION_VECTOR.map(emotion => [emotion, {
      valence: 0,
      arousal: 0.2,
      halfLifeSeconds: 30,
    }]),
  ) as Record<EmoSimEmotionName, EmoSimEmotionSpecMetadata>;
}

describe('observer sidecar eval persistence', () => {
  it('writes, reads, and queries non-authoritative run and observation records', async () => {
    const pool = new FakeObserverEvalPool();
    const store = makeStore(pool);

    const run = await store.upsertRun(makeRun());
    const observation = await store.recordObservation(makeObservation({
      comparisonMetrics: {
        schemaVersion: 1,
        metricsVersion: 'psfn.observer-sidecar.comparison-metrics.v1',
        divergenceScore: 0.88,
        vadDistance: 0.88,
        familyMismatch: true,
        directionMismatch: false,
        unmappedSignal: 0,
      },
    }));

    await expect(store.getRun('run-1')).resolves.toEqual(run);
    await expect(store.getObservation('observation-1')).resolves.toEqual(observation);
    await expect(store.queryRuns({ evalSessionId: 'eval-session-1' })).resolves.toEqual([run]);
    await expect(store.queryObservations({
      scenarioId: 'scenario-joy',
      testRunId: 'test-run-1',
      minDivergenceScore: 0.5,
    })).resolves.toEqual([observation]);
    await expect(store.getLatestObservation({ runId: 'run-1' })).resolves.toEqual(observation);

    expect(observation.evalOwner).toBe(OBSERVER_EVAL_SIDECAR_EVAL_OWNER);
    expect(observation.authoritative).toBe(false);
    expect(observation.nonAuthoritativeNotice).toBe(OBSERVER_EVAL_SIDECAR_NON_AUTHORITATIVE_NOTICE);
    expect(pool.observations.get('observation-1')).toMatchObject({
      eval_owner: OBSERVER_EVAL_SIDECAR_EVAL_OWNER,
      authoritative: false,
      privacy_class: 'private',
      divergence_score: 0.88,
    });
  });

  it('persists privacy and redaction metadata without sensitive identifiers as query columns', async () => {
    const pool = new FakeObserverEvalPool();
    const store = makeStore(pool);
    await store.upsertRun(makeRun());

    const closedInput = makeObserverInput({
      metadata: { sensitivity: 'confidential' },
      source: { isDirectMessage: true, channelPrivacy: 'private' },
    });
    const sanitizedInput = sanitizeObserverEvalInput(closedInput);
    const observation = await store.recordObservation(makeObservation({
      observationId: 'observation-confidential',
      sanitizedInput,
      projection: undefined,
      emosim: undefined,
      crosswalk: undefined,
      comparisonMetrics: createObserverEvalComparisonMetrics(undefined),
      psfnEmotion: {
        snapshot: sanitizedInput.emotion.snapshot,
        appraisalEntryCount: sanitizedInput.emotion.appraisalEntryCount,
        snapshotSource: sanitizedInput.provenance.emotionSnapshotSource,
      },
    }));

    expect(observation.privacy).toMatchObject({
      privacyClass: 'closed',
      sensitivity: 'confidential',
      channelVisibility: 'private',
      rawContentRedacted: true,
      sensitiveIdentifiersRedacted: true,
      derivedTelemetryPermitted: true,
      redactionReason: 'closed_sensitivity_metadata_only',
    });
    expect(pool.observations.get('observation-confidential')).toMatchObject({
      privacy_class: 'closed',
      sensitivity: 'confidential',
      channel_visibility: 'private',
      redaction_reason: 'closed_sensitivity_metadata_only',
      raw_content_redacted: true,
      sensitive_identifiers_redacted: true,
    });
    expect(pool.observations.get('observation-confidential')).not.toHaveProperty('request_id');
    expect(pool.observations.get('observation-confidential')).not.toHaveProperty('source_message_id');
    await expect(store.queryObservations({ privacyClass: 'closed' })).resolves.toEqual([observation]);
  });

  it('prunes expired observation and run retention without touching active rows', async () => {
    const pool = new FakeObserverEvalPool();
    const store = makeStore(pool);
    await store.upsertRun(makeRun({
      runId: 'old-run',
      startedAtMs: NOW_MS - (4 * DAY_MS),
      retention: makeRetention(NOW_MS - (4 * DAY_MS), DAY_MS),
    }));
    await store.recordObservation(makeObservation({
      observationId: 'old-observation',
      runId: 'old-run',
      observedAtMs: NOW_MS - (3 * DAY_MS),
      retention: makeRetention(NOW_MS - (3 * DAY_MS), DAY_MS),
    }));
    await store.upsertRun(makeRun({ runId: 'active-run' }));
    await store.recordObservation(makeObservation({
      observationId: 'active-observation',
      runId: 'active-run',
      observedAtMs: NOW_MS + 100,
      retention: makeRetention(NOW_MS + 100, DAY_MS),
    }));

    const result = await store.pruneExpiredRetention(NOW_MS);

    expect(result).toEqual({
      prunedAtMs: NOW_MS,
      prunedObservationIds: ['old-observation'],
      prunedRunIds: ['old-run'],
    });
    expect(await store.getObservation('old-observation')).toBeNull();
    expect(await store.getRun('old-run')).toBeNull();
    expect(await store.getObservation('active-observation')).not.toBeNull();
    expect(await store.getRun('active-run')).not.toBeNull();
  });

  it('keeps the migration schema eval-owned, indexed, and separate from companion truth stores', () => {
    const sql = POSTGRES_OBSERVER_EVAL_SIDECAR_MIGRATIONS.join('\n').toLowerCase();

    expect(sql).toContain('create table if not exists observer_eval_sidecar_runs');
    expect(sql).toContain('create table if not exists observer_eval_sidecar_observations');
    expect(sql).toContain("check (eval_owner = 'observer_sidecar_eval')");
    expect(sql).toContain('check (authoritative = false)');
    expect(sql).toContain('idx_observer_eval_sidecar_observations_run_latest');
    expect(sql).toContain('idx_observer_eval_sidecar_observations_divergence');
    expect(sql).toContain('idx_observer_eval_sidecar_observations_privacy');
    expect(sql).toContain('idx_observer_eval_sidecar_observations_retention');
    expect(sql).toContain('retention_json jsonb not null');
    expect(sql).not.toMatch(/\bl2_memories\b/);
    expect(sql).not.toMatch(/\bcontacts\b/);
    expect(sql).not.toMatch(/\bactive_concerns\b/);
    expect(sql).not.toMatch(/\binternal_state_snapshots\b/);
    expect(sql).not.toMatch(/\bprompt_layers\b/);
  });
});
