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
import {
  MAX_HEALTH_EVENT_LIST_LIMIT,
} from '../../../shared/observability/health-event-stream.js';
import { assertNoUnknownKeys } from '../validators.js';
import {
  toBoolean,
  toInterval,
  toNonNegativeInteger,
  toPositiveInteger,
} from './primitives.js';

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

/** Repeated background-work / memory-refresh failure thresholds. */
export interface BackgroundFailureDetectorConfig {
  /**
   * Failures for one subject inside `windowMs` required before an incident
   * opens. At least two, so a single transient failure never fires.
   */
  failureThreshold: number;
  /**
   * Lookback the failure count is taken over. It is also the recovery rule: a
   * lane that stops failing for a full window has its episode closed.
   */
  windowMs: number;
}

/** Elapsed-time budgets past which a started job counts as stuck. */
export interface StuckJobDetectorConfig {
  /**
   * Budget for an automata run between the moment it started (or, for a run
   * still queued, was registered) and a terminal status.
   */
  automataRunBudgetMs: number;
  /** Budget for a scheduler task between entering its handler and leaving it. */
  schedulerTaskBudgetMs: number;
}

/**
 * Operator-alert delivery policy for detected incidents (bead
 * psfn-framework-7qeo1.24.5).
 *
 * Delivery is keyed on the incident's `correlationId`, never on an event: one
 * alert when an episode opens, and nothing further until the incident has been
 * open for `realertCooldownMs`. That is a different and deliberately longer
 * clock than the detector `cooldownMs`, which only bounds how often an open
 * episode re-states itself in the stream. An operator wants the stream to stay
 * current far more often than they want to be paged again.
 */
