import { describe, expect, it, vi } from 'vitest';

import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import {
  CompanionAvailabilityRuntime,
  attachToolAvailability,
  type CompanionAvailabilitySnapshot,
  type CompanionAvailabilityStorePort,
  type QueuedCompanionMessage,
} from './companion-availability.js';
import { EventBus } from '../../shared/event-bus.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { POSTGRES_COMPANION_AVAILABILITY_MIGRATIONS } from '../../persistence/postgres/migrations.js';
import { BackgroundWorkSupervisor } from './background-work/supervisor.js';
import type { BackgroundWorkStorePort } from './background-work/store-port.js';
import type { ClaimedBackgroundWorkJob } from './background-work/types.js';
import {
  registerGatewayMessageHandlers,
  type GatewayMessageAgentLoop,
  type GatewayMessageGateway,
} from '../../app/agent/gateway-message-handlers.js';
import { createNoopSatelliteRoutingPort } from './satellite-adapter-port.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';

const TEST_DRAIN_RETRY_DELAY_MS = 10;

class MemoryAvailabilityStore implements CompanionAvailabilityStorePort {
  state: CompanionAvailabilitySnapshot = {
    state: 'available',
    sinceMs: 1,
    revision: 1,
  };
  queued: QueuedCompanionMessage[] = [];

  async readState(): Promise<CompanionAvailabilitySnapshot> {
    return this.state;
  }

  async writeState(state: CompanionAvailabilitySnapshot): Promise<void> {
    this.state = state;
  }

  async enqueue(message: SubstrateMessage, enqueuedAtMs: number): Promise<'enqueued' | 'duplicate'> {
    if (this.queued.some(entry => entry.message.id === message.id && entry.message.channelId === message.channelId)) {
      return 'duplicate';
    }
    this.queued.push({ sequence: this.queued.length + 1, enqueuedAtMs, message });
    return 'enqueued';
  }

  async listPending(limit: number): Promise<QueuedCompanionMessage[]> {
    return this.queued.slice(0, limit);
  }

  async hasPending(): Promise<boolean> {
    return this.queued.length > 0;
  }

  async acknowledge(sequence: number): Promise<boolean> {
    const index = this.queued.findIndex(entry => entry.sequence === sequence);
    if (index < 0) return false;
    this.queued.splice(index, 1);
    return true;
  }
}

