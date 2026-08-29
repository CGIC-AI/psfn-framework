import { describe, expect, it, vi } from 'vitest';

import { EventBus } from '../../../shared/event-bus.js';
import {
  wireFleetMaintenanceForegroundPreemption,
} from './fleet-maintenance-runtime.js';

const MESSAGE = {
  id: 'message-1',
  channelId: 'discord:dm:1',
  channelType: 'discord' as const,
  authorId: 'human-1',
  authorName: 'Human',
  content: 'Hello',
  timestamp: new Date('2026-08-29T09:00:00.000Z'),
};

describe('fleet maintenance runtime composition', () => {
  it('lets foreground turns request a safe-boundary yield without gating the turn', async () => {
    const eventBus = new EventBus();
    const requestForegroundPreemption = vi.fn(async () => true);
    const detach = wireFleetMaintenanceForegroundPreemption({
      eventBus,
      coordinator: { requestForegroundPreemption },
      now: () => Date.parse('2026-08-29T09:00:01.000Z'),
    });

    await eventBus.emit('agent.turn.start', {
      message: MESSAGE,
      runtimeLaneClass: 'foreground_chat',
    });
    await eventBus.emit('agent.turn.start', {
      message: MESSAGE,
      runtimeLaneClass: 'maintenance_reflection',
    });

    expect(requestForegroundPreemption).toHaveBeenCalledOnce();
    expect(requestForegroundPreemption).toHaveBeenCalledWith({
      nowMs: Date.parse('2026-08-29T09:00:01.000Z'),
    });
    detach();
  });

  it('requests the scope holder even when foreground starts on a different companion', async () => {
    const eventBus = new EventBus();
    const requestForegroundPreemption = vi.fn(async () => true);
    const detach = wireFleetMaintenanceForegroundPreemption({
      eventBus,
      coordinator: { requestForegroundPreemption },
      now: () => Date.parse('2026-08-29T09:05:01.000Z'),
    });

    await expect(eventBus.emit('agent.turn.start', {
      message: { ...MESSAGE, authorId: 'human-on-another-fleet-companion' },
      runtimeLaneClass: 'foreground_chat',
    })).resolves.toBeUndefined();
    expect(requestForegroundPreemption).toHaveBeenCalledWith({
      nowMs: Date.parse('2026-08-29T09:05:01.000Z'),
    });
    detach();
  });
});
