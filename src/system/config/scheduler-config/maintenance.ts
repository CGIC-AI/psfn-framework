import { isRecord } from '../../../shared/utils/types.js';
import { assertNoUnknownKeys } from '../validators.js';
import { toInterval, toPositiveInteger } from './primitives.js';

export interface ArtifactLifecyclePolicyConfig {
  scratchpadRetentionDays: number;
  generatedMediaRetentionDays: number;
  workspaceTempRetentionDays: number;
  cleanupBatchSize: number;
}

/**
 * Shared cadence for cheap background housekeeping. The runtime exposes every
 * operation attached to this tick in Garden; this is deliberately one honest
 * knob rather than a hidden alias or one interval per maintenance operation.
 */
export interface BackgroundMaintenanceConfig {
  /** Shared poll interval for every operation listed by the bundled task. */
  intervalMs: number;
  /** Bounded approved shared-world projection drift checks per maintenance tick. */
  sharedWorldWikiCaretaker: {
    batchSize: number;
  };
  /** Ambient-presence eligibility thresholds evaluated on the shared tick. */
  ambientPresence: {
    minIdleMinutes: number;
    minNoteIntervalMinutes: number;
  };
  /** Concern-set grooming threshold evaluated on the shared tick. */
  concernGrooming: {
    maxActiveConcerns: number;
  };
}

export const DEFAULT_BACKGROUND_MAINTENANCE_CONFIG: BackgroundMaintenanceConfig = {
  intervalMs: 3_600_000,
  sharedWorldWikiCaretaker: {
    batchSize: 25,
  },
  ambientPresence: {
    minIdleMinutes: 180,
    minNoteIntervalMinutes: 360,
  },
  concernGrooming: {
    maxActiveConcerns: 7,
  },
};

export function validateArtifactLifecycleConfig(
  raw: unknown,
  sourcePath: string,
): ArtifactLifecyclePolicyConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: artifactLifecycle must be an object`);
  }

  return {
    scratchpadRetentionDays: toPositiveInteger(raw.scratchpadRetentionDays, 'artifactLifecycle.scratchpadRetentionDays', 1),
    generatedMediaRetentionDays: toPositiveInteger(raw.generatedMediaRetentionDays, 'artifactLifecycle.generatedMediaRetentionDays', 1),
    workspaceTempRetentionDays: toPositiveInteger(raw.workspaceTempRetentionDays, 'artifactLifecycle.workspaceTempRetentionDays', 1),
    cleanupBatchSize: toPositiveInteger(raw.cleanupBatchSize, 'artifactLifecycle.cleanupBatchSize', 1),
  };
}

export function validateBackgroundMaintenanceConfig(
  raw: unknown,
  sourcePath: string,
): BackgroundMaintenanceConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: backgroundMaintenance must be an object`);
  }
  if (!isRecord(raw.ambientPresence)) {
    throw new Error(
      `Invalid scheduler config at ${sourcePath}: backgroundMaintenance.ambientPresence must be an object`,
    );
  }
  if (!isRecord(raw.sharedWorldWikiCaretaker)) {
    throw new Error(
      `Invalid scheduler config at ${sourcePath}: backgroundMaintenance.sharedWorldWikiCaretaker must be an object`,
    );
  }
  assertNoUnknownKeys(
    raw.sharedWorldWikiCaretaker,
    ['batchSize'],
    `${sourcePath}.backgroundMaintenance.sharedWorldWikiCaretaker`,
    { errorPrefix: 'Invalid scheduler config' },
  );
  if (!isRecord(raw.concernGrooming)) {
    throw new Error(
      `Invalid scheduler config at ${sourcePath}: backgroundMaintenance.concernGrooming must be an object`,
    );
  }
  return {
    intervalMs: toInterval(raw.intervalMs, 'backgroundMaintenance.intervalMs'),
    sharedWorldWikiCaretaker: {
      batchSize: toPositiveInteger(
        raw.sharedWorldWikiCaretaker.batchSize,
        'backgroundMaintenance.sharedWorldWikiCaretaker.batchSize',
        1,
      ),
    },
    ambientPresence: {
      minIdleMinutes: toPositiveInteger(
        raw.ambientPresence.minIdleMinutes,
        'backgroundMaintenance.ambientPresence.minIdleMinutes',
        1,
      ),
      minNoteIntervalMinutes: toPositiveInteger(
        raw.ambientPresence.minNoteIntervalMinutes,
        'backgroundMaintenance.ambientPresence.minNoteIntervalMinutes',
        1,
      ),
    },
    concernGrooming: {
      maxActiveConcerns: toPositiveInteger(
        raw.concernGrooming.maxActiveConcerns,
        'backgroundMaintenance.concernGrooming.maxActiveConcerns',
        1,
      ),
    },
  };
}