function message(id: string): SubstrateMessage {
  return {
    id,
    channelId: 'discord-room',
    channelType: 'discord',
    authorId: 'human-1',
    authorName: 'Example Person',
    content: `message ${id}`,
    timestamp: new Date('2026-08-06T12:00:00.000Z'),
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(settle => { resolve = settle; });
  return { promise, resolve };
}

describe('CompanionAvailabilityRuntime', () => {
  it('keeps nested protected activity unavailable until the final lease exits', async () => {
    const store = new MemoryAvailabilityStore();
    const projected: string[] = [];
    const runtime = new CompanionAvailabilityRuntime({
      store,
      project: async snapshot => { projected.push(snapshot.state); return 'applied'; },
      now: vi.fn()
        .mockReturnValueOnce(10)
        .mockReturnValueOnce(20)
        .mockReturnValueOnce(30),
      queueReadBatchSize: 20,
      drainRetryDelayMs: TEST_DRAIN_RETRY_DELAY_MS,
    });

    await runtime.initialize();
    const outer = await runtime.begin('do_not_disturb');
    const inner = await runtime.begin('do_not_disturb');
    await inner.release();
    expect(runtime.snapshot().state).toBe('do_not_disturb');
    await outer.release();

    expect(runtime.snapshot().state).toBe('available');
    expect(projected).toEqual(['available', 'do_not_disturb', 'available']);
  });

  it('keeps DND above overlapping idle work and restores idle when DND ends', async () => {
    const runtime = new CompanionAvailabilityRuntime({
      store: new MemoryAvailabilityStore(),
      project: async () => 'applied',
      queueReadBatchSize: 20,
      drainRetryDelayMs: TEST_DRAIN_RETRY_DELAY_MS,
    });
    await runtime.initialize();
    const idle = await runtime.begin('idle');
    const protectedLease = await runtime.begin('do_not_disturb');
    expect(runtime.snapshot().state).toBe('do_not_disturb');
    await protectedLease.release();
    expect(runtime.snapshot().state).toBe('idle');
    await idle.release();
    expect(runtime.snapshot().state).toBe('available');
  });

  it('returns to available after failure and cancellation paths', async () => {
    const runtime = new CompanionAvailabilityRuntime({
      store: new MemoryAvailabilityStore(),
      project: async () => 'applied',
      queueReadBatchSize: 20,
      drainRetryDelayMs: TEST_DRAIN_RETRY_DELAY_MS,
    });
    await runtime.initialize();

    await expect(runtime.run('do_not_disturb', async () => {
      throw new Error('failed protected task');
    })).rejects.toThrow('failed protected task');
    expect(runtime.snapshot().state).toBe('available');

    const lease = await runtime.begin('do_not_disturb');
    await lease.release();
    await lease.release();
    expect(runtime.snapshot().state).toBe('available');
  });

  it('durably queues in FIFO order and acknowledges only after delivery succeeds', async () => {
    const store = new MemoryAvailabilityStore();
    const runtime = new CompanionAvailabilityRuntime({
      store,
      project: async () => 'applied',
      queueReadBatchSize: 20,
      drainRetryDelayMs: TEST_DRAIN_RETRY_DELAY_MS,
    });
    const delivered: string[] = [];
    runtime.setDeliverer(async queued => {
      delivered.push(queued.message.id);
      if (queued.message.id === 'two') throw new Error('transport down');
    });
    await runtime.initialize();
    const lease = await runtime.begin('do_not_disturb');

    await expect(runtime.enqueueIfUnavailable(message('one'))).resolves.toBe(true);
    await expect(runtime.enqueueIfUnavailable(message('two'))).resolves.toBe(true);
    await expect(runtime.enqueueIfUnavailable(message('three'))).resolves.toBe(true);
    expect(delivered).toEqual([]);

    await lease.release();
    await runtime.waitForDrain();

    expect(delivered).toEqual(['one', 'two']);
    expect(store.queued.map(entry => entry.message.id)).toEqual(['two', 'three']);
  });

  it('retries a retained row after a transient delivery failure', async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryAvailabilityStore();
      const runtime = new CompanionAvailabilityRuntime({
        store,
        project: async () => 'applied',
        queueReadBatchSize: 20,
        drainRetryDelayMs: TEST_DRAIN_RETRY_DELAY_MS,
      });
      const delivered: string[] = [];
      let failOnce = true;
      runtime.setDeliverer(async queued => {
        if (failOnce) {
          failOnce = false;
          throw new Error('transient transport failure');
        }
        delivered.push(queued.message.id);
      });
      await runtime.initialize();
      const lease = await runtime.begin('do_not_disturb');
      await runtime.enqueueIfUnavailable(message('older'));
      await lease.release();
      await runtime.waitForDrain();

      expect(store.queued.map(entry => entry.message.id)).toEqual(['older']);

      await vi.advanceTimersByTimeAsync(TEST_DRAIN_RETRY_DELAY_MS);
      await runtime.waitForDrain();

      expect(delivered).toEqual(['older']);
      expect(store.queued).toEqual([]);
      await runtime.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['enqueued', 'duplicate'] as const)(
    'drains a newer row after %s admission while the successful older drain finishes',
    async (outcome) => {
      const store = new MemoryAvailabilityStore();
      await store.enqueue(message('older'), 1);
      const admissionReachedEnqueue = deferred();
      const allowAdmissionCommit = deferred();
      const originalEnqueue = store.enqueue.bind(store);
      store.enqueue = vi.fn(async (queuedMessage, enqueuedAtMs) => {
        admissionReachedEnqueue.resolve();
        await allowAdmissionCommit.promise;
        const inserted = await originalEnqueue(queuedMessage, enqueuedAtMs);
        return outcome === 'duplicate' ? 'duplicate' : inserted;
      });
      const olderDeliveryStarted = deferred();
      const allowOlderDelivery = deferred();
      const drainObservedEmpty = deferred();
      const originalListPending = store.listPending.bind(store);
      let listCalls = 0;
      store.listPending = vi.fn(async (limit) => {
        const pending = await originalListPending(limit);
        listCalls += 1;
        if (listCalls === 2 && pending.length === 0) drainObservedEmpty.resolve();
        return pending;
      });
      const delivered: string[] = [];
      const runtime = new CompanionAvailabilityRuntime({
        store,
        project: async () => 'applied',
        queueReadBatchSize: 20,
        drainRetryDelayMs: TEST_DRAIN_RETRY_DELAY_MS,
      });
      runtime.setDeliverer(async queued => {
        delivered.push(queued.message.id);
        if (queued.message.id === 'older') {
          olderDeliveryStarted.resolve();
          await allowOlderDelivery.promise;
        }
      });

      await runtime.initialize();
      await olderDeliveryStarted.promise;
      const admission = runtime.enqueueIfUnavailable(message('newer'));
      await admissionReachedEnqueue.promise;

      allowOlderDelivery.resolve();
      await drainObservedEmpty.promise;
      allowAdmissionCommit.resolve();
      await expect(admission).resolves.toBe(true);
      await runtime.waitForDrain();

      expect(delivered).toEqual(['older', 'newer']);
      expect(store.queued).toEqual([]);
      await runtime.stop();
    },
  );

  it('retries a failed protected observation while live observation failures remain non-blocking', async () => {
    vi.useFakeTimers();
    let runtime: CompanionAvailabilityRuntime | undefined;
    try {
      const store = new MemoryAvailabilityStore();
      runtime = new CompanionAvailabilityRuntime({
        store,
        project: async () => 'applied',
        queueReadBatchSize: 20,
        drainRetryDelayMs: TEST_DRAIN_RETRY_DELAY_MS,
      });
      await runtime.initialize();
      let onDiscordMessage: ((message: SubstrateMessage) => void | Promise<void>) | undefined;
      const gateway: GatewayMessageGateway = {
        onHandleMessage: () => {},
        onDiscordMessage: handler => { onDiscordMessage = handler; },
        discordSend: async () => {},
        discordSendMedia: async () => {},
        onCompanionMessage: () => {},
        companionSend: async channelId => ({
          channelId,
          messageId: 'unused-companion-reply',
          deliveredTo: [],
          skippedOffline: [],
        }),
        companionSendInitiation: async input => ({
          channelId: input.channelId,
          messageId: 'unused-companion-initiation',
          deliveredTo: [],
          skippedOffline: [],
          permitOutcome: 'consumed',
        }),
        companionConsumeInitiationPermit: async () => ({ outcome: 'consumed' }),
        companionReportFailure: async () => undefined,
        onCompanionDeliveryFailure: () => {},
      };
      const observeMessage = vi.fn()
        .mockRejectedValueOnce(new Error('live observation failure'))
        .mockRejectedValueOnce(new Error('protected observation failure'))
        .mockResolvedValueOnce(undefined);
      const agentLoop: GatewayMessageAgentLoop = {
        handleMessage: async () => { throw new Error('reply path is not used'); },
        observeMessage,
        waitForIdle: async () => {},
        findRecordedIcpInitiation: async () => null,
        findIcpDeliveryObservation: async () => null,
        findRecordedCompanionSourceMessage: async () => null,
        recordIcpDeliveryObservation: async () => {},
      };
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      registerGatewayMessageHandlers({
        eventBus: new EventBus(),
        gateway,
        agentLoop,
        shardManager: { delegateSatelliteSession: async () => { throw new Error('unused'); } },
        safeguardAuditTrail: { append: vi.fn() },
        satelliteRouting: createNoopSatelliteRoutingPort(),
        config: { companionId: '11111111-1111-4111-8111-111111111111' } as SubstrateConfig,
        log,
        trackSessionActivity: vi.fn(),
        protectedMessageQueue: runtime,
      });
      expect(onDiscordMessage).toBeDefined();
      const liveMessage = {
        ...message('live-observation'),
        routing: { source: 'discord' as const, responseMode: 'observe' as const },
      };

      await expect(onDiscordMessage!(liveMessage)).resolves.toBeUndefined();
      expect(store.queued).toEqual([]);
      expect(log.error).toHaveBeenCalledWith('Error handling message', {
        channelId: 'discord-room',
        messageId: 'live-observation',
        error: 'live observation failure',
      });

      const lease = await runtime.begin('do_not_disturb');
      const protectedMessage = {
        ...message('protected-observation'),
        routing: { source: 'discord' as const, responseMode: 'observe' as const },
      };
      await onDiscordMessage!(protectedMessage);
      await lease.release();
      await runtime.waitForDrain();

      expect(observeMessage).toHaveBeenCalledTimes(2);
      expect(store.queued.map(entry => entry.message.id)).toEqual(['protected-observation']);
      expect(log.error).toHaveBeenCalledWith('Error handling message', {
        channelId: 'discord-room',
        messageId: 'protected-observation',
        error: 'protected observation failure',
      });

      await vi.advanceTimersByTimeAsync(TEST_DRAIN_RETRY_DELAY_MS);
      await runtime.waitForDrain();

      expect(observeMessage).toHaveBeenCalledTimes(3);
      expect(store.queued).toEqual([]);
    } finally {
      await runtime?.stop();
      vi.useRealTimers();
    }
  });

  it('resets stale protected state on restart and drains durable messages', async () => {
    const store = new MemoryAvailabilityStore();
    store.state = { state: 'do_not_disturb', sinceMs: 5, revision: 4 };
    await store.enqueue(message('before-restart'), 6);
    const delivered: string[] = [];
    const runtime = new CompanionAvailabilityRuntime({
      store,
      project: async () => 'applied',
      queueReadBatchSize: 20,
      drainRetryDelayMs: TEST_DRAIN_RETRY_DELAY_MS,
      now: () => 10,
    });
    runtime.setDeliverer(async queued => { delivered.push(queued.message.id); });

    await runtime.initialize();
    await runtime.waitForDrain();

    expect(store.state).toEqual({ state: 'available', sinceMs: 10, revision: 5 });
    expect(delivered).toEqual(['before-restart']);
    expect(store.queued).toEqual([]);
  });

  it('adds one bounded factual return context without exposing the private activity', async () => {
    const store = new MemoryAvailabilityStore();
    const delivered: SubstrateMessage[] = [];
    const runtime = new CompanionAvailabilityRuntime({
      store,
      project: async () => 'applied',
      queueReadBatchSize: 20,
      drainRetryDelayMs: TEST_DRAIN_RETRY_DELAY_MS,
      returnContextMaxChars: 12,
      now: vi.fn().mockReturnValueOnce(1).mockReturnValueOnce(2).mockReturnValueOnce(3),
    });
    runtime.setDeliverer(async queued => { delivered.push(queued.message); });
    await runtime.initialize();
    const lease = await runtime.begin('do_not_disturb');
    await runtime.enqueueIfUnavailable({ ...message('one'), content: 'first long message' });
    await runtime.enqueueIfUnavailable({ ...message('two'), content: 'second long message' });
    await lease.release();
    await runtime.waitForDrain();

    const context = delivered[0].routing?.protectedTimeReturn;
    expect(context).toMatchObject({ schemaVersion: 1, queuedCount: 2 });
    expect(context?.messages.map(entry => entry.excerpt).join('').length).toBeLessThanOrEqual(12);
    expect(delivered[1].routing?.protectedTimeReturn).toBeUndefined();
    expect(JSON.stringify(context)).not.toContain('do_not_disturb');
  });

  it('does not claim unavailable projection support when an adapter lacks it', async () => {
    const store = new MemoryAvailabilityStore();
    const degraded: CompanionAvailabilitySnapshot[] = [];
    const runtime = new CompanionAvailabilityRuntime({
      store,
      project: async () => 'unsupported',
      onProjectionDegraded: snapshot => { degraded.push(snapshot); },
      queueReadBatchSize: 20,
      drainRetryDelayMs: TEST_DRAIN_RETRY_DELAY_MS,
    });
    await runtime.initialize();
    const lease = await runtime.begin('idle');

    expect(degraded.at(-1)?.state).toBe('idle');
    expect(runtime.snapshot().state).toBe('idle');
    await lease.release();
  });

  it('keeps durable protection authoritative when channel projection fails', async () => {
    const projectionErrors: unknown[] = [];
    const runtime = new CompanionAvailabilityRuntime({
      store: new MemoryAvailabilityStore(),
      project: async snapshot => {
        if (snapshot.state === 'do_not_disturb') throw new Error('gateway disconnected');
        return 'applied';
      },
      onProjectionError: error => { projectionErrors.push(error); },
      queueReadBatchSize: 20,
      drainRetryDelayMs: TEST_DRAIN_RETRY_DELAY_MS,
    });
    await runtime.initialize();

    const lease = await runtime.begin('do_not_disturb');
    expect(runtime.snapshot().state).toBe('do_not_disturb');
    expect(projectionErrors).toHaveLength(1);
    await lease.release();
    expect(runtime.snapshot().state).toBe('available');
  });

  it('projects overlapping long main-thread tools as one idle availability window', async () => {
    const runtime = new CompanionAvailabilityRuntime({
      store: new MemoryAvailabilityStore(),
      project: async () => 'applied',
      queueReadBatchSize: 20,
      drainRetryDelayMs: TEST_DRAIN_RETRY_DELAY_MS,
    });
    await runtime.initialize();
    const eventBus = new EventBus();
    const detach = attachToolAvailability({
      eventBus,
      runtime,
      isLongRunningTool: name => name === 'analysis_workbench',
    });

    await eventBus.emit('agent.tool.start', {
      channelId: 'room', toolCallId: 'one', toolName: 'analysis_workbench',
    });
    await eventBus.emit('agent.tool.start', {
      channelId: 'room', toolCallId: 'two', toolName: 'analysis_workbench',
    });
    await eventBus.emit('agent.tool.end', {
      channelId: 'room', toolCallId: 'one', toolName: 'analysis_workbench', outcome: 'success', isError: false,
    });
    expect(runtime.snapshot().state).toBe('idle');
    await eventBus.emit('agent.tool.end', {
      channelId: 'room', toolCallId: 'two', toolName: 'analysis_workbench', outcome: 'success', isError: false,
    });
    expect(runtime.snapshot().state).toBe('available');
    await detach();
  });

  it('wraps scheduler-marked tasks for their complete handler lifetime', async () => {
    const order: string[] = [];
    const scheduler = new Scheduler(new EventBus(), {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 500,
    }, {
      runProtectedTask: async (state, handler) => {
        order.push(`begin:${state}`);
        try { await handler(); } finally { order.push(`end:${state}`); }
      },
    });
    scheduler.register({
      id: 'protected',
      name: 'Protected',
      type: 'every',
      intervalMs: 1_000,
      availability: 'do_not_disturb',
      handler: () => { order.push('handler'); },
      state: 'idle',
    });

    await scheduler.tick();
    expect(order).toEqual(['begin:do_not_disturb', 'handler', 'end:do_not_disturb']);
  });

  it('keeps DND for a detached durable claim until its executor settles', async () => {
    const availability = new CompanionAvailabilityRuntime({
      store: new MemoryAvailabilityStore(),
      project: async () => 'applied',
      queueReadBatchSize: 20,
      drainRetryDelayMs: TEST_DRAIN_RETRY_DELAY_MS,
    });
    await availability.initialize();
    const executorStarted = deferred();
    const executorFinished = deferred();
    let claimed = false;
    const claimedJob = {
      jobId: 'job-1',
      logicalSessionId: 'session-1',
      kind: 'memory_extraction',
    } as unknown as ClaimedBackgroundWorkJob;
    const store = {
      recoverExpired: vi.fn(async () => []),
      purgeTerminal: vi.fn(async () => []),
      claimNext: vi.fn(async () => {
        if (claimed) return null;
        claimed = true;
        return claimedJob;
      }),
      requeuePreBoundaryClaims: vi.fn(async () => []),
    } as unknown as BackgroundWorkStorePort;
    const supervisor = new BackgroundWorkSupervisor({
      store,
      eventBus: new EventBus(),
      executor: async () => {},
      maxConcurrentSessions: 1,
      leaseDurationMs: 300_000,
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs: 300_000,
      shutdownTimeoutMs: 5_000,
      terminalRetentionMs: 604_800_000,
      cleanupIntervalMs: 3_600_000,
      welfare: { deferThreshold: 8, ageThresholdMs: 300_000, reserveSlots: 1 },
    });
    const execution = supervisor as unknown as {
      executeClaim: (...args: unknown[]) => Promise<void>;
    };
    execution.executeClaim = vi.fn(async () => {
      executorStarted.resolve();
      await executorFinished.promise;
    });
    supervisor.setExecutionScope(handler => availability.run('do_not_disturb', handler));

    const claimPass = supervisor.tick();
    await executorStarted.promise;
    await claimPass;
    expect(availability.snapshot().state).toBe('do_not_disturb');

    executorFinished.resolve();
    await supervisor.waitForIdle();
    expect(availability.snapshot().state).toBe('available');
    await supervisor.stop();
    await availability.stop();
  });

  it('defines a singleton coarse state and ordered idempotent Postgres queue', () => {
    const sql = POSTGRES_COMPANION_AVAILABILITY_MIGRATIONS.join('\n');
    expect(sql).toContain('companion_availability_state');
    expect(sql).toContain("CHECK (state IN ('available', 'idle', 'do_not_disturb'))");
    expect(sql).toContain('companion_protected_message_queue');
    expect(sql).toContain('BIGSERIAL PRIMARY KEY');
    expect(sql).toContain('UNIQUE (channel_id, message_id)');
  });
});
