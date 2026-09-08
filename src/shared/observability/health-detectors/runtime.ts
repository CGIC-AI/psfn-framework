// ── Runtime health-detector composition (beads psfn-framework-7qeo1.24.2-.4) ──
//
// The one place a process turns its owner-file policy and its live runtime
// handles into a driveable detector cycle. Both entrypoints call this and then
// hand the result to `registerRuntimeHealthDetectorTask`, so neither has to
// know which detectors exist or how an incident is correlated.
//
// Every detector is optional in exactly the way the runtime is: a process that
// owns no PostgreSQL pool contributes no pool detector, and the cycle then
// never closes a pool episode it cannot evaluate.

import type { HealthEventSource, HealthEventPublisher } from '../../contracts/health-event.js';
import type { HealthDetectorsConfig } from '../../../system/config/scheduler-config/health-detectors.js';
import {
  createHealthDetectorCycle,
  type HealthDetectorCycle,
  type HealthDetectorStreamReader,
} from './cycle.js';
import type { HealthDetector } from './contracts.js';
import {
  createPostgresPressureDetector,
  type PostgresPoolTelemetryReader,
} from './postgres-pressure.js';

export interface RuntimeHealthDetectorOptions {
  stream: HealthDetectorStreamReader;
  publisher: HealthEventPublisher;
  source: HealthEventSource;
  config: HealthDetectorsConfig;
  /**
   * Live PostgreSQL pool telemetry for THIS process. Absent when the process
   * owns no pool authority.
   */
  postgresPoolTelemetry?: PostgresPoolTelemetryReader;
}

export function createRuntimeHealthDetectorCycle(
  options: RuntimeHealthDetectorOptions,
): HealthDetectorCycle {
  const detectors: HealthDetector[] = [];
  if (options.postgresPoolTelemetry) {
    detectors.push(createPostgresPressureDetector({
      telemetry: options.postgresPoolTelemetry,
      config: options.config.postgresPressure,
    }));
  }
  return createHealthDetectorCycle({
    detectors,
    stream: options.stream,
    publisher: options.publisher,
    source: options.source,
    policy: {
      incidentWindowMs: options.config.incidentWindowMs,
      cooldownMs: options.config.cooldownMs,
      incidentScanLimit: options.config.incidentScanLimit,
    },
  });
}
