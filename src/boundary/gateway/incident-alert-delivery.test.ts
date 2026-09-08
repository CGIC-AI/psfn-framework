import { describe, expect, it } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import {
  createHealthEvent,
  hashHealthEventSubject,
  processObserverId,
  type HealthEvent,
  type HealthEventInput,
} from '../../shared/contracts/health-event.js';
import {
  DEFAULT_HEALTH_DETECTORS_CONFIG,
  type HealthDetectorsConfig,
} from '../../system/config/scheduler-config/health-detectors.js';
import { createIncidentInvestigator } from '../../shared/observability/incident-alerts/investigator.js';
import {
  createIncidentAlertDelivery,
  subscribeIncidentAlerts,
  type IncidentAlertDelivery,
  type IncidentAlertOutcome,
  type OperatorIncidentAlertSink,
} from './incident-alert-delivery.js';
import type { NotifyNtfyParams, OperatorAlertResult } from './protocol.js';
import {
  createHumanEscalationControlPlane,
} from '../../shared/escalation/control-plane.js';
import {
  createInMemoryHumanEscalationLedger,
} from '../../shared/escalation/memory-ledger.js';
import type { HumanEscalationLedgerPort } from '../../shared/escalation/contracts.js';
import {
  DEFAULT_HUMAN_ESCALATION_CONFIG,
} from '../../system/config/scheduler-config/human-escalation.js';
import { createOperatorAlertEscalationSink } from './human-escalation-operator-sink.js';

const NOW_MS = 1_800_000_000_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const CONFIG = DEFAULT_HEALTH_DETECTORS_CONFIG;

function event(overrides: Partial<HealthEventInput> & Pick<HealthEventInput, 'code'>): HealthEvent {
  return createHealthEvent({
    owner: { kind: 'system' },
    severity: 'critical',
    provenance: {
      process: 'gateway',
      component: 'persistence',
      observerId: processObserverId(),
      subjectHash: hashHealthEventSubject('pool:runtime'),
    },
    observedAtMs: NOW_MS,
    recordedAtMs: NOW_MS,
    ...overrides,
  });
}

interface Harness {
  delivery: IncidentAlertDelivery;
  sent: NotifyNtfyParams[];
  stream: HealthEvent[];
  setNow: (nowMs: number) => void;
  errors: string[];
}

function harness(options: {
  sink?: OperatorIncidentAlertSink | null;
  config?: HealthDetectorsConfig;
  /** Shared to model a restart: a new process, the same durable ledger. */
  ledger?: HumanEscalationLedgerPort;
  stream?: HealthEvent[];
  sent?: NotifyNtfyParams[];
} = {}): Harness {
  const stream: HealthEvent[] = options.stream ?? [];
  const sent: NotifyNtfyParams[] = options.sent ?? [];
  const errors: string[] = [];
  let clock = NOW_MS;
  const config = options.config ?? CONFIG;
  const defaultSink: OperatorIncidentAlertSink = {
    async dispatch(params) {
      sent.push(params);
      return { deliveries: [{ sink: 'ntfy', status: 'sent', target: 'ops' }] };
    },
  };
  const sink = options.sink === undefined ? defaultSink : options.sink;
  return {
    stream,
    sent,
    errors,
    setNow: (nowMs) => { clock = nowMs; },
    delivery: createIncidentAlertDelivery({
      investigator: createIncidentInvestigator({
        readStream: async (query) => stream
          .filter(row => row.correlationId === query.correlationId)
          .slice(0, query.limit ?? stream.length),
        config: () => config,
        now: () => clock,
      }),
      // The alert path reaches the same fake dispatcher through the governed
      // escalation plane, exactly as it does in the gateway and the agent. Only
      // the fixture changes: every assertion below is on the outcomes and the
      // rendered notification, which the migration must leave untouched.
      escalation: createHumanEscalationControlPlane<NotifyNtfyParams>({
        ledger: options.ledger ?? createInMemoryHumanEscalationLedger(),
        routing: () => DEFAULT_HUMAN_ESCALATION_CONFIG.routes,
        sinks: [createOperatorAlertEscalationSink({ resolveDispatcher: () => sink })],
        now: () => clock,
        logger: { info: () => undefined, warn: () => undefined },
      }),
      policy: () => config.incidentAlerts,
      now: () => clock,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: (message) => { errors.push(message); },
      },
    }),
  };
}

/** Emit one incident statement: persist it, then hand it to the alert path. */
async function state(bench: Harness, incidentEvent: HealthEvent): Promise<IncidentAlertOutcome> {
  bench.stream.push(incidentEvent);
  return await bench.delivery.handle(incidentEvent);
}

