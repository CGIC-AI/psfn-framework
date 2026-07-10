import { createComponentLogger } from '../../../shared/logger.js';
import type { ObserverEvalSidecarLeverSettings } from '../../../shared/contracts/runtime.js';
import { createDefaultObserverEvalSidecarSettings } from '../../../system/config/runtime-config-contracts.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import { createObserverEmotionCrosswalk } from './crosswalk.js';
import {
  runEmoSimProjectedStimulus,
  type EmoSimAdapterOutput,
  type EmoSimRunner,
} from './emosim-adapter.js';
import { createEmoSimServerRunner } from './emosim-server-adapter.js';
import {
  createEmptyObserverLeverTrackerState,
  normalizeObserverLeverTrackerState,
  OBSERVER_EVAL_LEVER_NAMES,
  ObserverLeverTracker,
  type ObserverLeverEvaluation,
  type ObserverLeverSnapshotInput,
} from './levers.js';
import {
  createObserverEvalComparisonMetrics,
  createPostgresObserverEvalSidecarStore,
  type ObserverEvalSidecarErrorState,
  type ObserverEvalSidecarLeverPersistencePort,
  type ObserverEvalSidecarLeverStateEntry,
  type ObserverEvalSidecarObservationInput,
  type ObserverEvalSidecarPersistencePort,
  type ObserverEvalSidecarRetentionMetadata,
} from './persistence.js';
import { projectObserverEvalToEmoSim } from './projection.js';
import type {
  ObserverEvalInput,
  ObserverEvalInputPayload,
  ObserverEvalSidecarConfig,
  ObserverEvalSidecarPort,
  ObserverEvalSidecarRuntime,
} from './types.js';

const OBSERVER_EVAL_RUN_PREFIX = 'observer-eval-sidecar';
const DAY_MS = 86_400_000;
const OBSERVER_EVAL_LEVER_MIN_RETENTION_DAYS = 90;

export function createObserverEvalSidecarRuntimeFromConfig(
  config: Pick<SubstrateConfig, 'observerEvalSidecar' | 'persistenceBackend'>,
  dependencies: { postgresDatabaseUrl?: string },
): ObserverEvalSidecarRuntime {
  const settings = structuredClone(
    config.observerEvalSidecar ?? createDefaultObserverEvalSidecarSettings(),
  );
  const persistence = createObserverEvalSidecarPersistence(
    config,
    settings,
    dependencies.postgresDatabaseUrl,
  );

  return {
    config: settings,
    observer: createObserverEvalSidecarPort(settings, persistence),
  };
}

function createObserverEvalSidecarPort(
  settings: ObserverEvalSidecarConfig,
  persistence: ObserverEvalSidecarPersistencePort | null,
): ObserverEvalSidecarPort | null {
  if (settings.enabled !== true || settings.adapter?.kind !== 'emosim_server') {
    return null;
  }
  const serverUrl = settings.adapter.serverUrl?.trim();
  const sessionLabel = settings.adapter.sessionLabel?.trim();
  const agentName = settings.adapter.agentName?.trim();
  if (!serverUrl || !sessionLabel || !agentName) {
    // Startup config validation (validateObserverEvalSidecarStartupConfig and
    // the settings normalizer) already fails closed on these; reaching this
    // point means the sidecar was constructed without validated settings.
    throw new Error(
      'observerEvalSidecar.adapter requires serverUrl, sessionLabel, and agentName for kind=emosim_server',
    );
  }

  return new EmoSimObserverEvalSidecar({
    config: settings,
    persistence,
    // One runner per sidecar: it caches the contract check and the persistent
    // session bootstrap across observations.
    runner: createEmoSimServerRunner({
      serverUrl,
      sessionLabel,
      agentName,
      ...(settings.adapter.timeoutMs !== undefined ? { timeoutMs: settings.adapter.timeoutMs } : {}),
    }),
  });
}

function createObserverEvalSidecarPersistence(
  config: Pick<SubstrateConfig, 'persistenceBackend'>,
  settings: ObserverEvalSidecarConfig,
  postgresDatabaseUrlInput: string | undefined,
): ObserverEvalSidecarPersistencePort | null {
  if (settings.persistence?.enabled !== true) {
    return null;
  }
  if (config.persistenceBackend !== 'postgres') {
    throw new Error(
      'observerEvalSidecar.persistence requires persistenceBackend=postgres',
    );
  }
  const postgresDatabaseUrl = postgresDatabaseUrlInput?.trim();
  if (!postgresDatabaseUrl) {
    throw new Error(
      'observerEvalSidecar.persistence requires an explicit PostgreSQL database URL',
    );
  }
  return createPostgresObserverEvalSidecarStore(postgresDatabaseUrl);
}

