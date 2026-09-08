import { describe, expect, it } from 'vitest';
import {
  validateHealthEvent,
  type HealthEvent,
  type HealthEventPublisher,
  type HealthEventSource,
} from '../../contracts/health-event.js';
import { DEFAULT_HEALTH_DETECTORS_CONFIG } from '../../../system/config/scheduler-config/health-detectors.js';
import { createHealthDetectorCycle } from './cycle.js';
import {
  createPostgresPressureDetector,
  type PostgresPoolOwnerPressure,
} from './postgres-pressure.js';

const NOW_MS = 1_800_000_000_000;
const SOURCE: HealthEventSource = { owner: { kind: 'system' }, process: 'agent' };
const POLICY = {
  incidentWindowMs: DEFAULT_HEALTH_DETECTORS_CONFIG.incidentWindowMs,
  cooldownMs: DEFAULT_HEALTH_DETECTORS_CONFIG.cooldownMs,
  incidentScanLimit: DEFAULT_HEALTH_DETECTORS_CONFIG.incidentScanLimit,
};

/**
 * Stands in for the persisted ring: the sink and the read seam, so a cycle
 * reads back exactly what earlier cycles wrote — which is what the detector's
 * "sustained" and "already open" decisions depend on.
 */
function createStreamDouble(): {
  publisher: HealthEventPublisher;
  listRecent: (query?: { limit?: number; sinceMs?: number }) => Promise<HealthEvent[]>;
  events: HealthEvent[];
} {
  const events: HealthEvent[] = [];
  return {
    events,
    publisher: {
      async emit(_event, data) {
        // Re-validated exactly as the real persisting sink does, so a detector
        // that emitted something unpersistable fails the test rather than CI.
        events.push(validateHealthEvent(data.event));
      },
    },
    async listRecent(query = {}) {
      const sinceMs = query.sinceMs ?? 0;
      return events
        .filter(event => event.recordedAtMs >= sinceMs)
        .sort((left, right) => right.recordedAtMs - left.recordedAtMs)
        .slice(0, query.limit ?? events.length);
    },
  };
}

function pools(active: number, waiting = 0, capacity = 3): PostgresPoolOwnerPressure[] {
  return [{
    process: 'agent',
    authorities: [{ authorityIndex: 1, capacity, active, waiting }],
  }];
}

function harness(
  telemetry: () => readonly PostgresPoolOwnerPressure[],
  config = DEFAULT_HEALTH_DETECTORS_CONFIG.postgresPressure,
): { runAt: (nowMs: number) => Promise<void>; events: HealthEvent[] } {
  const stream = createStreamDouble();
  let clock = NOW_MS;
  const cycle = createHealthDetectorCycle({
    detectors: [createPostgresPressureDetector({ telemetry, config })],
    stream: { listRecent: stream.listRecent },
    publisher: stream.publisher,
    source: SOURCE,
    policy: POLICY,
    now: () => clock,
  });
  return {
    events: stream.events,
    async runAt(nowMs: number): Promise<void> {
      clock = nowMs;
      await cycle.run();
    },
  };
}

const codesOf = (events: readonly HealthEvent[]): string[] => events.map(event => event.code);

