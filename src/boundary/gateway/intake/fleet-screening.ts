import type { CompanionId } from '../../../shared/routing/companion-id.js';
import type { IntakeScreeningService } from '../../../core/cogsec/intake/screening.js';
import type { CogSecMode, IntakeEnforcementPosture } from '../../../shared/contracts/cogsec-mode.js';
import type { IntakeQuarantineStore } from '../../../core/cogsec/intake/quarantine-store.js';
import { loadIntakePolicyConfig } from '../../../system/config/intake-policy-config.js';
import {
  createQuarantinedArtifactAccessGuard,
  createUnionQuarantinedArtifactAccessGuard,
  type QuarantinedArtifactAccessGuard,
} from '../../../core/cogsec/intake/quarantined-artifact-guard.js';
import {
  composeGatewayIntakeScreening,
  type GatewayIntakeScreeningComposition,
} from './compose-screening.js';
import {
  createPooledIntakeScreeningService,
} from './pooled-screening-service.js';
import {
  createScreeningPool,
  type ScreeningPool,
  type ScreeningPoolTelemetryEvent,
} from './screening-pool.js';

type BaseCompositionInput = Parameters<typeof composeGatewayIntakeScreening>[0];
type QuarantineExpiredEvent = Parameters<
  NonNullable<BaseCompositionInput['onQuarantineExpired']>
>[0];
type FailClosedScreeningEvent = Parameters<
  NonNullable<BaseCompositionInput['onFailClosedScreening']>
>[0];
type ScreeningTimingEvent = Parameters<
  NonNullable<BaseCompositionInput['onScreeningTiming']>
>[0];

export interface GatewayFleetScreeningCompanion {
  companionId: CompanionId;
  companionDataDir: string;
}

export type GatewayIntakeScreeningRuntimeInput = Omit<
  BaseCompositionInput,
  | 'companionDataDir'
  | 'onQuarantineHeld'
  | 'onQuarantineExpired'
  | 'onFailClosedScreening'
  | 'onScreeningTiming'
> & {
  /** Existing single-companion root; used byte-for-byte when fleet mode is disabled. */
  companionDataDir: string;
  multiCompanion: boolean;
  /** Required, exact fleet topology when multiCompanion is true. */
  companions?: readonly GatewayFleetScreeningCompanion[];
  onQuarantineHeld?: (companionId?: CompanionId) => void;
  onQuarantineExpired?: (
    companionId: CompanionId | undefined,
    event: QuarantineExpiredEvent,
  ) => void;
  onFailClosedScreening?: (
    companionId: CompanionId | undefined,
    event: FailClosedScreeningEvent,
  ) => void;
  onScreeningTiming?: (
    companionId: CompanionId | undefined,
    event: ScreeningTimingEvent,
  ) => void;
  /**
   * Content-free bounded-pool telemetry (psfn-framework-yxz0z.4): queue depth,
   * wait/service time, and worker saturation per pooled screen() call. Never
   * carries screened content; `streamKey` is the owning companion id.
   */
  onScreeningPoolTelemetry?: (
    companionId: CompanionId | undefined,
    event: ScreeningPoolTelemetryEvent,
  ) => void;
  /**
   * Source-stream key for the single-companion composition (fleet mode keys by
   * companion id). Defaults to a stable single-stream key when not provided.
   */
  singleStreamKey?: string;
};

export interface GatewayIntakeScreeningRuntime {
  /** Per-instance enforcement posture (observe/enforce) of the wired screening. */
  readonly mode: IntakeEnforcementPosture;
  /** Canonical global CogSec mode (shadow/boundary/strict). */
  readonly globalMode: CogSecMode;
  /** Populated only in fleet mode; one exact composition per manifest entry. */
  readonly byCompanionId: ReadonlyMap<CompanionId, GatewayIntakeScreeningComposition>;
  /** All durable stores consulted by the fleet-wide physical read gate. */
  readonly quarantineStores: readonly IntakeQuarantineStore[];
  readonly quarantinedArtifactGuard: QuarantinedArtifactAccessGuard | null;
  /**
   * Single mode ignores the optional id and returns the historical composition.
   * Fleet mode requires an exact registered id and never falls back.
   */
  resolve(companionId?: string): GatewayIntakeScreeningComposition;
  /**
   * Pooled screening service for `companionId` (or the single composition). Each
   * screen() flows through the fleet-wide bounded pool keyed by companion id;
   * screenSync() is the unpooled synchronous L1-only path.
   */
  screeningFor(companionId?: string): IntakeScreeningService | null;
  /** Fleet-wide bounded async screening pool. */
  readonly screeningPool: ScreeningPool;
  dispose(): Promise<void>;
}