interface EmoSimObserverEvalSidecarOptions {
  config: ObserverEvalSidecarConfig;
  persistence: ObserverEvalSidecarPersistencePort | null;
  runner: EmoSimRunner;
}

class EmoSimObserverEvalSidecar implements ObserverEvalSidecarPort {
  private readonly runId: string;
  private readonly startedAtMs: number;
  private runRecorded = false;
  private readonly leverStage: ObserverEvalLeverStage | null;

  constructor(private readonly options: EmoSimObserverEvalSidecarOptions) {
    this.startedAtMs = Date.now();
    this.runId = [
      OBSERVER_EVAL_RUN_PREFIX,
      normalizeIdPart(options.config.sidecarId ?? 'sidecar'),
      String(process.pid),
      String(this.startedAtMs),
    ].join('-');
    this.leverStage = createObserverEvalLeverStage({
      settings: options.config.levers,
      persistence: options.persistence,
      sidecarId: options.config.sidecarId ?? OBSERVER_EVAL_RUN_PREFIX,
      retentionDays: options.config.persistence?.retentionDays ?? 14,
    });
  }

  async observeTurn(input: ObserverEvalInput): Promise<void> {
    const rawInput = input as ObserverEvalInputPayload;
    const projection = projectObserverEvalToEmoSim(rawInput, {
      runId: this.runId,
      includeWorldState: this.options.config.adapter?.includeWorldState ?? false,
    });
    const emosim = projection.ok
      ? await runEmoSimProjectedStimulus(projection.adapterInput, { runner: this.options.runner })
      : undefined;
    const crosswalk = projection.ok && emosim?.ok
      ? createObserverEmotionCrosswalk({
        psfn: rawInput.emotion.snapshot,
        emosim: emosim.output,
      })
      : undefined;
    const error = buildObservationError(projection, emosim);

    let observationId: string | null = null;
    if (this.options.persistence) {
      observationId = await this.recordObservation({
        rawInput,
        projection,
        emosim,
        crosswalk,
        error,
      });
    }

    if (this.leverStage && observationId) {
      // Lever evaluation runs strictly AFTER the observation is persisted and
      // feeds on the same observation payload. Lever failure must not fail
      // the observation: it is logged through the sidecar's error channel and
      // recorded on the persisted lever state -- never silently swallowed and
      // never propagated into the observation path.
      await this.leverStage.evaluateObservation({
        runId: this.runId,
        observationId,
        snapshot: toObserverLeverSnapshot(emosim?.ok ? emosim.output : undefined),
        observedAtMs: Date.now(),
      });
    }

    if (error && shouldPropagateObserverEvalObservationError(error, Boolean(this.options.persistence))) {
      throw new Error(error.message);
    }
  }

  private async recordObservation(input: {
    rawInput: ObserverEvalInputPayload;
    projection: ReturnType<typeof projectObserverEvalToEmoSim>;
    emosim: Awaited<ReturnType<typeof runEmoSimProjectedStimulus>> | undefined;
    crosswalk: ReturnType<typeof createObserverEmotionCrosswalk> | undefined;
    error: ObserverEvalSidecarErrorState | undefined;
  }): Promise<string | null> {
    const persistence = this.options.persistence;
    if (!persistence) {
      return null;
    }

    await this.ensureRunRecorded(persistence);
    const observedAtMs = Date.now();
    const observation: ObserverEvalSidecarObservationInput = {
      observationId: [
        this.runId,
        normalizeIdPart(String(input.rawInput.turn.turnId)),
        String(observedAtMs),
      ].join(':'),
      runId: this.runId,
      sanitizedInput: input.projection.sanitizedInput,
      observedAtMs,
      projection: input.projection,
      ...(input.emosim ? { emosim: input.emosim } : {}),
      ...(input.crosswalk ? { crosswalk: input.crosswalk } : {}),
      comparisonMetrics: createObserverEvalComparisonMetrics(input.crosswalk, {
        sidecarId: this.options.config.sidecarId ?? null,
        adapterKind: this.options.config.adapter?.kind ?? null,
      }),
      ...(input.error ? { error: input.error } : {}),
      retention: this.makeRetention(observedAtMs),
    };
    await persistence.recordObservation(observation);
    await persistence.pruneExpiredRetention(observedAtMs);
    return observation.observationId;
  }

  private async ensureRunRecorded(persistence: ObserverEvalSidecarPersistencePort): Promise<void> {
    if (this.runRecorded) {
      return;
    }
    await persistence.upsertRun({
      runId: this.runId,
      sidecarId: this.options.config.sidecarId ?? OBSERVER_EVAL_RUN_PREFIX,
      deployment: toObserverEvalPersistenceDeployment(this.options.config.deploymentTarget),
      status: 'running',
      startedAtMs: this.startedAtMs,
      retention: this.makeRetention(this.startedAtMs),
      metadata: {
        mode: this.options.config.mode ?? 'observe_only',
        adapterKind: this.options.config.adapter?.kind ?? 'unknown',
      },
    });
    this.runRecorded = true;
  }

