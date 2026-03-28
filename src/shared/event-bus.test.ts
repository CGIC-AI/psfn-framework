import { describe, it, expect, vi } from 'vitest';
import { EventBus } from './event-bus.js';

describe('EventBus', () => {
  it('emits events to handlers', async () => {
    const bus = new EventBus();
    const handler = vi.fn();

    bus.on('system.ready', handler);
    await bus.emit('system.ready', {});

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({});
  });

  it('supports once handlers', async () => {
    const bus = new EventBus();
    const handler = vi.fn();

    bus.once('system.ready', handler);
    await bus.emit('system.ready', {});
    await bus.emit('system.ready', {});

    expect(handler).toHaveBeenCalledOnce();
  });

  it('supports off', async () => {
    const bus = new EventBus();
    const handler = vi.fn();

    bus.on('system.ready', handler);
    bus.off('system.ready', handler);
    await bus.emit('system.ready', {});

    expect(handler).not.toHaveBeenCalled();
  });

  it('returns unsubscribe function from on()', async () => {
    const bus = new EventBus();
    const handler = vi.fn();

    const unsub = bus.on('system.ready', handler);
    unsub();
    await bus.emit('system.ready', {});

    expect(handler).not.toHaveBeenCalled();
  });

  it('guards can cancel events', async () => {
    const bus = new EventBus();
    const handler = vi.fn();

    bus.on('system.ready', handler);
    bus.guard('system.ready', () => false);
    await bus.emit('system.ready', {});

    expect(handler).not.toHaveBeenCalled();
  });

  it('guards that return true allow events', async () => {
    const bus = new EventBus();
    const handler = vi.fn();

    bus.on('system.ready', handler);
    bus.guard('system.ready', () => true);
    await bus.emit('system.ready', {});

    expect(handler).toHaveBeenCalledOnce();
  });

  it('one handler error does not kill others', async () => {
    const bus = new EventBus();
    const handler1 = vi.fn(() => { throw new Error('boom'); });
    const handler2 = vi.fn();

    bus.on('system.ready', handler1);
    bus.on('system.ready', handler2);

    // Should not throw
    await bus.emit('system.ready', {});

    expect(handler1).toHaveBeenCalled();
    expect(handler2).toHaveBeenCalled();
  });

  it('removeAllListeners clears everything', async () => {
    const bus = new EventBus();
    const handler = vi.fn();

    bus.on('system.ready', handler);
    bus.removeAllListeners();
    await bus.emit('system.ready', {});

    expect(handler).not.toHaveBeenCalled();
  });

  it('supports voice partial transcript events', async () => {
    const bus = new EventBus();
    const handler = vi.fn();

    bus.on('channel.voice.transcript.partial', handler);
    await bus.emit('channel.voice.transcript.partial', {
      guildId: 'g-1',
      channelId: 'c-1',
      userId: 'u-1',
      transcript: 'hel',
      confidence: 0.8,
      startMs: 10,
      endMs: 40,
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      transcript: 'hel',
      confidence: 0.8,
    }));
  });

  it('supports Wyoming policy telemetry events', async () => {
    const bus = new EventBus();
    const handler = vi.fn();

    bus.on('wyoming.policy.violation', handler);
    await bus.emit('wyoming.policy.violation', {
      connectionId: 'conn-1',
      scope: 'runtime',
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'session exceeded rate limit',
      sessionId: 's-1',
      eventType: 'audio.chunk',
      limit: 120,
      observed: 121,
      action: 'error_frame',
      timestampMs: 123,
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: 'conn-1',
      code: 'RATE_LIMIT_EXCEEDED',
      scope: 'runtime',
    }));
  });
});
