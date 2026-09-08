// ── Health-detector cycle (beads psfn-framework-7qeo1.24.2-.4) ──
//
// The single runtime every detector is driven by. One pass:
//
//   1. read a bounded newest-first window of the persisted health stream,
//   2. rebuild which incidents are open from that window (the ledger),
//   3. ask every detector what is true right now,
//   4. emit the difference — and nothing else.
//
// Step 4 is the whole contract:
//
//   * a condition with no open episode        → ONE incident-open event with a
//                                               fresh correlationId,
//   * a condition whose episode is open       → an occurrence update on the SAME
//                                               correlationId, but only once the
//                                               owner-file cooldown has elapsed,
//   * an open episode with no matching        → ONE incident-close event on that
//     condition                                 correlationId,
//   * a healthy runtime                       → nothing at all.
//
// Every event leaves through the same `runtime.health.event` bus seam the
// existing emitters use, so the persisting sink, the Garden timeline (child .6)
// and alert delivery (child .5) need no second path.

import {
  createHealthEvent,
  healthIncidentCodes,
  processObserverId,
  type HealthEvent,
  type HealthEventInput,
  type HealthEventPublisher,
  type HealthEventSource,
  type HealthIncidentFamily,
} from '../../contracts/health-event.js';
import type { HealthEventQuery } from '../health-event-stream.js';
import { createComponentLogger } from '../../logger.js';
import { buildIncidentLedger, incidentEpisodeKey } from './incident-ledger.js';
import { sameHealthEventOwner } from './owner.js';
import type { HealthDetector, HealthDetectorResult } from './contracts.js';

const log = createComponentLogger('HealthDetectors');

/** Read seam over the persisted stream. Narrower than the full store port. */
export interface HealthDetectorStreamReader {
  listRecent(query?: HealthEventQuery): Promise<HealthEvent[]>;
}

/** Owner-file policy the cycle itself applies, independent of any detector. */
interface HealthDetectorCyclePolicy {
  incidentWindowMs: number;
  cooldownMs: number;
  incidentScanLimit: number;
}

export interface HealthDetectorCycleOptions {
  detectors: readonly HealthDetector[];
  stream: HealthDetectorStreamReader;
  publisher: HealthEventPublisher;
  source: HealthEventSource;
  policy: HealthDetectorCyclePolicy;
  /** Injectable clock; the runtime passes none and gets `Date.now`. */
  now?: () => number;
}

export interface HealthDetectorCycle {
  run(): Promise<void>;
}

