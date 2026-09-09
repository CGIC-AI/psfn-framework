// ── Repeated background-work / memory-refresh failure detector (bead psfn-framework-7qeo1.24.3) ──
//
// The runtime already reports single failures: `BackgroundWorkSupervisor`
// emits `background_work_job_failed` for a job that reached its terminal failed
// state, the refresh emitter beside this module projects a failed memory/wiki
// context refresh into `memory_refresh_failed`, and the turn support runtime
// projects a lost custody snapshot into `custody_snapshot_write_failed`, the
// intake escalation port projects a screener provider that refused the
// request parameters into `intake_screener_provider_rejected_request`, and the
// automata terminal lifecycle projects a replay that disagreed with the durable
// Bus finding into `terminal_handoff_replay_diverged`. All five are grouped by
// `provenance.subjectHash` — a digest of the JOB KIND, of the REFRESH LANE, of
// the custody FAILURE MODE, of the SCREENER TIER AND MODEL, and of the HANDOFF
// KIND respectively, never of an individual job, channel, turn, envelope, or
// run — precisely so that repeats of the same thing land in the same group.
//
// What was missing is the judgment: a lane failing once is noise, and a lane
// failing over and over is an incident. This detector is that judgment and
// nothing else. It holds no counters; it counts the failure observations
// already in the persisted stream inside the owner-file window.
//
// That makes both required behaviors fall out of one rule:
//
//   * a single transient failure never fires — one observation cannot reach a
//     threshold the owner file forces to be at least two;
//   * recovery closes the episode — once a lane stops failing, its observations
//     age out of the window, the condition stops being true, and the cycle
//     emits exactly one close.
//
// `scheduler_task_failed` is deliberately NOT counted. The detector cycle is
// itself a scheduler task, so counting scheduler failures would let a broken
// detector feed its own incident.

import type { HealthEvent, HealthEventCode, HealthEventComponent } from '../../contracts/health-event.js';
import type { BackgroundFailureDetectorConfig } from '../../../system/config/scheduler-config/health-detectors.js';
import type {
  HealthDetector,
  HealthDetectorCondition,
  HealthDetectorInput,
  HealthDetectorResult,
} from './contracts.js';
import { sameHealthEventOwner } from './owner.js';

/** The failure observations this detector counts. */
const COUNTED_FAILURE_CODES: readonly HealthEventCode[] = [
  'background_work_job_failed',
  'memory_refresh_failed',
  'custody_snapshot_write_failed',
  // psfn-framework-mlhn3: a screener provider that refuses the request
  // parameters refuses EVERY envelope, so the observations accumulate on one
  // subject digest (screener tier + model) and cross this detector's threshold
  // as a single standing incident rather than a stream of per-envelope noise.
  'intake_screener_provider_rejected_request',
  // psfn-framework-zu8d2: grouped by a digest of the handoff KIND, so a settle
  // path that keeps diverging on replay becomes one episode.
  'terminal_handoff_replay_diverged',
];

interface FailureGroup {
  component: HealthEventComponent;
  count: number;
  firstObservedAtMs: number;
  newestEventId: string;
  newestRecordedAtMs: number;
}

export function createBackgroundFailureDetector(input: {
  config: BackgroundFailureDetectorConfig;
}): HealthDetector {
  return {
    id: 'background-work-failures',
    family: 'background_work_failures',
    async detect(detectorInput: HealthDetectorInput): Promise<HealthDetectorResult> {
      const floorMs = detectorInput.nowMs - input.config.windowMs;
      const groups = new Map<string, FailureGroup>();

      for (const event of detectorInput.recentEvents) {
        if (!COUNTED_FAILURE_CODES.includes(event.code)) continue;
        if (event.recordedAtMs < floorMs) continue;
        if (!sameHealthEventOwner(event.owner, detectorInput.source.owner)) continue;
        const subjectHash = event.provenance.subjectHash;
        if (subjectHash === undefined) continue;
        groups.set(subjectHash, mergeFailure(groups.get(subjectHash), event));
      }

      const conditions: HealthDetectorCondition[] = [];
      for (const [subjectHash, group] of groups) {
        if (group.count < input.config.failureThreshold) continue;
        conditions.push({
          subjectHash,
          component: group.component,
          severity: 'degraded',
          startedAtMs: group.firstObservedAtMs,
          causationId: group.newestEventId,
          evidence: {
            failureCount: group.count,
            windowMs: input.config.windowMs,
          },
        });
      }

      // No samples: the failure observations this detector counts are written by
      // the runtime that actually failed, not by the detector.
      return { samples: [], conditions };
    },
  };
}

function mergeFailure(existing: FailureGroup | undefined, event: HealthEvent): FailureGroup {
  if (!existing) {
    return {
      component: event.provenance.component,
      // An emitter may coalesce a burst into one row; honour its count so a
      // coalesced burst is not undercounted into invisibility.
      count: event.occurrenceCount,
      firstObservedAtMs: event.firstObservedAtMs,
      newestEventId: event.eventId,
      newestRecordedAtMs: event.recordedAtMs,
    };
  }
  const newest = event.recordedAtMs > existing.newestRecordedAtMs;
  return {
    component: existing.component,
    count: existing.count + event.occurrenceCount,
    firstObservedAtMs: Math.min(existing.firstObservedAtMs, event.firstObservedAtMs),
    newestEventId: newest ? event.eventId : existing.newestEventId,
    newestRecordedAtMs: newest ? event.recordedAtMs : existing.newestRecordedAtMs,
  };
}