describe('deduplicated operator alert delivery', () => {
  it.each([
    ['a Postgres connection storm', 'postgres_pool_pressure_opened'],
    ['a repeated memory-refresh failure', 'background_work_failures_opened'],
    ['a stuck automata job', 'stuck_runtime_job_opened'],
    ['an unconfigured operator alert sink', 'operator_alert_sinks_unconfigured'],
  ] as const)('delivers exactly one alert for %s', async (_label, code) => {
    const bench = harness();
    const opened = event({ code });

    const first = await state(bench, opened);
    // The detector re-states the same open episode every cooldown; a persistent
    // fault must not become a persistent alert.
    bench.setNow(NOW_MS + CONFIG.cooldownMs);
    const restated = await state(bench, event({
      code,
      correlationId: opened.correlationId,
      occurrenceCount: 2,
      recordedAtMs: NOW_MS + CONFIG.cooldownMs,
      lastObservedAtMs: NOW_MS + CONFIG.cooldownMs,
    }));

    expect(first).toEqual({
      status: 'delivered',
      incidentId: opened.correlationId,
      phase: 'opened',
    });
    expect(restated).toEqual({
      status: 'suppressed',
      incidentId: opened.correlationId,
      reason: 'within_cooldown',
    });
    expect(bench.sent).toHaveLength(1);
    expect(bench.sent[0]!.message).toContain(opened.correlationId);
    expect(bench.sent[0]!.idempotencyKey).toBe(`${opened.correlationId}:opened:1`);
    expect(bench.sent[0]!.sender).toEqual({
      kind: 'system',
      provenance: 'system.observability.incident_alert',
    });
  });

  it('stays quiet under healthy traffic and ordinary evidence', async () => {
    const bench = harness();

    const outcomes = [
      await state(bench, event({ code: 'postgres_pool_pressure_sampled', severity: 'warning' })),
      await state(bench, event({ code: 'background_work_job_failed', severity: 'warning' })),
      await state(bench, event({ code: 'memory_refresh_failed', severity: 'warning' })),
      await state(bench, event({ code: 'scheduler_task_failed', severity: 'warning' })),
    ];

    expect(outcomes).toEqual([
      { status: 'ignored' },
      { status: 'ignored' },
      { status: 'ignored' },
      { status: 'ignored' },
    ]);
    expect(bench.sent).toEqual([]);
  });

  it('re-alerts a prolonged incident once the owner-file cooldown has elapsed', async () => {
    const bench = harness();
    const opened = event({ code: 'postgres_pool_pressure_opened' });
    await state(bench, opened);

    bench.setNow(NOW_MS + CONFIG.incidentAlerts.realertCooldownMs);
    const outcome = await state(bench, event({
      code: 'postgres_pool_pressure_opened',
      correlationId: opened.correlationId,
      occurrenceCount: 5,
      recordedAtMs: NOW_MS + CONFIG.incidentAlerts.realertCooldownMs,
      lastObservedAtMs: NOW_MS + CONFIG.incidentAlerts.realertCooldownMs,
      evidence: { durationMs: CONFIG.incidentAlerts.realertCooldownMs },
    }));

    expect(outcome.status).toBe('delivered');
    expect(bench.sent).toHaveLength(2);
    // Same incident, distinct notification: a sink that collapses on the
    // idempotency key must not swallow the "still going" alert.
    expect(bench.sent[1]!.idempotencyKey).toBe(`${opened.correlationId}:opened:2`);
    expect(bench.sent[1]!.message).toContain(opened.correlationId);
  });

  it('does not re-alert an incident an earlier process already stated', async () => {
    const bench = harness();
    const opened = event({ code: 'stuck_runtime_job_opened' });
    // Written by a previous boot: the ledger is empty, the stream is not.
    bench.stream.push(opened);

    bench.setNow(NOW_MS + CONFIG.cooldownMs);
    const outcome = await state(bench, event({
      code: 'stuck_runtime_job_opened',
      correlationId: opened.correlationId,
      occurrenceCount: 2,
      recordedAtMs: NOW_MS + CONFIG.cooldownMs,
      lastObservedAtMs: NOW_MS + CONFIG.cooldownMs,
    }));

    expect(outcome).toEqual({
      status: 'suppressed',
      incidentId: opened.correlationId,
      reason: 'stated_by_earlier_process',
    });
    expect(bench.sent).toEqual([]);
  });

  it('re-alerts after a restart only once the incident has been silent for the cooldown', async () => {
    const bench = harness();
    const opened = event({ code: 'stuck_runtime_job_opened' });
    bench.stream.push(opened);

    bench.setNow(NOW_MS + CONFIG.incidentAlerts.realertCooldownMs + MINUTE_MS);
    const outcome = await state(bench, event({
      code: 'stuck_runtime_job_opened',
      correlationId: opened.correlationId,
      occurrenceCount: 9,
      recordedAtMs: NOW_MS + CONFIG.incidentAlerts.realertCooldownMs + MINUTE_MS,
      lastObservedAtMs: NOW_MS + CONFIG.incidentAlerts.realertCooldownMs + MINUTE_MS,
    }));

    expect(outcome.status).toBe('delivered');
    expect(bench.sent).toHaveLength(1);
  });

  it('delivers one close notice and never a second', async () => {
    const bench = harness();
    const opened = event({ code: 'background_work_failures_opened' });
    await state(bench, opened);

    bench.setNow(NOW_MS + MINUTE_MS);
    const closeEvent = event({
      code: 'background_work_failures_closed',
      severity: 'info',
      correlationId: opened.correlationId,
      occurrenceCount: 2,
      recordedAtMs: NOW_MS + MINUTE_MS,
      lastObservedAtMs: NOW_MS + MINUTE_MS,
      evidence: { terminal: true, durationMs: MINUTE_MS },
    });
    const closed = await state(bench, closeEvent);
    const repeated = await bench.delivery.handle(closeEvent);

    expect(closed).toEqual({
      status: 'delivered',
      incidentId: opened.correlationId,
      phase: 'closed',
    });
    expect(repeated).toEqual({
      status: 'suppressed',
      incidentId: opened.correlationId,
      reason: 'already_notified',
    });
    expect(bench.sent).toHaveLength(2);
    expect(bench.sent[1]!.title).toContain('closed');
    expect(bench.sent[1]!.idempotencyKey).toBe(`${opened.correlationId}:closed:2`);
  });

  it('omits the close notice when the owner file turns it off', async () => {
    const bench = harness({
      config: {
        ...CONFIG,
        incidentAlerts: { ...CONFIG.incidentAlerts, closeNotice: false },
      },
    });
    const opened = event({ code: 'stuck_runtime_job_opened' });
    await state(bench, opened);

    const closed = await state(bench, event({
      code: 'stuck_runtime_job_closed',
      severity: 'info',
      correlationId: opened.correlationId,
      occurrenceCount: 2,
      recordedAtMs: NOW_MS + MINUTE_MS,
      lastObservedAtMs: NOW_MS + MINUTE_MS,
    }));

    expect(closed).toEqual({
      status: 'suppressed',
      incidentId: opened.correlationId,
      reason: 'close_notice_disabled',
    });
    expect(bench.sent).toHaveLength(1);
  });

  it('surfaces an unconfigured sink through the log path that remains', async () => {
    const unconfiguredSink: OperatorIncidentAlertSink = {
      async dispatch(): Promise<OperatorAlertResult> {
        return {
          outcome: 'unconfigured',
          deliveries: [],
          warning: 'Operator alerting has zero configured sinks; alerts cannot leave the runtime.',
        };
      },
    };
    const bench = harness({ sink: unconfiguredSink });
    const unconfigured = event({
      code: 'operator_alert_sinks_unconfigured',
      provenance: {
        process: 'gateway',
        component: 'operator_alerting',
        observerId: processObserverId(),
      },
      evidence: { configuredSinkCount: 0 },
    });

    const outcome = await state(bench, unconfigured);
    const repeat = await bench.delivery.handle(unconfigured);

    expect(outcome).toEqual({
      status: 'undeliverable',
      incidentId: unconfigured.correlationId,
      phase: 'opened',
      reason: 'unconfigured',
    });
    // Attempted once, so the incident cannot become an attempt storm either.
    expect(repeat.status).toBe('suppressed');
    expect(bench.errors).toEqual(['Runtime incident operator alert has nowhere to go']);
  });

  it('reports an incident raised before any sink exists instead of losing it', async () => {
    const bench = harness({ sink: null });

    const outcome = await state(bench, event({ code: 'operator_alert_sinks_unconfigured' }));

    expect(outcome.status).toBe('undeliverable');
    expect(bench.errors).toEqual([
      'Runtime incident could not be alerted: no operator alert sink is wired',
    ]);
  });

  it('reports a dispatcher that failed on every sink', async () => {
    const bench = harness({
      sink: {
        async dispatch(): Promise<OperatorAlertResult> {
          throw new Error('Operator alert delivery failed for every configured sink (ntfy: 503)');
        },
      },
    });

    const outcome = await state(bench, event({ code: 'postgres_pool_pressure_opened' }));

    expect(outcome.status).toBe('undeliverable');
    expect(outcome).toMatchObject({ reason: 'delivery_failed' });
    expect(bench.errors).toEqual(['Runtime incident operator alert delivery failed']);
  });

  it('carries the incident tenancy and never another companion', async () => {
    const bench = harness();
    const opened = event({
      code: 'background_work_failures_opened',
      owner: { kind: 'companion', companionId: COMPANION_ID },
      provenance: {
        process: 'agent',
        component: 'background_work',
        observerId: processObserverId(),
        subjectHash: hashHealthEventSubject('memory_refresh:active_context'),
      },
      evidence: { failureCount: 4 },
    });

    await state(bench, opened);

    expect(bench.sent[0]!.message).toContain(`companion ${COMPANION_ID}`);
    expect(bench.sent[0]!.message).toContain('failureCount=4');
    expect(bench.sent[0]!.message).toContain('healthDetectors.backgroundFailures');
  });

  it('keeps the ledger bounded by the owner-file capacity', async () => {
    const capacity = 2;
    const bench = harness({
      config: { ...CONFIG, incidentAlerts: { ...CONFIG.incidentAlerts, ledgerCapacity: capacity } },
    });
    const incidents = [
      event({ code: 'postgres_pool_pressure_opened' }),
      event({ code: 'background_work_failures_opened' }),
      event({ code: 'stuck_runtime_job_opened' }),
    ];
    for (const incident of incidents) await state(bench, incident);

    // The evicted incident re-anchors from the stream, not from an empty
    // ledger, so eviction costs a read rather than a duplicate alert.
    bench.setNow(NOW_MS + MINUTE_MS);
    const evicted = await state(bench, event({
      code: 'postgres_pool_pressure_opened',
      correlationId: incidents[0]!.correlationId,
      occurrenceCount: 2,
      recordedAtMs: NOW_MS + MINUTE_MS,
      lastObservedAtMs: NOW_MS + MINUTE_MS,
    }));

    expect(bench.sent).toHaveLength(incidents.length);
    expect(evicted).toEqual({
      status: 'suppressed',
      incidentId: incidents[0]!.correlationId,
      reason: 'stated_by_earlier_process',
    });
  });
});