export interface IncidentAlertsConfig {
  /**
   * Minimum gap between two operator alerts for the SAME incident id. It must
   * be at least the detector cooldown: alerting more often than the episode
   * re-states itself is impossible, and configuring it would only look like a
   * promise the runtime cannot keep.
   */
  realertCooldownMs: number;
  /**
   * Deliver one notice when an incident closes. Off by default is not offered:
   * the choice is the operator's, but an incident that was alerted and never
   * resolved in the operator's mailbox is the failure mode this exists to
   * avoid.
   */
  closeNotice: boolean;
  /**
   * Stream rows the read-only investigator may read for one incident bundle.
   * It bounds the timeline attached to an alert and the evidence Garden shows
   * for the same incident.
   */
  bundleEventLimit: number;
  /**
   * Incidents the in-process alert ledger remembers before pruning the oldest.
   * The ledger only accelerates the common case — the durable dedup anchor is
   * the persisted stream itself — so a pruned entry costs a stream read, never
   * a duplicate alert.
   */
  ledgerCapacity: number;
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
  backgroundFailures: BackgroundFailureDetectorConfig;
  stuckJobs: StuckJobDetectorConfig;
  incidentAlerts: IncidentAlertsConfig;
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
  backgroundFailures: {
    failureThreshold: 3,
    windowMs: 3_600_000,
  },
  stuckJobs: {
    automataRunBudgetMs: 3_600_000,
    schedulerTaskBudgetMs: 1_800_000,
  },
  incidentAlerts: {
    realertCooldownMs: 3_600_000,
    closeNotice: true,
    bundleEventLimit: 50,
    ledgerCapacity: 256,
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
      'backgroundFailures',
      'stuckJobs',
      'incidentAlerts',
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
  const backgroundFailuresRaw = requireObject(
    root.backgroundFailures,
    sourcePath,
    'healthDetectors.backgroundFailures',
  );
  assertNoUnknownKeys(
    backgroundFailuresRaw,
    ['failureThreshold', 'windowMs'],
    `${sourcePath}.healthDetectors.backgroundFailures`,
    { errorPrefix: 'Invalid scheduler config' },
  );
  const incidentAlertsRaw = requireObject(
    root.incidentAlerts,
    sourcePath,
    'healthDetectors.incidentAlerts',
  );
  assertNoUnknownKeys(
    incidentAlertsRaw,
    ['realertCooldownMs', 'closeNotice', 'bundleEventLimit', 'ledgerCapacity'],
    `${sourcePath}.healthDetectors.incidentAlerts`,
    { errorPrefix: 'Invalid scheduler config' },
  );
  const stuckJobsRaw = requireObject(root.stuckJobs, sourcePath, 'healthDetectors.stuckJobs');
  assertNoUnknownKeys(
    stuckJobsRaw,
    ['automataRunBudgetMs', 'schedulerTaskBudgetMs'],
    `${sourcePath}.healthDetectors.stuckJobs`,
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
    backgroundFailures: {
      // Minimum two: a threshold of one would fire on a single transient
      // failure, which is exactly what this detector exists not to do.
      failureThreshold: toPositiveInteger(
        backgroundFailuresRaw.failureThreshold,
        'healthDetectors.backgroundFailures.failureThreshold',
        2,
      ),
      windowMs: toInterval(
        backgroundFailuresRaw.windowMs,
        'healthDetectors.backgroundFailures.windowMs',
      ),
    },
    stuckJobs: {
      automataRunBudgetMs: toInterval(
        stuckJobsRaw.automataRunBudgetMs,
        'healthDetectors.stuckJobs.automataRunBudgetMs',
      ),
      schedulerTaskBudgetMs: toInterval(
        stuckJobsRaw.schedulerTaskBudgetMs,
        'healthDetectors.stuckJobs.schedulerTaskBudgetMs',
      ),
    },
    incidentAlerts: {
      realertCooldownMs: toInterval(
        incidentAlertsRaw.realertCooldownMs,
        'healthDetectors.incidentAlerts.realertCooldownMs',
      ),
      closeNotice: toBoolean(
        incidentAlertsRaw.closeNotice,
        'healthDetectors.incidentAlerts.closeNotice',
      ),
      bundleEventLimit: toPositiveInteger(
        incidentAlertsRaw.bundleEventLimit,
        'healthDetectors.incidentAlerts.bundleEventLimit',
        1,
      ),
      ledgerCapacity: toPositiveInteger(
        incidentAlertsRaw.ledgerCapacity,
        'healthDetectors.incidentAlerts.ledgerCapacity',
        1,
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

  if (config.backgroundFailures.windowMs > config.incidentWindowMs) {
    throw new Error(
      `Invalid scheduler config at ${sourcePath}: healthDetectors.backgroundFailures.windowMs `
      + `(${config.backgroundFailures.windowMs}) must not exceed healthDetectors.incidentWindowMs `
      + `(${config.incidentWindowMs}); the failure count is taken over the ledger's scanned `
      + 'window, so a longer failure window would silently count only part of itself',
    );
  }

  if (config.incidentAlerts.realertCooldownMs < config.cooldownMs) {
    throw new Error(
      `Invalid scheduler config at ${sourcePath}: `
      + `healthDetectors.incidentAlerts.realertCooldownMs `
      + `(${config.incidentAlerts.realertCooldownMs}) must be at least `
      + `healthDetectors.cooldownMs (${config.cooldownMs}); an open incident only re-states `
      + 'itself in the stream at the detector cooldown, so a shorter alert cooldown promises '
      + 'a re-alert cadence the runtime can never deliver',
    );
  }
  if (config.incidentAlerts.bundleEventLimit > MAX_HEALTH_EVENT_LIST_LIMIT) {
    throw new Error(
      `Invalid scheduler config at ${sourcePath}: `
      + `healthDetectors.incidentAlerts.bundleEventLimit `
      + `(${config.incidentAlerts.bundleEventLimit}) must not exceed the health-event stream's `
      + `structural read ceiling (${MAX_HEALTH_EVENT_LIST_LIMIT}); a larger value would throw on `
      + 'every incident read instead of failing this owner file closed',
    );
  }

  return config;
}
