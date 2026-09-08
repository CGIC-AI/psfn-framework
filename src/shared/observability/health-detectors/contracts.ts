// ── Health-detector ports (beads psfn-framework-7qeo1.24.2-.4) ──
//
// A detector answers exactly one question — "is this condition true right
// now?" — and knows nothing about correlation ids, cooldowns, deduplication,
// or the bus. The cycle that drives it owns all of that, which is why three
// very different detectors (pool pressure, repeated failures, stuck jobs) share
// one episode implementation instead of each reinventing incident bookkeeping.
//
// The split is deliberate:
//
//   * `samples` are content-free OBSERVATIONS a detector wants durably recorded
//     this cycle. They are what makes "sustained" measurable across process
//     restarts: the detector reads its own prior samples back out of the stream
//     rather than holding a counter in memory that a restart would erase.
//   * `conditions` are the conditions the detector asserts are true AT THIS
//     INSTANT. A detector never says "open an incident" or "close an incident";
//     it reports what is true, and the cycle diffs that against the episodes
//     already open in the persisted stream.
//
// That diff is the whole reason a healthy runtime emits nothing: no sample, no
// condition, no event.

import type {
  HealthEvent,
  HealthEventComponent,
  HealthEventCode,
  HealthEventEvidence,
  HealthEventSeverity,
  HealthEventSource,
  HealthIncidentFamily,
} from '../../contracts/health-event.js';

/**
 * One durable observation. `subjectHash` is the opaque grouping key from
 * {@link hashHealthEventSubject}: the same subject across cycles is the same
 * group, and the stream never learns the identifier behind it.
 */
export interface HealthDetectorSample {
  code: HealthEventCode;
  component: HealthEventComponent;
  severity: HealthEventSeverity;
  subjectHash: string;
  evidence: HealthEventEvidence;
}

/**
 * One condition currently true. The cycle turns the FIRST appearance of a
 * subject into an incident-open event, subsequent appearances into
 * occurrence updates on the same `correlationId`, and its disappearance into
 * exactly one incident-close event.
 *
 * `causationId` names the observation event that justifies the condition, so an
 * operator reading the stream can walk from the incident back to the evidence.
 * Left absent, the cycle attributes the sample it wrote for the same subject
 * this cycle.
 */
export interface HealthDetectorCondition {
  subjectHash: string;
  component: HealthEventComponent;
  severity: HealthEventSeverity;
  evidence: HealthEventEvidence;
  causationId?: string;
  /**
   * When the condition began, if the detector knows it (a run's start time, the
   * first failure in the window). The cycle uses it as the episode's
   * `firstObservedAtMs` when it opens the incident.
   */
  startedAtMs?: number;
}

export interface HealthDetectorInput {
  nowMs: number;
  /** Whose runtime and which process this cycle speaks for. */
  source: HealthEventSource;
  /**
   * Newest-first window of the persisted stream, already bounded by the
   * owner-file incident window and scan limit. A detector reads its own prior
   * samples and failure observations from here; it never queries the store.
   */
  recentEvents: readonly HealthEvent[];
}

export interface HealthDetectorResult {
  samples: readonly HealthDetectorSample[];
  conditions: readonly HealthDetectorCondition[];
}

/**
 * One detector owns one incident family. The cycle only closes episodes of a
 * family whose detector ran successfully, so a detector that throws never
 * silently resolves an incident it failed to evaluate.
 */
export interface HealthDetector {
  readonly id: string;
  readonly family: HealthIncidentFamily;
  detect(input: HealthDetectorInput): Promise<HealthDetectorResult>;
}
