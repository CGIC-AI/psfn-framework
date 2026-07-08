import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../../shared/event-bus.js';
import { AdminDashboardDataService } from './dashboard-service.js';
import type { MemoryStorePort } from '../../../faculties/memory/memory-store-port.js';
import type { Scheduler } from '../../../core/scheduler/scheduler.js';
import type { SessionStore } from '../../../persistence/sessions/store.js';
import type { ShardExecutionPort } from '../../../faculties/shards/port.js';
import type { AdminAdaptiveToolsService } from './types.js';

describe('AdminDashboardDataService', () => {
  it('reads shard status through the shard execution port', async () => {
    const memoryStore = {
      getStats: () => ({
        total: 0,
        avgSalience: 0,
        byType: {},
      }),
    } as MemoryStorePort;
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
      delegateSatelliteSession: vi.fn(async () => {
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

    const dashboard = await service.getDashboardData();
    expect(dashboard.stats.activeShards).toBe(2);
    expect(shardManager.getActiveCount).toHaveBeenCalledTimes(1);
  });

  it('surfaces tool health and first-token latency on the dashboard', async () => {
    const eventBus = new EventBus();
    const memoryStore = {
      getStats: () => ({
        total: 0,
        avgSalience: 0,
        byType: {},
      }),
    } as MemoryStorePort;
    const sessionStore = {
      listChannels: () => [],
      getLatestSessionByTimestamp: () => null,
    } as SessionStore;
    const scheduler = {
      taskCount: 0,
    } as Scheduler;
    const shardManager = {
      getActiveCount: vi.fn(() => 0),
      getActiveShards: vi.fn(() => []),
    } as unknown as ShardExecutionPort;
    const adaptiveToolsService = {
      getAdaptiveToolsData: vi.fn(async () => ({
        state: null,
        catalog: null,
        serviceHealth: [],
        toolHealth: [
          {
            name: 'memory',
            description: 'memory tool',
            scope: 'extended',
            health: { status: 'healthy', detail: 'ready' },
            contexts: {
              chat: { status: 'active', detail: 'active' },
              internalHeartbeat: { status: 'active', detail: 'active' },
            },
          },
          {
            name: 'orient',
            description: 'orient tool',
            scope: 'core',
            health: { status: 'degraded', detail: 'last call timed out' },
            contexts: {
              chat: { status: 'active', detail: 'core' },
              internalHeartbeat: { status: 'active', detail: 'core' },
            },
          },
        ],
        inventory: [],
        recentFailures: [],
        recentTelemetry: [],
      })),
    } satisfies AdminAdaptiveToolsService;

    const service = new AdminDashboardDataService({
      memoryStore,
      sessionStore,
      scheduler,
      shardManager,
      eventBus,
      adaptiveToolsService,
    });

    await eventBus.emit('agent.turn.stage', {
      turnId: 'turn-1',
      channelId: 'chat',
      stage: 'first-token',
      elapsedMs: 1_200,
      ttftMs: 1_200,
    });
    await eventBus.emit('agent.turn.stage', {
      turnId: 'turn-2',
      channelId: 'chat',
      stage: 'first-token',
      elapsedMs: 800,
      ttftMs: 800,
    });

    const dashboard = await service.getDashboardData();

    expect(dashboard.stats.sessionUsage.lastTtftMs).toBe(800);
    expect(dashboard.stats.sessionUsage.averageTtftMs).toBe(1_000);
    expect(dashboard.stats.toolStatus).toEqual([
      { name: 'orient', status: 'degraded', detail: 'last call timed out' },
      { name: 'memory', status: 'healthy', detail: 'ready' },
    ]);
  });
});
