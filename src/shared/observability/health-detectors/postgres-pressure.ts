// ── PostgreSQL connection-storm / resource-pressure detector (bead psfn-framework-7qeo1.24.2) ──
//
// `getPostgresPoolTelemetry()` already reports, per pool authority, how much of
// a bounded capacity is checked out and how many callers are queued waiting for
// a connection. Garden renders it; nothing turned it into an incident, so a
// connection storm persisted until an operator noticed companion behavior
// change.
//
// This detector is deliberately two-stage:
//
//   * A BOUNDED SAMPLER. Each cycle it reads live telemetry and, only for an
//     authority above its owner-file thresholds, writes one
//     `postgres_pool_pressure_sampled` observation. A healthy pool writes
//     nothing at all — the stream stays a record of pressure, not of traffic.
//   * A SUSTAIN TEST. The condition is asserted only once the window holds
//     `sustainedSamples` pressure observations for the SAME authority, counting
//     the one this cycle is about to write. A single spiky moment (a backup
//     opening its connections, one slow query) therefore never becomes an
//     incident; only pressure that survives across cycles does.
//
// Both stages read their history back out of the persisted stream rather than
// an in-memory counter, so a restart mid-storm neither forgets the storm nor
// restates it as a second incident.
//
// The pool identity in the stream is a digest of `process` and the authority's
// stable index — both content-free already, hashed anyway so the grouping key
// has one shape everywhere.

import {
  hashHealthEventSubject,
  type HealthEvent,
  type HealthEventOwner,
} from '../../contracts/health-event.js';
import type { PostgresPressureDetectorConfig } from '../../../system/config/scheduler-config/health-detectors.js';
import type {
  HealthDetector,
  HealthDetectorCondition,
  HealthDetectorInput,
  HealthDetectorResult,
  HealthDetectorSample,
} from './contracts.js';
import { sameHealthEventOwner } from './owner.js';

/**
 * Structural view of one pool authority's live telemetry. Declared here rather
 * than imported from the persistence adapter so this module never depends on
 * `pg`: the gateway and agent pass `getPostgresPoolTelemetry`, and a test
 * passes a literal.
 */
interface PostgresPoolAuthorityPressure {
  authorityIndex: number;
  capacity: number;
  active: number;
  waiting: number;
}

export interface PostgresPoolOwnerPressure {
  process: string;
  authorities: readonly PostgresPoolAuthorityPressure[];
}

export type PostgresPoolTelemetryReader = () => readonly PostgresPoolOwnerPressure[];

const POSTGRES_PRESSURE_DETECTOR_ID = 'postgres-pool-pressure';

/** Opaque grouping key for one pool authority inside one process. */
function poolSubjectHash(owner: PostgresPoolOwnerPressure, authorityIndex: number): string {
  return hashHealthEventSubject(`postgres_pool:${owner.process}:${String(authorityIndex)}`);
}

/**
 * Unit-to-percent conversion factor. Not a threshold: the operator-tunable
 * saturation threshold lives in `scheduler.json`, and this is only the scale the
 * ratio is reported in so `saturationPercent` evidence and that threshold are
 * expressed in the same unit.
 */
const RATIO_TO_PERCENT = 100;

/**
 * Percent of a bounded authority in use, rounded to a whole percent. A
 * zero-capacity authority reports zero rather than dividing by zero: it holds
 * no connections, so it cannot be under connection pressure.
 */
function saturationPercent(authority: PostgresPoolAuthorityPressure): number {
  if (authority.capacity <= 0) return 0;
  return Math.round((authority.active / authority.capacity) * RATIO_TO_PERCENT);
}

export function createPostgresPressureDetector(input: {
  telemetry: PostgresPoolTelemetryReader;
  config: PostgresPressureDetectorConfig;
}): HealthDetector {
  const { config } = input;

  function priorSampleCount(
    events: readonly HealthEvent[],
    subjectHash: string,
    owner: HealthEventOwner,
    nowMs: number,
  ): number {
    const floorMs = nowMs - config.windowMs;
    return events.filter(event => (
      event.code === 'postgres_pool_pressure_sampled'
      && event.provenance.subjectHash === subjectHash
      && event.recordedAtMs >= floorMs
      && sameHealthEventOwner(event.owner, owner)
    )).length;
  }

  return {
    id: POSTGRES_PRESSURE_DETECTOR_ID,
    family: 'postgres_pool_pressure',
    async detect(detectorInput: HealthDetectorInput): Promise<HealthDetectorResult> {
      const samples: HealthDetectorSample[] = [];
      const conditions: HealthDetectorCondition[] = [];

      for (const owner of input.telemetry()) {
        for (const authority of owner.authorities) {
          const saturation = saturationPercent(authority);
          const queued = config.minWaitingRequests > 0
            && authority.waiting >= config.minWaitingRequests;
          if (saturation < config.saturationPercent && !queued) continue;

          const subjectHash = poolSubjectHash(owner, authority.authorityIndex);
          const evidence = {
            poolCapacity: authority.capacity,
            activeConnections: authority.active,
            waitingRequests: authority.waiting,
            saturationPercent: saturation,
          };
          samples.push({
            code: 'postgres_pool_pressure_sampled',
            component: 'persistence',
            severity: 'warning',
            subjectHash,
            evidence,
          });

          // The sample written this cycle counts toward its own sustain test,
          // so `sustainedSamples: 1` means "fire on the first pressure sample"
          // and the seeded 3 means "three cycles of continuous pressure".
          const sampleCount = priorSampleCount(
            detectorInput.recentEvents,
            subjectHash,
            detectorInput.source.owner,
            detectorInput.nowMs,
          ) + 1;
          if (sampleCount < config.sustainedSamples) continue;
          conditions.push({
            subjectHash,
            component: 'persistence',
            severity: 'degraded',
            evidence: { ...evidence, sampleCount },
          });
        }
      }

      return { samples, conditions };
    },
  };
}
