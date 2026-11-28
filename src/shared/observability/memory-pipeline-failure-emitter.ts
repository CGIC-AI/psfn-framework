// ── Memory-pipeline failure health emitter (bead psfn-framework-d5e0p.3) ──
//
// The durable memory pipelines (episode synthesis per session, group-memory
// extraction per channel range) record each failure on their own durable
// record — the workset row or the group watermark — with the root-cause text an
// operator needs. None of that text may enter the health stream. This projects
// each recorded failure into content-free observations:
//
//   * `memory_pipeline_failed` per recorded failure, grouped by a digest of the
//     PIPELINE, so the background-failure detector opens one episode when a
//     pipeline keeps failing and closes it once the failures age out;
//   * `memory_pipeline_quarantined` when a unit exhausts its owner-file cap, a
//     standalone incident keyed by a digest of that unit, so every parked
//     session or channel range is visible as its own incident.
//
// Like every other health emitter, a failed emission is logged rather than
// rethrown: the pipeline already recorded its failure durably.

import type { EventBus } from '../event-bus.js';
import {
  emitHealthEvent,
  hashHealthEventSubject,
  processObserverId,
  stableHealthConditionCorrelationId,
  type HealthEventSource,
} from '../contracts/health-event.js';
import { createComponentLogger } from '../logger.js';
import { toErrorMessage } from '../utils/errors.js';

const log = createComponentLogger('MemoryPipelineFailureHealth');

export function subscribeMemoryPipelineFailureHealthEvents(deps: {
  eventBus: EventBus;
  source: HealthEventSource;
}): () => void {
  return deps.eventBus.on('memory.pipeline.failure', async (payload) => {
    const provenance = {
      process: deps.source.process,
      component: 'memory' as const,
      observerId: processObserverId(),
    };
    try {
      await emitHealthEvent(deps.eventBus, {
        owner: deps.source.owner,
        severity: 'warning',
        code: 'memory_pipeline_failed',
        provenance: {
          ...provenance,
          subjectHash: hashHealthEventSubject(`memory_pipeline:${payload.pipeline}`),
        },
        observedAtMs: payload.timestamp,
        evidence: { attemptCount: payload.attemptCount, terminal: payload.terminal },
      });
      if (!payload.terminal) return;
      const unitHash = hashHealthEventSubject(
        `memory_pipeline:${payload.pipeline}:${payload.subjectId}`,
      );
      await emitHealthEvent(deps.eventBus, {
        owner: deps.source.owner,
        severity: 'degraded',
        code: 'memory_pipeline_quarantined',
        correlationId: stableHealthConditionCorrelationId(
          'memory_pipeline_quarantined',
          deps.source.owner,
          unitHash,
        ),
        provenance: { ...provenance, subjectHash: unitHash },
        observedAtMs: payload.timestamp,
        evidence: { attemptCount: payload.attemptCount, terminal: true },
      });
    } catch (error) {
      log.error('Memory-pipeline failure health event emission failed', {
        pipeline: payload.pipeline,
        error: toErrorMessage(error),
      });
    }
  });
}
