import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import type { HealthEvent, HealthEventSource } from '../../shared/contracts/health-event.js';
import { createRuntimeHealthDetectorCycle } from '../../shared/observability/health-detectors/runtime.js';
import { createIncidentInvestigator } from '../../shared/observability/incident-alerts/investigator.js';
import { createIncidentAlertDelivery, subscribeIncidentAlerts } from '../../boundary/gateway/incident-alert-delivery.js';
import { createOperatorAlertEscalationSink } from '../../boundary/gateway/human-escalation-operator-sink.js';
import type { NotifyNtfyParams } from '../../boundary/gateway/protocol.js';
import { createHumanEscalationControlPlane } from '../../shared/escalation/control-plane.js';
import { createInMemoryHumanEscalationLedger } from '../../shared/escalation/memory-ledger.js';
import { DEFAULT_HEALTH_DETECTORS_CONFIG } from '../../system/config/scheduler-config/health-detectors.js';
import { DEFAULT_HUMAN_ESCALATION_CONFIG } from '../../system/config/scheduler-config/human-escalation.js';
import { Scheduler } from './scheduler.js';
import { createRuntimeHealthDetectorScheduler } from './health-detector-task.js';

afterEach(() => vi.useRealTimers());

describe('runtime health watchdog scheduling', () => {
  it('never overlaps detector runs and drains the active run before stopping', async () => {
    vi.useFakeTimers();
    let release = (): void => undefined;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const run = vi.fn(() => pending);
    const watchdog = createRuntimeHealthDetectorScheduler({
      eventBus: new EventBus(),
      source: { owner: { kind: 'system' }, process: 'agent' },
      intervalMs: 1_000,
      cycle: { run },
    });
    watchdog.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(run).toHaveBeenCalledOnce();
    let stopped = false;
    const stopping = watchdog.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(stopped).toBe(false);
    expect(run).toHaveBeenCalledOnce();
    release();
    await stopping;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(stopped).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });

  it('alerts through the existing operator path while an ordinary task remains stuck, then closes on recovery', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T12:00:00Z'));
    const eventBus = new EventBus();
    const source: HealthEventSource = { owner: { kind: 'system' }, process: 'agent' };
    const config = {
      ...DEFAULT_HEALTH_DETECTORS_CONFIG,
      intervalMs: 1_000,
      stuckJobs: { automataRunBudgetMs: 2_000, schedulerTaskBudgetMs: 2_000 },
    };
    const events: HealthEvent[] = [];
    eventBus.on('runtime.health.event', ({ event }) => { events.push(event); });
    const notifyOperator = vi.fn(async (_params: NotifyNtfyParams) => ({
      deliveries: [{ sink: 'ntfy' as const, status: 'sent' as const, target: 'ops' }],
    }));
    const readStream = async (query: { sinceMs?: number; limit?: number; correlationId?: string } = {}) => events
      .filter(event => event.recordedAtMs >= (query.sinceMs ?? 0)
        && (!query.correlationId || event.correlationId === query.correlationId))
      .sort((left, right) => right.recordedAtMs - left.recordedAtMs)
      .slice(0, query.limit ?? events.length);
    const detach = subscribeIncidentAlerts({
      eventBus,
      delivery: createIncidentAlertDelivery({
        investigator: createIncidentInvestigator({ readStream, config: () => config }),
        escalation: createHumanEscalationControlPlane<NotifyNtfyParams>({
          ledger: createInMemoryHumanEscalationLedger(),
          routing: () => DEFAULT_HUMAN_ESCALATION_CONFIG.routes,
          sinks: [createOperatorAlertEscalationSink({
            resolveDispatcher: () => ({ dispatch: notifyOperator }),
          })],
        }),
        policy: () => config.incidentAlerts,
      }),
    });
    const workScheduler = new Scheduler(eventBus, { tickIntervalMs: 1_000 });
    let releaseWork = (): void => undefined;
    const blocked = new Promise<void>(resolve => { releaseWork = resolve; });
    workScheduler.register({
      id: 'ordinary-maintenance', name: 'Ordinary maintenance', type: 'every',
      intervalMs: 1_000, state: 'idle', handler: () => blocked,
    });
    const watchdog = createRuntimeHealthDetectorScheduler({
      eventBus,
      source,
      intervalMs: config.intervalMs,
      cycle: createRuntimeHealthDetectorCycle({
        stream: { listRecent: readStream }, publisher: eventBus, source, config,
        stuckJobs: { listTasks: () => workScheduler.listTasks() },
      }),
    });
    try {
      workScheduler.start();
      watchdog.start();
      await vi.advanceTimersByTimeAsync(1_500);
      expect(notifyOperator).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(workScheduler.getTask('ordinary-maintenance')?.state).toBe('active');
      expect(notifyOperator).toHaveBeenCalledOnce();
      expect(events.filter(event => event.code === 'stuck_runtime_job_opened')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(notifyOperator).toHaveBeenCalledOnce();
      releaseWork();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(events.filter(event => event.code === 'stuck_runtime_job_closed')).toHaveLength(1);
      expect(notifyOperator).toHaveBeenCalledTimes(2);
    } finally {
      releaseWork();
      await watchdog.stop();
      await workScheduler.stop();
      detach();
    }
  });
});