function compositionMode(
  composition: GatewayIntakeScreeningComposition,
): IntakeEnforcementPosture {
  const screening = composition.screening;
  if (!screening) {
    throw new Error('Gateway intake screening composition resolved no service');
  }
  return screening.mode;
}

function compositionGlobalMode(
  composition: GatewayIntakeScreeningComposition,
): CogSecMode {
  const screening = composition.screening;
  if (!screening) {
    throw new Error('Gateway intake screening composition resolved no service');
  }
  return screening.globalMode;
}

async function disposeCompositions(
  compositions: readonly GatewayIntakeScreeningComposition[],
  primaryError?: unknown,
): Promise<void> {
  const cleanupErrors: unknown[] = [];
  for (const composition of [...compositions].reverse()) {
    try {
      await composition.dispose();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length === 0) {
    if (primaryError !== undefined) throw primaryError;
    return;
  }
  if (primaryError !== undefined) {
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      'Gateway intake screening composition failed and cleanup also failed',
    );
  }
  throw new AggregateError(
    cleanupErrors,
    'One or more gateway intake screening compositions failed to dispose',
  );
}

export async function composeGatewayIntakeScreeningRuntime(
  input: GatewayIntakeScreeningRuntimeInput,
): Promise<GatewayIntakeScreeningRuntime> {
  const {
    multiCompanion,
    companions,
    companionDataDir,
    onQuarantineHeld,
    onQuarantineExpired,
    onFailClosedScreening,
    onScreeningTiming,
    onScreeningPoolTelemetry,
    singleStreamKey,
    ...baseInput
  } = input;
  const compositions: GatewayIntakeScreeningComposition[] = [];
  const byCompanionId = new Map<CompanionId, GatewayIntakeScreeningComposition>();

  const composeOne = async (
    ownedCompanionDataDir: string,
    companionId?: CompanionId,
  ): Promise<GatewayIntakeScreeningComposition> => {
    const composition = await composeGatewayIntakeScreening({
      ...baseInput,
      companionDataDir: ownedCompanionDataDir,
      ...(onQuarantineHeld
        ? { onQuarantineHeld: () => onQuarantineHeld(companionId) }
        : {}),
      ...(onQuarantineExpired
        ? { onQuarantineExpired: event => onQuarantineExpired(companionId, event) }
        : {}),
      ...(onFailClosedScreening
        ? { onFailClosedScreening: event => onFailClosedScreening(companionId, event) }
        : {}),
      ...(onScreeningTiming
        ? { onScreeningTiming: event => onScreeningTiming(companionId, event) }
        : {}),
    });
    compositions.push(composition);
    return composition;
  };

  let singleComposition: GatewayIntakeScreeningComposition | null = null;
  try {
    if (!multiCompanion) {
      // Preserve the historical composition exactly: one service, one store,
      // rooted at startupHydration.companionDataDir.
      singleComposition = await composeOne(companionDataDir);
    } else {
      if (!companions || companions.length === 0) {
        throw new Error(
          'Multi-companion intake screening requires a non-empty resolved companion fleet',
        );
      }
      for (const companion of companions) {
        if (byCompanionId.has(companion.companionId)) {
          throw new Error(
            `Multi-companion intake screening has duplicate companionId ${companion.companionId}`,
          );
        }
        const composition = await composeOne(
          companion.companionDataDir,
          companion.companionId,
        );
        byCompanionId.set(companion.companionId, composition);
      }
    }
  } catch (error) {
    await disposeCompositions(compositions, error);
    throw error;
  }

  const firstComposition = singleComposition ?? byCompanionId.values().next().value;
  if (!firstComposition) {
    throw new Error('Gateway intake screening composition produced no runtime');
  }
  const mode = compositionMode(firstComposition);
  const globalMode = compositionGlobalMode(firstComposition);
  for (const composition of compositions) {
    if (compositionMode(composition) !== mode) {
      await disposeCompositions(
        compositions,
        new Error('Fleet intake screening compositions resolved inconsistent firewall modes'),
      );
    }
  }
  const quarantineStores = compositions
    .map(composition => composition.quarantine)
    .filter((store): store is IntakeQuarantineStore => store !== null);
  const quarantinedArtifactGuard = multiCompanion
    ? createUnionQuarantinedArtifactAccessGuard({
        stores: quarantineStores,
        mode,
      })
    : createQuarantinedArtifactAccessGuard({
        store: singleComposition!.quarantine!,
        mode,
      });

  // ── Fleet-wide bounded screening pool (psfn-framework-yxz0z.4) ──
  // ONE pool spans every companion so the operator-owned worker bound limits
  // fleet-wide concurrency. Each companion's service is wrapped so its screen()
  // is keyed by that companion's id: independent companions overlap up to the
  // bound, a single companion's inbound stream stays serial (deterministic
  // decision/delivery order), and each companion's classifier/quarantine is
  // reached by at most one in-flight item at a time (no shared-mutable races).
  const SINGLE_STREAM_KEY = singleStreamKey ?? '__single__';
  const screeningPolicy = loadIntakePolicyConfig(baseInput.systemDataDir);
  const pool = createScreeningPool({
    concurrency: screeningPolicy.screeningPool.concurrency,
    maxQueueDepth: screeningPolicy.screeningPool.maxQueueDepth,
    ...(onScreeningPoolTelemetry
      ? {
          onTelemetry: (event) => {
            const companionId = event.streamKey === SINGLE_STREAM_KEY
              ? undefined
              : (event.streamKey as CompanionId);
            onScreeningPoolTelemetry(companionId, event);
          },
        }
      : {}),
  });
  const pooledByCompanionId = new Map<CompanionId, IntakeScreeningService>();
  let pooledSingle: IntakeScreeningService | null = null;
  {
    const policy = screeningPolicy;
    const wrap = (
      underlying: IntakeScreeningService,
      streamKey: string,
      companionId?: CompanionId,
    ): IntakeScreeningService => createPooledIntakeScreeningService({
      underlying,
      pool,
      streamKey,
      policy,
      ...(onFailClosedScreening
        ? { onFailClosed: event => onFailClosedScreening(companionId, event) }
        : {}),
    });
    if (!multiCompanion) {
      pooledSingle = singleComposition?.screening
        ? wrap(singleComposition.screening, SINGLE_STREAM_KEY)
        : null;
    } else {
      for (const companion of companions ?? []) {
        const composition = byCompanionId.get(companion.companionId);
        if (composition?.screening) {
          pooledByCompanionId.set(
            companion.companionId,
            wrap(composition.screening, companion.companionId, companion.companionId),
          );
        }
      }
    }
  }

  const resolve = (companionId?: string): GatewayIntakeScreeningComposition => {
    if (!multiCompanion) return singleComposition!;
    if (!companionId) {
      throw new Error('Fleet intake screening requires an owning companionId');
    }
    const composition = byCompanionId.get(companionId as CompanionId);
    if (!composition) {
      throw new Error(
        `Fleet intake screening has no composition for companionId ${JSON.stringify(companionId)}`,
      );
    }
    return composition;
  };

  const screeningFor = (companionId?: string): IntakeScreeningService | null => {
    if (!multiCompanion) return pooledSingle;
    if (!companionId) {
      throw new Error('Fleet intake screening requires an owning companionId');
    }
    return pooledByCompanionId.get(companionId as CompanionId) ?? null;
  };

  const disposeCompositionsAndPool = async (): Promise<void> => {
    // Drain the pool first so in-flight screening settles (no orphaned
    // quarantine holds) before the underlying services/stores are torn down.
    try {
      await pool.dispose();
    } catch {
      // dispose() never throws, but never let pool cleanup block composition
      // teardown if an observer misbehaved.
    }
    await disposeCompositions(compositions);
  };

  return {
    mode,
    globalMode,
    byCompanionId,
    quarantineStores,
    quarantinedArtifactGuard,
    screeningPool: pool,
    resolve,
    screeningFor,
    dispose: disposeCompositionsAndPool,
  };
}