describe('postgres connection-storm detector', () => {
  it('emits nothing at all for healthy pool traffic', async () => {
    const detector = harness(() => pools(1));
    for (let cycle = 0; cycle < 10; cycle += 1) {
      await detector.runAt(NOW_MS + cycle * 60_000);
    }
    expect(detector.events).toEqual([]);
  });

  it('samples pressure without opening an incident before it is sustained', async () => {
    const detector = harness(() => pools(3));
    await detector.runAt(NOW_MS);
    await detector.runAt(NOW_MS + 60_000);
    // Two of the three required samples: pressure is recorded, but a spike that
    // has not persisted is not yet an incident.
    expect(codesOf(detector.events)).toEqual([
      'postgres_pool_pressure_sampled',
      'postgres_pool_pressure_sampled',
    ]);
  });

  it('opens exactly one correlated incident for a sustained storm', async () => {
    const detector = harness(() => pools(3, 4));
    // Twenty one-minute cycles: long enough to cross the 15-minute cooldown
    // once, so the test sees both the open and its first occurrence update.
    for (let cycle = 0; cycle < 20; cycle += 1) {
      await detector.runAt(NOW_MS + cycle * 60_000);
    }
    const opened = detector.events.filter(event => event.code === 'postgres_pool_pressure_opened');
    expect(opened.length).toBeGreaterThan(0);
    expect(new Set(opened.map(event => event.correlationId)).size).toBe(1);

    const first = opened[0]!;
    expect(first.occurrenceCount).toBe(1);
    expect(first.severity).toBe('degraded');
    expect(first.provenance.component).toBe('persistence');
    expect(first.evidence).toEqual({
      poolCapacity: 3,
      activeConnections: 3,
      waitingRequests: 4,
      saturationPercent: 100,
      sampleCount: 3,
    });
    // The incident cites the very sample that justified it, so an operator can
    // walk from the incident back to its evidence inside the stream.
    const sampleIds = detector.events
      .filter(event => event.code === 'postgres_pool_pressure_sampled')
      .map(event => event.eventId);
    expect(first.causationId).toBeDefined();
    expect(sampleIds).toContain(first.causationId);

    // Occurrence updates rise on the same incident, gated by the cooldown.
    expect(opened.map(event => event.occurrenceCount)).toEqual([1, 2]);
    expect(opened[1]!.causationId).toBe(first.eventId);
  });

  it('closes the episode exactly once when the pool recovers', async () => {
    let active = 3;
    const detector = harness(() => pools(active));
    for (let cycle = 0; cycle < 4; cycle += 1) {
      await detector.runAt(NOW_MS + cycle * 60_000);
    }
    active = 0;
    for (let cycle = 4; cycle < 8; cycle += 1) {
      await detector.runAt(NOW_MS + cycle * 60_000);
    }
    const closed = detector.events.filter(event => event.code === 'postgres_pool_pressure_closed');
    expect(closed).toHaveLength(1);
    const opened = detector.events.filter(event => event.code === 'postgres_pool_pressure_opened');
    expect(closed[0]!.correlationId).toBe(opened[0]!.correlationId);
    expect(closed[0]!.severity).toBe('info');
    expect(closed[0]!.evidence.terminal).toBe(true);
    // Opened on the third pressure cycle, closed on the first healthy one.
    expect(closed[0]!.evidence.durationMs).toBe(120_000);
  });

  it('reopens a distinct incident when the storm recurs after recovery', async () => {
    let active = 3;
    const detector = harness(() => pools(active));
    for (let cycle = 0; cycle < 3; cycle += 1) await detector.runAt(NOW_MS + cycle * 60_000);
    active = 0;
    await detector.runAt(NOW_MS + 180_000);
    active = 3;
    for (let cycle = 4; cycle < 8; cycle += 1) await detector.runAt(NOW_MS + cycle * 60_000);

    const opened = detector.events.filter(event => event.code === 'postgres_pool_pressure_opened');
    expect(new Set(opened.map(event => event.correlationId)).size).toBe(2);
  });

  it('keeps one incident across a detector restart because the ledger is the stream', async () => {
    const stream = createStreamDouble();
    let clock = NOW_MS;
    const build = () => createHealthDetectorCycle({
      detectors: [createPostgresPressureDetector({
        telemetry: () => pools(3),
        config: DEFAULT_HEALTH_DETECTORS_CONFIG.postgresPressure,
      })],
      stream: { listRecent: stream.listRecent },
      publisher: stream.publisher,
      source: SOURCE,
      policy: POLICY,
      now: () => clock,
    });
    let cycle = build();
    for (let step = 0; step < 4; step += 1) {
      clock = NOW_MS + step * 60_000;
      await cycle.run();
    }
    // A brand new cycle with no memory of the episode, exactly as a restart.
    cycle = build();
    for (let step = 4; step < 40; step += 1) {
      clock = NOW_MS + step * 60_000;
      await cycle.run();
    }
    const opened = stream.events.filter(event => event.code === 'postgres_pool_pressure_opened');
    expect(new Set(opened.map(event => event.correlationId)).size).toBe(1);
  });

  it('separates two pool authorities into two incidents', async () => {
    const detector = harness(() => [{
      process: 'agent',
      authorities: [
        { authorityIndex: 1, capacity: 3, active: 3, waiting: 0 },
        { authorityIndex: 2, capacity: 3, active: 3, waiting: 0 },
      ],
    }]);
    for (let step = 0; step < 3; step += 1) await detector.runAt(NOW_MS + step * 60_000);
    const opened = detector.events.filter(event => event.code === 'postgres_pool_pressure_opened');
    expect(opened).toHaveLength(2);
    expect(new Set(opened.map(event => event.correlationId)).size).toBe(2);
    expect(new Set(opened.map(event => event.provenance.subjectHash)).size).toBe(2);
  });

  it('fails loudly rather than silently closing when a detector throws', async () => {
    const stream = createStreamDouble();
    const cycle = createHealthDetectorCycle({
      detectors: [{
        id: 'exploding',
        family: 'postgres_pool_pressure',
        detect: () => Promise.reject(new Error('telemetry unavailable')),
      }],
      stream: { listRecent: stream.listRecent },
      publisher: stream.publisher,
      source: SOURCE,
      policy: POLICY,
      now: () => NOW_MS,
    });
    await expect(cycle.run()).rejects.toThrow(/1 of 1 runtime health detectors failed/u);
    expect(stream.events).toEqual([]);
  });

  it('refuses a composition with two detectors for one family', () => {
    const stream = createStreamDouble();
    const detector = createPostgresPressureDetector({
      telemetry: () => pools(1),
      config: DEFAULT_HEALTH_DETECTORS_CONFIG.postgresPressure,
    });
    expect(() => createHealthDetectorCycle({
      detectors: [detector, detector],
      stream: { listRecent: stream.listRecent },
      publisher: stream.publisher,
      source: SOURCE,
      policy: POLICY,
    })).toThrow(/more than one detector for family: postgres_pool_pressure/u);
  });
});
