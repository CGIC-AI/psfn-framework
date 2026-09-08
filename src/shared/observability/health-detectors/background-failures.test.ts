import { describe, expect, it } from 'vitest';
import { EventBus } from '../../event-bus.js';
import {
  createHealthEvent,
  hashHealthEventSubject,
  processObserverId,
  validateHealthEvent,
  type HealthEvent,
  type HealthEventInput,
  type HealthEventPublisher,
  type HealthEventSource,
} from '../../contracts/health-event.js';
import { subscribeRefreshFailureHealthEvents } from '../refresh-failure-emitter.js';
import { DEFAULT_HEALTH_DETECTORS_CONFIG } from '../../../system/config/scheduler-config/health-detectors.js';
import { createHealthDetectorCycle } from './cycle.js';
import { createBackgroundFailureDetector } from './background-failures.js';

const NOW_MS = 1_800_000_000_000;
const MINUTE_MS = 60_000;
const SOURCE: HealthEventSource = { owner: { kind: 'system' }, process: 'agent' };
const POLICY = {
  incidentWindowMs: DEFAULT_HEALTH_DETECTORS_CONFIG.incidentWindowMs,
  cooldownMs: DEFAULT_HEALTH_DETECTORS_CONFIG.cooldownMs,
  incidentScanLimit: DEFAULT_HEALTH_DETECTORS_CONFIG.incidentScanLimit,
};
const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const MEMORY_LANE_SUBJECT = hashHealthEventSubject('memory_refresh:active_context');
const WIKI_LANE_SUBJECT = hashHealthEventSubject('memory_refresh:wiki_retrieval');

function harness(source: HealthEventSource = SOURCE): {
  runAt: (nowMs: number) => Promise<void>;
  record: (event: HealthEvent) => void;
  events: HealthEvent[];
  publisher: HealthEventPublisher;
} {
  const events: HealthEvent[] = [];
  const publisher: HealthEventPublisher = {
    async emit(_name, data) {
      events.push(validateHealthEvent(data.event));
    },
  };
  let clock = NOW_MS;
  const cycle = createHealthDetectorCycle({
    detectors: [createBackgroundFailureDetector({
      config: DEFAULT_HEALTH_DETECTORS_CONFIG.backgroundFailures,
    })],
    stream: {
      async listRecent(query = {}) {
        const sinceMs = query.sinceMs ?? 0;
        return events
          .filter(event => event.recordedAtMs >= sinceMs)
          .sort((left, right) => right.recordedAtMs - left.recordedAtMs)
          .slice(0, query.limit ?? events.length);
      },
    },
    publisher,
    source,
    policy: POLICY,
    now: () => clock,
  });
  return {
    events,
    publisher,
    record: (event) => { events.push(event); },
    async runAt(nowMs) {
      clock = nowMs;
      await cycle.run();
    },
  };
}

function failure(overrides: Partial<HealthEventInput> = {}): HealthEvent {
  return createHealthEvent({
    owner: { kind: 'system' },
    severity: 'degraded',
    code: 'background_work_job_failed',
    provenance: {
      process: 'agent',
      component: 'background_work',
      observerId: processObserverId(),
      subjectHash: hashHealthEventSubject('memory_extraction'),
    },
    observedAtMs: NOW_MS,
    ...overrides,
  });
}

