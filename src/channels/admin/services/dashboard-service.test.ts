import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../../event-bus.js';
import { AdminDashboardDataService } from './dashboard-service.js';
import type { MemoryStore } from '../../../memory/store.js';
import type { Scheduler } from '../../../scheduler/scheduler.js';
import type { SessionStore } from '../../../session/store.js';
import type { ShardExecutionPort } from '../../../shards/port.js';

describe('AdminDashboardDataService', () => {
  it('reads shard status through the shard execution port', () => {
    const memoryStore = {
      getStats: () => ({
        total: 0,
        avgSalience: 0,
        byType: {},
      }),
    } as MemoryStore;
    const sessionStore = {
      listChannels: () => [],
      getLatestSessionByTimestamp: () => null,
    } as SessionStore;
    const scheduler = {
      taskCount: 0,
    } as Scheduler;
    const shardManager: ShardExecutionPort = {
      spawn: vi.fn(async () => {
        throw new Error('spawn should not be used by dashboard inspection');
      }),
      delegateWyomingSession: vi.fn(async () => {
        throw new Error('delegate should not be used by dashboard inspection');
      }),
      getActiveCount: vi.fn(() => 2),
      getActiveShards: vi.fn(() => [
        {
          id: 'shard-1',
          name: 'alpha',
          task: 'inspect',
          startedAt: 1,
          channelId: 'shard:shard-1',
          state: 'ready',
          stateReason: 'agent_initialized',
          health: 'healthy',
          lastTransitionAt: 1,
          lastHeartbeatAt: 1,
          heartbeatStaleAfterMs: 60_000,
          heartbeatDisconnectAfterMs: 180_000,
          capabilities: ['general'],
          requiredCapabilities: [],
        },
        {
          id: 'shard-2',
          name: 'beta',
          task: 'inspect',
          startedAt: 2,
          channelId: 'shard:shard-2',
          state: 'degraded',
          stateReason: 'heartbeat_stale',
          health: 'stale',
          lastTransitionAt: 2,
          lastHeartbeatAt: 2,
          heartbeatStaleAfterMs: 60_000,
          heartbeatDisconnectAfterMs: 180_000,
          capabilities: ['general'],
          requiredCapabilities: [],
          failureReason: 'late heartbeat',
        },
      ]),
    };

    const service = new AdminDashboardDataService({
      memoryStore,
      sessionStore,
      scheduler,
      shardManager,
      eventBus: new EventBus(),
    });

    const dashboard = service.getDashboardData();
    expect(dashboard.stats.activeShards).toBe(2);
    expect(shardManager.getActiveCount).toHaveBeenCalledTimes(1);
  });
});