describe('incident alert bus subscription', () => {
  it('alerts once from the real bus event and contains an evaluation fault', async () => {
    const eventBus = new EventBus();
    const bench = harness();
    const errors: string[] = [];
    const detach = subscribeIncidentAlerts({
      eventBus,
      delivery: {
        handle: async (incidentEvent) => {
          if (incidentEvent.code === 'scheduler_task_failed') throw new Error('investigator down');
          return await bench.delivery.handle(incidentEvent);
        },
      },
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: (message) => { errors.push(message); },
      },
    });

    const opened = event({ code: 'stuck_runtime_job_opened' });
    bench.stream.push(opened);
    await eventBus.emit('runtime.health.event', { event: opened });
    await eventBus.emit('runtime.health.event', {
      event: event({ code: 'scheduler_task_failed', severity: 'warning' }),
    });
    detach();
    await eventBus.emit('runtime.health.event', {
      event: event({ code: 'postgres_pool_pressure_opened' }),
    });

    expect(bench.sent).toHaveLength(1);
    expect(errors).toEqual(['Runtime incident alert evaluation failed']);
  });
});

describe('incident alert cooldown policy', () => {
  it('never promises a re-alert cadence faster than the stream can restate', () => {
    expect(CONFIG.incidentAlerts.realertCooldownMs).toBeGreaterThanOrEqual(CONFIG.cooldownMs);
    expect(CONFIG.incidentAlerts.realertCooldownMs).toBe(HOUR_MS);
  });
});

