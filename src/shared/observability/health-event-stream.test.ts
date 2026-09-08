import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../event-bus.js';
import {
  createHealthEvent,
  processObserverId,
  type HealthEvent,
} from '../contracts/health-event.js';
import {
  subscribeHealthEventStream,
  type HealthEventQuery,
  type HealthEventStorePort,
} from './health-event-stream.js';

function healthEvent(): HealthEvent {
  return createHealthEvent({
    owner: { kind: 'system' },
    severity: 'critical',
    code: 'operator_alert_sinks_unconfigured',
    provenance: {
      process: 'gateway',
      component: 'operator_alerting',
      observerId: processObserverId(),
    },
    observedAtMs: 1_800_000_000_000,
    evidence: { configuredSinkCount: 0 },
  });
}

function recordingStore(behavior: { failWith?: Error } = {}): HealthEventStorePort & {
  recorded: HealthEvent[];
} {
  const recorded: HealthEvent[] = [];
  return {
    recorded,
    record: async (event) => {
      await Promise.resolve();
      if (behavior.failWith) throw behavior.failWith;
      recorded.push(event);
    },
    listRecent: async (_query?: HealthEventQuery) => {
      await Promise.resolve();
      return [...recorded];
    },
    close: async () => { await Promise.resolve(); },
  };
}

describe('subscribeHealthEventStream', () => {
  it('persists exactly the envelope and drops the bus correlation metadata', async () => {
    const bus = new EventBus();
    const store = recordingStore();
    subscribeHealthEventStream({ eventBus: bus, store });

    const event = healthEvent();
    // Correlation metadata on the bus carries session/channel/viewer ids that
    // must never reach the stream. Only `data.event` may be persisted.
    await bus.emit('runtime.health.event', {
      event,
      sessionId: 'session-abc',
      channelId: 'channel-xyz',
      viewerAuthorId: 'discord-user-1234',
      viewerMemorySubjectContactId: 'contact-9',
      callType: 'chat',
      purpose: 'operator_alerting_check',
    });

    expect(store.recorded).toHaveLength(1);
    expect(store.recorded[0]).toEqual(event);
    const serialized = JSON.stringify(store.recorded[0]);
    for (const identifier of [
      'session-abc',
      'channel-xyz',
      'discord-user-1234',
      'contact-9',
      'operator_alerting_check',
    ]) {
      expect(serialized).not.toContain(identifier);
    }
  });

  it('loses observations emitted before it is subscribed', async () => {
    // Documents why both entrypoints subscribe the sink before their first
    // emitter runs: EventBus.emit is silent with no handler.
    const bus = new EventBus();
    const store = recordingStore();
    await bus.emit('runtime.health.event', { event: healthEvent() });
    expect(store.recorded).toEqual([]);

    subscribeHealthEventStream({ eventBus: bus, store });
    await bus.emit('runtime.health.event', { event: healthEvent() });
    expect(store.recorded).toHaveLength(1);
  });

  it('contains and logs a persistence failure instead of failing the emitter', async () => {
    const bus = new EventBus();
    const store = recordingStore({ failWith: new Error('connection refused') });
    subscribeHealthEventStream({ eventBus: bus, store });

    await expect(bus.emit('runtime.health.event', { event: healthEvent() })).resolves.toBeUndefined();
    expect(store.recorded).toEqual([]);
  });

  it('fails closed on an envelope that never went through the contract', async () => {
    const bus = new EventBus();
    const store = recordingStore();
    const record = vi.spyOn(store, 'record');
    subscribeHealthEventStream({ eventBus: bus, store });

    // A forged payload reaching the bus is rejected before any write. The bus
    // isolates the throw, so the emitter still sees a resolved emit.
    await bus.emit('runtime.health.event', {
      event: { ...healthEvent(), code: 'everything_broke' } as unknown as HealthEvent,
    });
    expect(record).not.toHaveBeenCalled();
  });

  it('detaches on unsubscribe so shutdown stops writing', async () => {
    const bus = new EventBus();
    const store = recordingStore();
    const detach = subscribeHealthEventStream({ eventBus: bus, store });
    await bus.emit('runtime.health.event', { event: healthEvent() });
    detach();
    await bus.emit('runtime.health.event', { event: healthEvent() });
    expect(store.recorded).toHaveLength(1);
  });
});