  private makeRetention(capturedAtMs: number) {
    const retentionDays = this.options.config.persistence?.retentionDays ?? 14;
    return {
      retentionClass: 'standard' as const,
      policyId: `${OBSERVER_EVAL_RUN_PREFIX}-runtime`,
      capturedAtMs,
      retainUntilMs: capturedAtMs + (retentionDays * DAY_MS),
      reason: 'Observer eval sidecar runtime telemetry retention',
    };
  }
}

function buildObservationError(
  projection: ReturnType<typeof projectObserverEvalToEmoSim>,
  emosim: Awaited<ReturnType<typeof runEmoSimProjectedStimulus>> | undefined,
): ObserverEvalSidecarErrorState | undefined {
  if (!projection.ok) {
    return {
      message: projection.error.message,
      code: projection.error.reason,
      recoverable: projection.error.recoverable,
      redacted: true,
      redactionReason: 'observer_eval_projection_error',
      ...(projection.error.details ? { details: projection.error.details } : {}),
    };
  }
  if (emosim && !emosim.ok) {
    return {
      message: emosim.error.message,
      code: emosim.error.reason,
      recoverable: emosim.error.recoverable,
      redacted: true,
      redactionReason: 'observer_eval_emosim_error',
      ...(emosim.error.details ? { details: emosim.error.details } : {}),
    };
  }
  return undefined;
}

export function shouldPropagateObserverEvalObservationError(
  error: ObserverEvalSidecarErrorState | undefined,
  persistenceAvailable: boolean,
): boolean {
  if (!error) {
    return false;
  }
  if (!persistenceAvailable) {
    return true;
  }
  return error.recoverable !== true;
}

function normalizeIdPart(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized.length > 0 ? normalized : 'unknown';
}

export function toObserverLeverSnapshot(
  output: EmoSimAdapterOutput | undefined,
): ObserverLeverSnapshotInput | null {
  const snapshot = output?.snapshots.afterTick;
  if (!snapshot) {
    return null;
  }
  // Historical rows / degraded runtimes may omit drives entirely even though
  // the current adapter contract types them as required; the lever module
  // treats missing drives as inputs_unavailable, never a throw.
  const drives = (snapshot as Partial<Pick<typeof snapshot, 'drives'>>).drives;
  return {
    t: snapshot.t,
    mood: {
      valence: snapshot.mood.valence,
      arousal: snapshot.mood.arousal,
    },
    dominant: snapshot.dominant,
    emotions: { ...snapshot.emotions },
    drives: drives ? { ...drives } : null,
  };
}

interface ObserverEvalLeverStageOptions {
  settings: ObserverEvalSidecarLeverSettings;
  persistence: ObserverEvalSidecarLeverPersistencePort;
  sidecarId: string;
  retentionDays: number;
}

function createObserverEvalLeverStage(input: {
  settings: ObserverEvalSidecarLeverSettings | undefined;
  persistence: ObserverEvalSidecarPersistencePort | null;
  sidecarId: string;
  retentionDays: number;
}): ObserverEvalLeverStage | null {
  if (input.settings?.enabled !== true) {
    return null;
  }
  if (!input.persistence || !isLeverPersistencePort(input.persistence)) {
    // Config validation already fails closed on levers without persistence;
    // this guards composition paths that inject a bare observation store.
    return null;
  }
  return new ObserverEvalLeverStage({
    settings: input.settings,
    persistence: input.persistence,
    sidecarId: input.sidecarId,
    retentionDays: input.retentionDays,
  });
}

function isLeverPersistencePort(
  persistence: ObserverEvalSidecarPersistencePort,
): persistence is ObserverEvalSidecarPersistencePort & ObserverEvalSidecarLeverPersistencePort {
  const candidate = persistence as Partial<ObserverEvalSidecarLeverPersistencePort>;
  return typeof candidate.recordLeverEvent === 'function'
    && typeof candidate.queryLeverEvents === 'function'
    && typeof candidate.loadLeverState === 'function'
    && typeof candidate.saveLeverState === 'function'
    && typeof candidate.pruneExpiredLeverEvents === 'function';
}

/**
 * Shadow lever stage: runs after each persisted observation and emits
 * WOULD-ACT telemetry events. TRACKING ONLY -- writes go to the eval-owned,
 * non-authoritative lever tables; the only reader is the Garden admin
 * service. Nothing in the live companion loop consumes these events.
 */
export class ObserverEvalLeverStage {
  private tracker: ObserverLeverTracker | null = null;
  private readonly logger = createComponentLogger('ObserverEvalSidecarLevers');