describe('incident alert keys across a restart', () => {
  it('mints a fresh key for every re-alert, however often the process restarts', async () => {
    // The bug this pins: the alert sequence used to come from an in-process
    // counter that restarts at zero. After the SECOND restart it re-minted a
    // key an earlier process had already recorded durably, the escalation plane
    // correctly refused to dispatch a recorded key twice, and the operator
    // silently stopped being told the fault was still going.
    const ledger = createInMemoryHumanEscalationLedger();
    const stream: HealthEvent[] = [];
    const sent: NotifyNtfyParams[] = [];
    const opened = event({ code: 'postgres_pool_pressure_opened' });
    let elapsed = 0;

    for (let boot = 0; boot < 3; boot += 1) {
      const bench = harness({ ledger, stream, sent });
      // Each boot re-anchors on the persisted stream, then re-alerts once the
      // incident has been open for a full re-alert cooldown.
      elapsed += CONFIG.incidentAlerts.realertCooldownMs;
      bench.setNow(NOW_MS + elapsed);
      const outcome = await state(bench, event({
        code: 'postgres_pool_pressure_opened',
        correlationId: opened.correlationId,
        occurrenceCount: boot + 1,
        recordedAtMs: NOW_MS + elapsed,
        lastObservedAtMs: NOW_MS + elapsed,
      }));

      expect(outcome).toEqual({
        status: 'delivered',
        incidentId: opened.correlationId,
        phase: 'opened',
      });
    }

    expect(sent.map(alert => alert.idempotencyKey)).toEqual([
      `${opened.correlationId}:opened:1`,
      `${opened.correlationId}:opened:2`,
      `${opened.correlationId}:opened:3`,
    ]);
  });
});
