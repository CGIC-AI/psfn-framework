import { createDefaultObserverEvalSidecarSettings } from '../../../system/config/runtime-config-contracts.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import { createObserverEmotionCrosswalk } from './crosswalk.js';
import { runEmoSimProjectedStimulus } from './emosim-adapter.js';
import {
  createObserverEvalComparisonMetrics,
  createPostgresObserverEvalSidecarStore,
  type ObserverEvalSidecarErrorState,
  type ObserverEvalSidecarObservationInput,
  type ObserverEvalSidecarPersistencePort,
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

export function createObserverEvalSidecarRuntimeFromConfig(
  config: Pick<SubstrateConfig, 'observerEvalSidecar' | 'persistenceBackend' | 'postgresDatabaseUrl'>,
): ObserverEvalSidecarRuntime {
  const settings = structuredClone(
    config.observerEvalSidecar ?? createDefaultObserverEvalSidecarSettings(),
  );
  const persistence = createObserverEvalSidecarPersistence(config, settings);

  return {
    config: settings,
    observer: createObserverEvalSidecarPort(settings, persistence),
  };
}

function createObserverEvalSidecarPort(
  settings: ObserverEvalSidecarConfig,
  persistence: ObserverEvalSidecarPersistencePort | null,
): ObserverEvalSidecarPort | null {
  if (settings.enabled !== true || settings.adapter?.kind !== 'emosim') {
    return null;
  }
  const emosimRoot = settings.adapter.emosimRoot?.trim();
  if (!emosimRoot) {
    return null;
  }

  return new EmoSimObserverEvalSidecar({
    config: settings,
    persistence,
    emosimRoot,
  });
}

function createObserverEvalSidecarPersistence(
  config: Pick<SubstrateConfig, 'persistenceBackend' | 'postgresDatabaseUrl'>,
  settings: ObserverEvalSidecarConfig,
): ObserverEvalSidecarPersistencePort | null {
  if (settings.persistence?.enabled !== true) {
    return null;
  }
  const postgresDatabaseUrl = config.postgresDatabaseUrl?.trim();
  if (config.persistenceBackend !== 'postgres' || !postgresDatabaseUrl) {
    return null;
  }
  return createPostgresObserverEvalSidecarStore(postgresDatabaseUrl);
}

interface EmoSimObserverEvalSidecarOptions {
  config: ObserverEvalSidecarConfig;
  persistence: ObserverEvalSidecarPersistencePort | null;
  emosimRoot: string;
}

class EmoSimObserverEvalSidecar implements ObserverEvalSidecarPort {
  private readonly runId: string;
  private readonly startedAtMs: number;
  private runRecorded = false;

  constructor(private readonly options: EmoSimObserverEvalSidecarOptions) {
    this.startedAtMs = Date.now();
    this.runId = [
      OBSERVER_EVAL_RUN_PREFIX,
      normalizeIdPart(options.config.sidecarId ?? 'sidecar'),
      String(process.pid),
      String(this.startedAtMs),
    ].join('-');
  }

  async observeTurn(input: ObserverEvalInput): Promise<void> {
    const rawInput = input as ObserverEvalInputPayload;
    const projection = projectObserverEvalToEmoSim(rawInput, {
      runId: this.runId,
      includeWorldState: this.options.config.adapter?.includeWorldState ?? false,
    });
    const emosim = projection.ok
      ? await runEmoSimProjectedStimulus(projection.adapterInput, {
        emoSimRoot: this.options.emosimRoot,
        ...(this.options.config.adapter?.pythonExecutable
          ? { pythonExecutable: this.options.config.adapter.pythonExecutable }
          : {}),
        ...(this.options.config.adapter?.timeoutMs !== undefined
          ? { timeoutMs: this.options.config.adapter.timeoutMs }
          : {}),
      })
      : undefined;
    const crosswalk = projection.ok && emosim?.ok
      ? createObserverEmotionCrosswalk({
        psfn: rawInput.emotion.snapshot,
        emosim: emosim.output,
      })
      : undefined;
    const error = buildObservationError(projection, emosim);

    if (this.options.persistence) {
      await this.recordObservation({
        rawInput,
        projection,
        emosim,
        crosswalk,
        error,
      });
    }

    if (error) {
      throw new Error(error.message);
    }
  }

  private async recordObservation(input: {
    rawInput: ObserverEvalInputPayload;
    projection: ReturnType<typeof projectObserverEvalToEmoSim>;
    emosim: Awaited<ReturnType<typeof runEmoSimProjectedStimulus>> | undefined;
    crosswalk: ReturnType<typeof createObserverEmotionCrosswalk> | undefined;
    error: ObserverEvalSidecarErrorState | undefined;
  }): Promise<void> {
    const persistence = this.options.persistence;
    if (!persistence) {
      return;
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
  }

  private async ensureRunRecorded(persistence: ObserverEvalSidecarPersistencePort): Promise<void> {
    if (this.runRecorded) {
      return;
    }
    await persistence.upsertRun({
      runId: this.runId,
      sidecarId: this.options.config.sidecarId ?? OBSERVER_EVAL_RUN_PREFIX,
      deployment: this.options.config.deploymentTarget ?? 'test_persona',
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

function normalizeIdPart(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized.length > 0 ? normalized : 'unknown';
}