export function createHealthDetectorCycle(
  options: HealthDetectorCycleOptions,
): HealthDetectorCycle {
  const now = options.now ?? (() => Date.now());
  const duplicateFamilies = options.detectors
    .map(detector => detector.family)
    .filter((family, index, families) => families.indexOf(family) !== index);
  if (duplicateFamilies.length > 0) {
    // Two detectors owning one family would fight over the same episodes, each
    // closing what the other opened. Refuse the composition rather than emit an
    // incident that flaps forever.
    throw new Error(
      `Health detector cycle has more than one detector for family: ${
        [...new Set(duplicateFamilies)].sort().join(', ')
      }`,
    );
  }

  async function publish(input: HealthEventInput): Promise<void> {
    await options.publisher.emit('runtime.health.event', { event: createHealthEvent(input) });
  }

  return {
    async run(): Promise<void> {
      const nowMs = now();
      const recentEvents = await options.stream.listRecent({
        limit: options.policy.incidentScanLimit,
        sinceMs: Math.max(0, nowMs - options.policy.incidentWindowMs),
      });
      const ledger = buildIncidentLedger(recentEvents);

      const failures: Error[] = [];
      const results = new Map<HealthIncidentFamily, HealthDetectorResult>();
      for (const detector of options.detectors) {
        try {
          results.set(detector.family, await detector.detect({
            nowMs,
            source: options.source,
            recentEvents,
          }));
        } catch (error) {
          // Collected, never swallowed: one broken detector must not stop the
          // others, and the cycle still fails loudly at the end.
          failures.push(error instanceof Error
            ? error
            : new Error(`Health detector "${detector.id}" failed: ${String(error)}`));
        }
      }

      const observedKeys = new Set<string>();
      for (const [family, result] of results) {
        // Samples first: an incident opened this cycle cites the very sample
        // that justified it, so the causal chain is complete in the stream.
        const sampleEventIds = new Map<string, string>();
        for (const sample of result.samples) {
          const event = createHealthEvent({
            owner: options.source.owner,
            severity: sample.severity,
            code: sample.code,
            provenance: {
              process: options.source.process,
              component: sample.component,
              observerId: processObserverId(),
              subjectHash: sample.subjectHash,
            },
            observedAtMs: nowMs,
            evidence: sample.evidence,
          });
          sampleEventIds.set(sample.subjectHash, event.eventId);
          await options.publisher.emit('runtime.health.event', { event });
        }

        const codes = healthIncidentCodes(family);
        for (const condition of result.conditions) {
          const key = incidentEpisodeKey(family, options.source.owner, condition.subjectHash);
          observedKeys.add(key);
          const episode = ledger.get(key);
          const causationId = condition.causationId ?? sampleEventIds.get(condition.subjectHash);
          if (!episode) {
            await publish({
              owner: options.source.owner,
              severity: condition.severity,
              code: codes.opened,
              provenance: {
                process: options.source.process,
                component: condition.component,
                observerId: processObserverId(),
                subjectHash: condition.subjectHash,
              },
              observedAtMs: Math.min(condition.startedAtMs ?? nowMs, nowMs),
              lastObservedAtMs: nowMs,
              evidence: condition.evidence,
              ...(causationId === undefined ? {} : { causationId }),
            });
            continue;
          }
          if (nowMs - episode.lastRecordedAtMs < options.policy.cooldownMs) {
            // Still the same incident, already stated recently enough. This is
            // the deduplication the acceptance criteria ask for: a storm that
            // persists for hours is one incident, not one row per cycle.
            continue;
          }
          await publish({
            owner: options.source.owner,
            severity: condition.severity,
            code: codes.opened,
            provenance: {
              process: options.source.process,
              component: condition.component,
              observerId: processObserverId(),
              subjectHash: condition.subjectHash,
            },
            correlationId: episode.correlationId,
            causationId: episode.lastEventId,
            occurrenceCount: episode.occurrenceCount + 1,
            observedAtMs: episode.firstObservedAtMs,
            lastObservedAtMs: nowMs,
            evidence: { ...condition.evidence, durationMs: nowMs - episode.firstObservedAtMs },
          });
        }
      }

      for (const [key, episode] of ledger) {
        // Only close what this cycle actually evaluated: an unowned family, a
        // detector that threw, or another tenant's episode all stay open.
        if (!results.has(episode.family)) continue;
        if (!sameHealthEventOwner(episode.owner, options.source.owner)) continue;
        if (observedKeys.has(key)) continue;
        await publish({
          owner: options.source.owner,
          severity: 'info',
          code: healthIncidentCodes(episode.family).closed,
          provenance: {
            process: options.source.process,
            component: episode.component,
            observerId: processObserverId(),
            subjectHash: episode.subjectHash,
          },
          correlationId: episode.correlationId,
          causationId: episode.lastEventId,
          occurrenceCount: episode.occurrenceCount + 1,
          observedAtMs: episode.firstObservedAtMs,
          lastObservedAtMs: nowMs,
          evidence: { durationMs: nowMs - episode.firstObservedAtMs, terminal: true },
        });
      }

      log.debug('Runtime health detector cycle completed', {
        detectors: options.detectors.length,
        evaluated: results.size,
        openEpisodes: ledger.size,
        conditions: [...results.values()].reduce((sum, result) => sum + result.conditions.length, 0),
      });
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `${failures.length} of ${options.detectors.length} runtime health detectors failed`,
        );
      }
    },
  };
}