  constructor(private readonly options: ObserverEvalLeverStageOptions) {}

  async evaluateObservation(input: {
    runId: string;
    observationId: string;
    snapshot: ObserverLeverSnapshotInput | null;
    observedAtMs: number;
  }): Promise<void> {
    try {
      const tracker = await this.ensureTracker();
      const evaluation = tracker.evaluate({
        snapshot: input.snapshot,
        observedAtMs: input.observedAtMs,
      });
      for (const event of evaluation.events) {
        await this.options.persistence.recordLeverEvent({
          eventId: `${input.runId}:lever:${event.lever}:${event.firedAtMs}`,
          runId: input.runId,
          lever: event.lever,
          firedAtMs: event.firedAtMs,
          observationId: input.observationId,
          detail: event.detail,
          stateValues: event.stateValues,
          sustainMs: event.sustainMs,
          firstCrossingMs: event.firstCrossingMs,
          cooldown: event.cooldown,
          retention: this.makeLeverRetention(event.firedAtMs),
        });
      }
      await this.persistTrackerState(tracker, evaluation, input.observedAtMs);
      await this.options.persistence.pruneExpiredLeverEvents(input.observedAtMs);
    } catch (error) {
      // Lever failure must not fail the observation. This is not a silent
      // catch: the failure goes through the sidecar's component logger and is
      // recorded on the persisted lever state (best effort).
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('Observer eval sidecar lever evaluation failed', {
        sidecarId: this.options.sidecarId,
        runId: input.runId,
        observationId: input.observationId,
        error: message,
      });
      await this.persistEvaluationFailure(message, input.observedAtMs);
    }
  }

  private async ensureTracker(): Promise<ObserverLeverTracker> {
    if (this.tracker) {
      return this.tracker;
    }
    const entries = await this.options.persistence.loadLeverState(this.options.sidecarId);
    const state = createEmptyObserverLeverTrackerState();
    for (const entry of entries) {
      state.levers[entry.lever] = normalizeObserverLeverTrackerState({
        schemaVersion: state.schemaVersion,
        levers: { [entry.lever]: entry.state },
      }).levers[entry.lever];
    }
    this.tracker = new ObserverLeverTracker(this.options.settings, state);
    return this.tracker;
  }

  private async persistTrackerState(
    tracker: ObserverLeverTracker,
    evaluation: ObserverLeverEvaluation,
    observedAtMs: number,
  ): Promise<void> {
    const state = tracker.getState();
    const entries: ObserverEvalSidecarLeverStateEntry[] = evaluation.entries.map(entry => ({
      lever: entry.lever,
      state: {
        ...state.levers[entry.lever],
        lastEvaluation: {
          at: observedAtMs,
          status: entry.status,
          outcome: entry.outcome,
          notes: entry.notes,
          missingInputs: entry.missingInputs,
        },
      },
    }));
    await this.options.persistence.saveLeverState({
      sidecarId: this.options.sidecarId,
      updatedAtMs: observedAtMs,
      entries,
    });
  }

  private async persistEvaluationFailure(message: string, observedAtMs: number): Promise<void> {
    try {
      const state = this.tracker?.getState() ?? createEmptyObserverLeverTrackerState();
      await this.options.persistence.saveLeverState({
        sidecarId: this.options.sidecarId,
        updatedAtMs: observedAtMs,
        entries: OBSERVER_EVAL_LEVER_NAMES.map(lever => ({
          lever,
          state: {
            ...state.levers[lever],
            lastEvaluation: {
              at: observedAtMs,
              status: 'error',
              error: message,
            },
          },
        })),
      });
    } catch (persistError) {
      this.logger.error('Observer eval sidecar lever failure could not be persisted', {
        sidecarId: this.options.sidecarId,
        error: persistError instanceof Error ? persistError.message : String(persistError),
      });
    }
  }

  private makeLeverRetention(firedAtMs: number): ObserverEvalSidecarRetentionMetadata {
    const retentionDays = Math.max(OBSERVER_EVAL_LEVER_MIN_RETENTION_DAYS, this.options.retentionDays);
    return {
      retentionClass: 'extended',
      policyId: `${OBSERVER_EVAL_RUN_PREFIX}-lever-events`,
      capturedAtMs: firedAtMs,
      retainUntilMs: firedAtMs + (retentionDays * DAY_MS),
      reason: 'Observer eval sidecar shadow lever WOULD-ACT telemetry retention (>= 90 days for longitudinal review)',
    };
  }
}

export function toObserverEvalPersistenceDeployment(
  deploymentTarget: ObserverEvalSidecarConfig['deploymentTarget'] | undefined,
): 'live' | 'eval' | 'test' {
  if (deploymentTarget === 'live' || deploymentTarget === 'eval') {
    return deploymentTarget;
  }
  return 'test';
}
