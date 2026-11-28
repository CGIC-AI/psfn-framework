import { describe, expect, it } from 'vitest';
import { EventBus } from '../event-bus.js';
import {
  hashHealthEventSubject,
  validateHealthEvent,
  type HealthEvent,
  type HealthEventSource,
} from '../contracts/health-event.js';
import { DEFAULT_HEALTH_DETECTORS_CONFIG } from '../../system/config/scheduler-config/health-detectors.js';
import { createHealthDetectorCycle } from './health-detectors/cycle.js';
import { createBackgroundFailureDetector } from './health-detectors/background-failures.js';
import { classifyIncidentStatement } from './incident-alerts/contracts.js';
import { subscribeMemoryPipelineFailureHealthEvents } from './memory-pipeline-failure-emitter.js';

const NOW_MS = 1_800_000_000_000;
const MINUTE_MS = 60_000;
const SOURCE: HealthEventSource = { owner: { kind: 'system' }, process: 'agent' };

describe('memory-pipeline failure health emitter', () => {
  it('turns repeated recorded failures into one detector incident and a quarantine into a standalone incident', async () => {
    const eventBus = new EventBus();
    const stream: HealthEvent[] = [];
    eventBus.on('runtime.health.event', (data) => {
      stream.push(validateHealthEvent(data.event));
    });
    const detach = subscribeMemoryPipelineFailureHealthEvents({ eventBus, source: SOURCE });

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await eventBus.emit('memory.pipeline.failure', {
        pipeline: 'episode_synthesis',
        subjectId: 'discord:private-room-123',
        attemptCount: attempt,
        maxAttempts: 3,
        terminal: attempt === 3,
        timestamp: NOW_MS + attempt * MINUTE_MS,
      });
    }
    detach();

    const failed = stream.filter(event => event.code === 'memory_pipeline_failed');
    expect(failed).toHaveLength(3);
    expect(new Set(failed.map(event => event.provenance.subjectHash)))
      .toEqual(new Set([hashHealthEventSubject('memory_pipeline:episode_synthesis')]));
    expect(failed.map(event => event.evidence)).toEqual([
      { attemptCount: 1, terminal: false },
      { attemptCount: 2, terminal: false },
      { attemptCount: 3, terminal: true },
    ]);
    const quarantined = stream.filter(event => event.code === 'memory_pipeline_quarantined');
    expect(quarantined).toHaveLength(1);
    expect(classifyIncidentStatement(quarantined[0]!)).toMatchObject({ phase: 'opened', family: null });
    // Content-free: the private session id never reaches the stream.
    expect(JSON.stringify(stream)).not.toContain('private-room');

    // The existing repeated-failure detector counts the pipeline's failures.
    const cycle = createHealthDetectorCycle({
      detectors: [createBackgroundFailureDetector({
        config: DEFAULT_HEALTH_DETECTORS_CONFIG.backgroundFailures,
      })],
      stream: {
        async listRecent(query = {}) {
          return stream
            .filter(event => event.recordedAtMs >= (query.sinceMs ?? 0))
            .sort((left, right) => right.recordedAtMs - left.recordedAtMs);
        },
      },
      publisher: {
        async emit(_name, data) {
          stream.push(validateHealthEvent(data.event));
        },
      },
      source: SOURCE,
      policy: {
        incidentWindowMs: DEFAULT_HEALTH_DETECTORS_CONFIG.incidentWindowMs,
        cooldownMs: DEFAULT_HEALTH_DETECTORS_CONFIG.cooldownMs,
        incidentScanLimit: DEFAULT_HEALTH_DETECTORS_CONFIG.incidentScanLimit,
      },
      now: () => Date.now(),
    });
    await cycle.run();
    const opened = stream.filter(event => event.code === 'background_work_failures_opened');
    expect(opened).toHaveLength(1);
    expect(opened[0]!.provenance.subjectHash)
      .toBe(hashHealthEventSubject('memory_pipeline:episode_synthesis'));
  });
});
