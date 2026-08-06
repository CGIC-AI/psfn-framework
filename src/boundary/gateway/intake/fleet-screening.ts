import type { CompanionId } from '../../../shared/routing/companion-id.js';
import type { IntakeScreeningService } from '../../../core/cogsec/intake/screening.js';
import type { IntakeQuarantineStore } from '../../../core/cogsec/intake/quarantine-store.js';
import {
  createQuarantinedArtifactAccessGuard,
  createUnionQuarantinedArtifactAccessGuard,
  type QuarantinedArtifactAccessGuard,
} from '../../../core/cogsec/intake/quarantined-artifact-guard.js';
import {
  composeGatewayIntakeScreening,
  type GatewayIntakeScreeningComposition,
} from './compose-screening.js';

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
};

export interface GatewayIntakeScreeningRuntime {
  readonly mode: 'off' | 'shadow' | 'enforce';
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
  screeningFor(companionId?: string): IntakeScreeningService | null;
  dispose(): Promise<void>;
}

function compositionMode(
  composition: GatewayIntakeScreeningComposition,
): GatewayIntakeScreeningRuntime['mode'] {
  return composition.screening?.mode ?? 'off';
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
  const quarantinedArtifactGuard = mode === 'off'
    ? null
    : multiCompanion
      ? createUnionQuarantinedArtifactAccessGuard({
          stores: quarantineStores,
          mode,
        })
      : createQuarantinedArtifactAccessGuard({
          store: singleComposition!.quarantine!,
          mode,
        });

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

  return {
    mode,
    byCompanionId,
    quarantineStores,
    quarantinedArtifactGuard,
    resolve,
    screeningFor: companionId => resolve(companionId).screening,
    dispose: () => disposeCompositions(compositions),
  };
}
