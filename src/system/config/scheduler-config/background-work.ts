import type { BackgroundWorkRuntimeTuning } from '../../../core/agent/background-work/config.js';
import { isRecord } from '../../../shared/utils/types.js';
import { assertNoUnknownKeys } from '../validators.js';
import { toNonNegativeInteger, toPositiveInteger } from './primitives.js';

export const DEFAULT_BACKGROUND_WORK_TUNING: BackgroundWorkRuntimeTuning = {
  supervisor: {
    maxConcurrentSessions: 4,
    leaseDurationMs: 5 * 60_000,
    retryBaseDelayMs: 1_000,
    retryMaxDelayMs: 5 * 60_000,
    shutdownTimeoutMs: 5_000,
    terminalRetentionMs: 7 * 24 * 60 * 60_000,
    cleanupIntervalMs: 60 * 60_000,
  },
  postTurn: {
    maxAttempts: 5,
    extractionDrainRequeueDelayMs: 1_000,
    foregroundPreemptionDeferDelayMs: 1_000,
  },
};

/**
 * Anti-starvation welfare reserve for durable background work (mmo9.7.4). A
 * background/reflection job repeatedly deferred by sustained foreground turns
 * accrues durable defer pressure; once it has been foreground-deferred
 * `deferThreshold` times OR its first foreground defer is at least
 * `ageThresholdMs` old, it becomes eligible to be admitted past the foreground
 * exclusion into one of `reserveSlots` globally bounded welfare slots, then runs
 * to a protected completion. This is Charter 8.8/8.9's ethical floor: reflection
 * and rest yield to conversation but are guaranteed a bounded slice rather than
 * being starved forever. Optional block — the conservative defaults apply when
 * absent. `reserveSlots: 0` disables welfare admission (fail-closed to FIFO).
 */
export interface BackgroundWorkWelfareConfig {
  deferThreshold: number;
  ageThresholdMs: number;
  reserveSlots: number;
}

export const DEFAULT_BACKGROUND_WORK_WELFARE_CONFIG: BackgroundWorkWelfareConfig = {
  deferThreshold: 8,
  ageThresholdMs: 300_000,
  reserveSlots: 1,
};

function toBackgroundWorkPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Invalid scheduler config: ${field} must be a positive safe integer`);
  }
  return value;
}

function toBackgroundWorkNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid scheduler config: ${field} must be a non-negative safe integer`);
  }
  return value;
}

export function validateBackgroundWorkConfig(
  raw: unknown,
  sourcePath: string,
): BackgroundWorkRuntimeTuning {
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: backgroundWork must be an object`);
  }
  assertNoUnknownKeys(raw, ['supervisor', 'postTurn'], `${sourcePath}.backgroundWork`, {
    errorPrefix: 'Invalid scheduler config',
  });
  if (!isRecord(raw.supervisor)) {
    throw new Error(
      `Invalid scheduler config at ${sourcePath}: backgroundWork.supervisor must be an object`,
    );
  }
  if (!isRecord(raw.postTurn)) {
    throw new Error(
      `Invalid scheduler config at ${sourcePath}: backgroundWork.postTurn must be an object`,
    );
  }
  assertNoUnknownKeys(
    raw.supervisor,
    [
      'maxConcurrentSessions',
      'leaseDurationMs',
      'retryBaseDelayMs',
      'retryMaxDelayMs',
      'shutdownTimeoutMs',
      'terminalRetentionMs',
      'cleanupIntervalMs',
    ],
    `${sourcePath}.backgroundWork.supervisor`,
    { errorPrefix: 'Invalid scheduler config' },
  );
  assertNoUnknownKeys(
    raw.postTurn,
    ['maxAttempts', 'extractionDrainRequeueDelayMs', 'foregroundPreemptionDeferDelayMs'],
    `${sourcePath}.backgroundWork.postTurn`,
    { errorPrefix: 'Invalid scheduler config' },
  );
  const supervisor = {
    maxConcurrentSessions: toBackgroundWorkPositiveInteger(
      raw.supervisor.maxConcurrentSessions,
      'backgroundWork.supervisor.maxConcurrentSessions',
    ),
    leaseDurationMs: toBackgroundWorkPositiveInteger(
      raw.supervisor.leaseDurationMs,
      'backgroundWork.supervisor.leaseDurationMs',
    ),
    retryBaseDelayMs: toBackgroundWorkPositiveInteger(
      raw.supervisor.retryBaseDelayMs,
      'backgroundWork.supervisor.retryBaseDelayMs',
    ),
    retryMaxDelayMs: toBackgroundWorkPositiveInteger(
      raw.supervisor.retryMaxDelayMs,
      'backgroundWork.supervisor.retryMaxDelayMs',
    ),
    shutdownTimeoutMs: toBackgroundWorkNonNegativeInteger(
      raw.supervisor.shutdownTimeoutMs,
      'backgroundWork.supervisor.shutdownTimeoutMs',
    ),
    terminalRetentionMs: toBackgroundWorkPositiveInteger(
      raw.supervisor.terminalRetentionMs,
      'backgroundWork.supervisor.terminalRetentionMs',
    ),
    cleanupIntervalMs: toBackgroundWorkPositiveInteger(
      raw.supervisor.cleanupIntervalMs,
      'backgroundWork.supervisor.cleanupIntervalMs',
    ),
  };
  if (supervisor.retryMaxDelayMs < supervisor.retryBaseDelayMs) {
    throw new Error(
      'Invalid scheduler config: backgroundWork.supervisor.retryMaxDelayMs '
      + 'must be greater than or equal to backgroundWork.supervisor.retryBaseDelayMs',
    );
  }
  return {
    supervisor,
    postTurn: {
      maxAttempts: toBackgroundWorkPositiveInteger(
        raw.postTurn.maxAttempts,
        'backgroundWork.postTurn.maxAttempts',
      ),
      extractionDrainRequeueDelayMs: toBackgroundWorkPositiveInteger(
        raw.postTurn.extractionDrainRequeueDelayMs,
        'backgroundWork.postTurn.extractionDrainRequeueDelayMs',
      ),
      foregroundPreemptionDeferDelayMs: toBackgroundWorkPositiveInteger(
        raw.postTurn.foregroundPreemptionDeferDelayMs,
        'backgroundWork.postTurn.foregroundPreemptionDeferDelayMs',
      ),
    },
  };
}

export function validateBackgroundWorkWelfareConfig(
  value: unknown,
  sourcePath: string,
): BackgroundWorkWelfareConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: backgroundWorkWelfare must be an object`);
  }
  const reserveSlots = toNonNegativeInteger(
    value.reserveSlots ?? DEFAULT_BACKGROUND_WORK_WELFARE_CONFIG.reserveSlots,
    'backgroundWorkWelfare.reserveSlots',
  );
  // reserveSlots: 0 disables welfare; the aging thresholds are then irrelevant
  // but still validated for shape so a later enable cannot ship a bad value.
  return {
    deferThreshold: toPositiveInteger(
      value.deferThreshold ?? DEFAULT_BACKGROUND_WORK_WELFARE_CONFIG.deferThreshold,
      'backgroundWorkWelfare.deferThreshold',
      1,
    ),
    ageThresholdMs: toNonNegativeInteger(
      value.ageThresholdMs ?? DEFAULT_BACKGROUND_WORK_WELFARE_CONFIG.ageThresholdMs,
      'backgroundWorkWelfare.ageThresholdMs',
    ),
    reserveSlots,
  };
}
