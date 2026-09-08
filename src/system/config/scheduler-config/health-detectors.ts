// ── Runtime health-detector policy (beads psfn-framework-7qeo1.24.2-.4) ──
//
// Every threshold, window, budget and cooldown the detector cycle applies lives
// here and reaches it from `scheduler.json`. The detectors themselves own no
// tuning literal: they read this block, so an operator changes when a runtime
// declares an incident without a release.
//
// The block is validated as a whole because the values are not independent —
// a cooldown longer than the incident window would make a long incident look
// closed and reopen forever, and a pressure window shorter than the samples it
// must contain could never reach its own threshold. Those cross-checks fail the
// owner file closed at load rather than producing a detector that silently
// never fires.

import { isRecord } from '../../../shared/utils/types.js';
import { assertNoUnknownKeys } from '../validators.js';
import { toInterval, toNonNegativeInteger, toPositiveInteger } from './primitives.js';

/** Sustained PostgreSQL pool saturation / queueing thresholds. */
export interface PostgresPressureDetectorConfig {
  /**
   * Percent of a pool authority's capacity in use at or above which a sample
   * counts as pressure.
   */
  saturationPercent: number;
  /**
   * Requests queued for a connection at or above which a sample counts as
   * pressure regardless of saturation. Zero means queueing alone never counts.
   */
  minWaitingRequests: number;
  /** Pressure samples inside `windowMs` required before an incident opens. */
  sustainedSamples: number;
  /** Lookback the sustained-sample count is taken over. */
  windowMs: number;
}

export interface HealthDetectorsConfig {
  /** Cadence of the single scheduler task that runs every detector. */
  intervalMs: number;
  /**
   * Lookback used to rebuild open incident episodes from the persisted stream.
   * An episode survives a process restart only while one of its events is still
   * inside this window, which is why `cooldownMs` must be shorter.
   */
  incidentWindowMs: number;
  /**
   * Minimum gap between two persisted events of the same open episode. It
   * bounds how fast a persistent fault can write to the stream and, because it
   * is shorter than `incidentWindowMs`, keeps a long episode continuously
   * visible to the ledger.
   */
  cooldownMs: number;
  /** Rows read from the stream per cycle when rebuilding the ledger. */
  incidentScanLimit: number;
  postgresPressure: PostgresPressureDetectorConfig;
}

export const DEFAULT_HEALTH_DETECTORS_CONFIG: HealthDetectorsConfig = {
  intervalMs: 60_000,
  incidentWindowMs: 21_600_000,
  cooldownMs: 900_000,
  incidentScanLimit: 500,
  postgresPressure: {
    saturationPercent: 90,
    minWaitingRequests: 1,
    sustainedSamples: 3,
    windowMs: 600_000,
  },
};

function toPercent(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 100) {
    throw new Error(`Invalid scheduler config: ${field} must be a number in (0, 100]`);
  }
  return value;
}

function requireObject(raw: unknown, sourcePath: string, field: string): Record<string, unknown> {
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: ${field} must be an object`);
  }
  return raw;
}

export function validateHealthDetectorsConfig(
  raw: unknown,
  sourcePath: string,
): HealthDetectorsConfig {
  const root = requireObject(raw, sourcePath, 'healthDetectors');
  assertNoUnknownKeys(
    root,
    [
      'intervalMs',
      'incidentWindowMs',
      'cooldownMs',
      'incidentScanLimit',
      'postgresPressure',
    ],
    `${sourcePath}.healthDetectors`,
    { errorPrefix: 'Invalid scheduler config' },
  );

  const postgresPressureRaw = requireObject(
    root.postgresPressure,
    sourcePath,
    'healthDetectors.postgresPressure',
  );
  assertNoUnknownKeys(
    postgresPressureRaw,
    ['saturationPercent', 'minWaitingRequests', 'sustainedSamples', 'windowMs'],
    `${sourcePath}.healthDetectors.postgresPressure`,
    { errorPrefix: 'Invalid scheduler config' },
  );

  const config: HealthDetectorsConfig = {
    intervalMs: toInterval(root.intervalMs, 'healthDetectors.intervalMs'),
    incidentWindowMs: toInterval(root.incidentWindowMs, 'healthDetectors.incidentWindowMs'),
    cooldownMs: toInterval(root.cooldownMs, 'healthDetectors.cooldownMs'),
    incidentScanLimit: toPositiveInteger(
      root.incidentScanLimit,
      'healthDetectors.incidentScanLimit',
      1,
    ),
    postgresPressure: {
      saturationPercent: toPercent(
        postgresPressureRaw.saturationPercent,
        'healthDetectors.postgresPressure.saturationPercent',
      ),
      minWaitingRequests: toNonNegativeInteger(
        postgresPressureRaw.minWaitingRequests,
        'healthDetectors.postgresPressure.minWaitingRequests',
      ),
      sustainedSamples: toPositiveInteger(
        postgresPressureRaw.sustainedSamples,
        'healthDetectors.postgresPressure.sustainedSamples',
        1,
      ),
      windowMs: toInterval(
        postgresPressureRaw.windowMs,
        'healthDetectors.postgresPressure.windowMs',
      ),
    },
  };

  if (config.cooldownMs >= config.incidentWindowMs) {
    throw new Error(
      `Invalid scheduler config at ${sourcePath}: healthDetectors.cooldownMs `
      + `(${config.cooldownMs}) must be shorter than healthDetectors.incidentWindowMs `
      + `(${config.incidentWindowMs}); otherwise an open episode ages out of the ledger `
      + 'before its next event is written and every cycle reopens it as a new incident',
    );
  }
  const requiredPressureWindowMs = config.postgresPressure.sustainedSamples * config.intervalMs;
  if (config.postgresPressure.windowMs < requiredPressureWindowMs) {
    throw new Error(
      `Invalid scheduler config at ${sourcePath}: healthDetectors.postgresPressure.windowMs `
      + `(${config.postgresPressure.windowMs}) must be at least sustainedSamples x intervalMs `
      + `(${requiredPressureWindowMs}); otherwise the window can never hold enough samples `
      + 'to reach its own threshold and the detector never fires',
    );
  }

  return config;
}