describe('repeated background-work failure detector', () => {
  it('does not fire on a single transient failure', async () => {
    const detector = harness();
    detector.record(failure({ observedAtMs: NOW_MS }));
    await detector.runAt(NOW_MS + MINUTE_MS);
    expect(detector.events.filter(e => e.code.startsWith('background_work_failures'))).toEqual([]);
  });

  it('fires exactly one incident once the lane crosses the threshold', async () => {
    const detector = harness();
    for (let index = 0; index < 3; index += 1) {
      detector.record(failure({ observedAtMs: NOW_MS + index * MINUTE_MS }));
    }
    await detector.runAt(NOW_MS + 4 * MINUTE_MS);
    await detector.runAt(NOW_MS + 5 * MINUTE_MS);

    const opened = detector.events.filter(e => e.code === 'background_work_failures_opened');
    expect(opened).toHaveLength(1);
    expect(opened[0]!.provenance.component).toBe('background_work');
    expect(opened[0]!.provenance.subjectHash).toBe(hashHealthEventSubject('memory_extraction'));
    expect(opened[0]!.evidence).toEqual({
      failureCount: 3,
      windowMs: DEFAULT_HEALTH_DETECTORS_CONFIG.backgroundFailures.windowMs,
    });
    // The incident spans the first failure in the window, not the cycle time.
    expect(opened[0]!.firstObservedAtMs).toBe(NOW_MS);
    expect(opened[0]!.causationId).toBeDefined();
  });

  it('closes the episode once the lane stops failing for a full window', async () => {
    const detector = harness();
    for (let index = 0; index < 3; index += 1) {
      detector.record(failure({ observedAtMs: NOW_MS + index * MINUTE_MS }));
    }
    await detector.runAt(NOW_MS + 4 * MINUTE_MS);
    // Past the failure window with no new failure: the count falls to zero.
    const recoveredAtMs = NOW_MS
      + DEFAULT_HEALTH_DETECTORS_CONFIG.backgroundFailures.windowMs
      + 10 * MINUTE_MS;
    await detector.runAt(recoveredAtMs);
    await detector.runAt(recoveredAtMs + MINUTE_MS);

    const closed = detector.events.filter(e => e.code === 'background_work_failures_closed');
    expect(closed).toHaveLength(1);
    const opened = detector.events.filter(e => e.code === 'background_work_failures_opened');
    expect(closed[0]!.correlationId).toBe(opened[0]!.correlationId);
    expect(closed[0]!.evidence.terminal).toBe(true);
  });

  it('counts only its own tenant\'s failures in a fleet', async () => {
    // The agent emits every health event with resolveHealthEventOwner(companionId),
    // and so does this cycle. A sibling companion's failures must never reach
    // this companion's incident, even where a shared read surface returns them.
    const owner = { kind: 'companion', companionId: COMPANION_ID } as const;
    const detector = harness({ owner, process: 'agent' });
    for (let index = 0; index < 3; index += 1) {
      detector.record(failure({ owner, observedAtMs: NOW_MS + index * MINUTE_MS }));
      detector.record(failure({
        owner: {
          kind: 'companion',
          companionId: '22222222-2222-4222-8222-222222222222',
        },
        observedAtMs: NOW_MS + index * MINUTE_MS,
      }));
    }
    await detector.runAt(NOW_MS + 4 * MINUTE_MS);

    const opened = detector.events.filter(e => e.code === 'background_work_failures_opened');
    expect(opened).toHaveLength(1);
    expect(opened[0]!.owner).toEqual(owner);
    expect(opened[0]!.evidence.failureCount).toBe(3);
  });

  it('keeps two lanes as two incidents and never counts scheduler task failures', async () => {
    const detector = harness();
    for (let index = 0; index < 3; index += 1) {
      detector.record(failure({ observedAtMs: NOW_MS + index * MINUTE_MS }));
      detector.record(failure({
        code: 'memory_refresh_failed',
        severity: 'warning',
        provenance: {
          process: 'agent',
          component: 'memory',
          observerId: processObserverId(),
          subjectHash: MEMORY_LANE_SUBJECT,
        },
        observedAtMs: NOW_MS + index * MINUTE_MS,
      }));
      // The detector cycle is itself a scheduler task: counting these would let
      // a broken detector manufacture its own incident.
      detector.record(failure({
        code: 'scheduler_task_failed',
        provenance: {
          process: 'agent',
          component: 'scheduler',
          observerId: processObserverId(),
          subjectHash: hashHealthEventSubject('runtime-health-detectors'),
        },
        observedAtMs: NOW_MS + index * MINUTE_MS,
      }));
    }
    await detector.runAt(NOW_MS + 4 * MINUTE_MS);

    const opened = detector.events.filter(e => e.code === 'background_work_failures_opened');
    expect(opened).toHaveLength(2);
    expect(new Set(opened.map(e => e.correlationId)).size).toBe(2);
    expect(new Set(opened.map(e => e.provenance.subjectHash)))
      .toEqual(new Set([hashHealthEventSubject('memory_extraction'), MEMORY_LANE_SUBJECT]));
    expect(opened.map(e => e.provenance.component).sort()).toEqual(['background_work', 'memory']);
  });
});

describe('refresh-failure health emitter', () => {
  it('projects only failed refreshes, grouped by lane, carrying no content', async () => {
    const eventBus = new EventBus();
    const emitted: HealthEvent[] = [];
    eventBus.on('runtime.health.event', (data) => {
      emitted.push(validateHealthEvent(data.event));
    });
    const detach = subscribeRefreshFailureHealthEvents({ eventBus, source: SOURCE });

    await eventBus.emit('memory.active_context.refresh', {
      channelId: 'discord:private-channel',
      key: 'private-key',
      phase: 'ready',
      timestamp: NOW_MS,
    });
    await eventBus.emit('memory.active_context.refresh', {
      channelId: 'discord:private-channel',
      key: 'private-key',
      phase: 'degraded',
      error: 'ECONNREFUSED at 10.0.0.1',
      timestamp: NOW_MS + 1,
    });
    await eventBus.emit('wiki.retrieval.turn_degraded', {
      channelId: 'discord:private-channel',
      key: 'private-key',
      reason: 'stale',
      refreshStatus: null,
      turnId: 'turn-1',
      requestId: 'request-1',
      timestamp: NOW_MS + 2,
    });
    await eventBus.emit('wiki.retrieval.turn_degraded', {
      channelId: 'discord:private-channel',
      key: 'private-key',
      reason: 'refresh_failed',
      refreshStatus: 'degraded',
      turnId: 'turn-2',
      requestId: 'request-2',
      lastRefreshError: 'boom at /home/operator/secret',
      timestamp: NOW_MS + 3,
    });
    detach();

    expect(emitted.map(event => event.provenance.subjectHash))
      .toEqual([MEMORY_LANE_SUBJECT, WIKI_LANE_SUBJECT]);
    expect(emitted.every(event => event.code === 'memory_refresh_failed')).toBe(true);
    // Content-free by construction: nothing from the payloads survives.
    const serialized = JSON.stringify(emitted);
    for (const leak of ['discord', 'private-key', 'ECONNREFUSED', '10.0.0.1', 'turn-2', 'operator']) {
      expect(serialized).not.toContain(leak);
    }

    // Detached: a later degradation emits nothing.
    await eventBus.emit('memory.active_context.refresh', {
      channelId: 'discord:private-channel',
      key: 'private-key',
      phase: 'degraded',
      timestamp: NOW_MS + 4,
    });
    expect(emitted).toHaveLength(2);
  });
});
