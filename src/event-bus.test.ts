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
});
