// ── Read-only incident investigator (bead psfn-framework-7qeo1.24.5) ──
//
// After a detector opens an incident, something has to look at it before an
// operator is paged. That "something" is deliberately the weakest worker in the
// runtime: it holds no shell, filesystem, network, process, or mutation
// authority, and it is not a model call. Its entire world is one injected
// function that returns a bounded window of the persisted health stream.
//
// The capability claim is structural, not documentary. The investigator is
// constructed with a single `readStream` FUNCTION rather than a store, a bus,
// or a config loader, so there is no object on which a mutating method could be
// reached — not by a future edit, not by a mistake. {@link
// INCIDENT_INVESTIGATOR_BOUNDARY} states the same fact in the runtime's
// existing denied-capability vocabulary so a test can assert it.
//
// What it produces is a content-free bundle: the incident projection (shared
// verbatim with the Garden timeline), the owner-file thresholds that were in
// force, and nothing else. No log text, no error strings, no private
// identifiers — the envelope makes those unrepresentable, and this module adds
// no new string field of its own.

import type {
  HealthEvent,
  HealthIncidentFamily,
} from '../../contracts/health-event.js';
import type { HealthDetectorsConfig } from '../../../system/config/scheduler-config/health-detectors.js';
import type { HealthEventQuery } from '../health-event-stream.js';
import { summarizeIncident } from './incident-view.js';
import {
  classifyIncidentStatement,
  type IncidentBundle,
  type IncidentInvestigatorBoundary,
  type IncidentThresholdSnapshot,
} from './contracts.js';

/**
 * Every capability in the runtime's sandbox vocabulary, denied. The
 * investigator is not sandboxed by a broker — it simply never receives any of
 * these authorities, which is the stronger statement: there is nothing to
 * escape from because there is nothing to hold.
 */
export const INCIDENT_INVESTIGATOR_BOUNDARY: IncidentInvestigatorBoundary = Object.freeze({
  kind: 'read_only_investigator',
  deniedCapabilities: Object.freeze([
    'filesystem',
    'network',
    'process',
    'module_import',
    'global_escape',
    'child_process',
    'environment',
  ] as const),
  mutationAuthority: false,
  reason:
    'Assembles a bounded content-free incident bundle from one injected health-stream read '
    + 'function. It holds no store, bus, config loader, or delivery handle, so it cannot '
    + 'mutate runtime state.',
});

/**
 * The investigator's ONLY authority: a bounded read of the persisted health
 * stream. Narrower than {@link HealthEventStorePort} on purpose — `record` and
 * `close` are not merely unused here, they are unreachable.
 */
export type IncidentStreamRead = (query: HealthEventQuery) => Promise<HealthEvent[]>;

export interface IncidentInvestigatorOptions {
  readStream: IncidentStreamRead;
  /**
   * Owner-file policy, read once per investigation through this accessor so a
   * bundle always reports the thresholds actually in force rather than the ones
   * captured at wiring time.
   */
  config: () => HealthDetectorsConfig;
  now?: () => number;
}

export interface IncidentInvestigator {
  readonly boundary: IncidentInvestigatorBoundary;
  /**
   * Assemble the bundle for the incident the given statement belongs to.
   * Returns null when the event is not an incident statement at all, which is
   * how ordinary evidence stays out of the alert path.
   */
  investigate(event: HealthEvent): Promise<IncidentBundle | null>;
}

const DETECTOR_THRESHOLD_PATHS: Readonly<Record<HealthIncidentFamily, string>> = {
  postgres_pool_pressure: 'healthDetectors.postgresPressure',
  background_work_failures: 'healthDetectors.backgroundFailures',
  stuck_runtime_job: 'healthDetectors.stuckJobs',
};

function detectorThresholds(
  config: HealthDetectorsConfig,
  family: HealthIncidentFamily | null,
): { path: string; detector: Readonly<Record<string, number | boolean>> } {
  if (family === null) {
    // A standalone incident has no detector block; the cycle policy below is
    // the whole of the owner-file context that applies to it.
    return { path: 'healthDetectors', detector: {} };
  }
  const detector = family === 'postgres_pool_pressure'
    ? { ...config.postgresPressure }
    : family === 'background_work_failures'
      ? { ...config.backgroundFailures }
      : { ...config.stuckJobs };
  return { path: DETECTOR_THRESHOLD_PATHS[family], detector };
}

function thresholdSnapshot(
  config: HealthDetectorsConfig,
  family: HealthIncidentFamily | null,
): IncidentThresholdSnapshot {
  const { path, detector } = detectorThresholds(config, family);
  return Object.freeze({
    ownerFile: 'scheduler.json' as const,
    path,
    detector: Object.freeze(detector),
    cycle: Object.freeze({
      intervalMs: config.intervalMs,
      incidentWindowMs: config.incidentWindowMs,
      cooldownMs: config.cooldownMs,
      incidentScanLimit: config.incidentScanLimit,
    }),
    alerts: Object.freeze({ ...config.incidentAlerts }),
  });
}

/**
 * Merge the triggering event into the rows read back from the stream.
 *
 * `EventBus.emit` runs its subscribers concurrently, so the persisting sink may
 * not have committed the very row that woke the alert path. Relying on the
 * read-back alone would intermittently lose the newest statement of an
 * incident; splicing it in by `eventId` makes the bundle correct whichever
 * subscriber finishes first, and idempotent if both do.
 */
function mergeTrigger(rows: readonly HealthEvent[], trigger: HealthEvent): HealthEvent[] {
  return rows.some(row => row.eventId === trigger.eventId) ? [...rows] : [...rows, trigger];
}

export function createIncidentInvestigator(
  options: IncidentInvestigatorOptions,
): IncidentInvestigator {
  const now = options.now ?? (() => Date.now());
  return {
    boundary: INCIDENT_INVESTIGATOR_BOUNDARY,
    async investigate(event: HealthEvent): Promise<IncidentBundle | null> {
      const statement = classifyIncidentStatement(event);
      if (!statement) return null;
      const config = options.config();
      const rows = await options.readStream({
        correlationId: event.correlationId,
        limit: config.incidentAlerts.bundleEventLimit,
      });
      const incident = summarizeIncident(mergeTrigger(rows, event), {
        timelineLimit: config.incidentAlerts.bundleEventLimit,
        // Tenancy fence: an incident bundle quotes only rows owned by the same
        // companion (or the system) as the statement that opened it, so a fleet
        // alert can never carry another companion's evidence.
        owner: event.owner,
      });
      if (!incident) return null;
      return Object.freeze({
        boundary: INCIDENT_INVESTIGATOR_BOUNDARY,
        incident,
        thresholds: thresholdSnapshot(config, incident.family),
        assembledAtMs: now(),
      });
    },
  };
}
