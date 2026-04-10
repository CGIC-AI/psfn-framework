import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import { Scheduler } from '../../core/scheduler/scheduler.js';
import { buildApiHealthChecks } from './api-surface.js';

describe('buildApiHealthChecks', () => {
  const runtimeStatusMeta = {
    activeMode: 'split',
    restartStrategy: 'command',
    restartCommandSource: 'explicit',
    restartCommand: 'npm run split:debug',
  } as const;

  function buildSchedulerCheck(scheduler: Scheduler) {
    const checks = buildApiHealthChecks(
      {
        config: {
          primaryModel: 'openrouter/moonshotai/kimi-k2.5',
          primaryProvider: 'openrouter',
          modelRoster: {},
        } as any,
        memoryStore: {
          getStats: async () => ({ total: 0, avgSalience: 0 }),
        } as any,
        gateway: {
          dims: 384,
        } as any,
        scheduler,
        runtimeStatusMeta,
      },
      {
        enabled: false,
        timeoutMs: 10_000,
        cacheTtlMs: 10_000,
      },
    );
    return checks.scheduler;
  }

  it('reports scheduler healthy when the heartbeat task is registered', () => {
    const scheduler = new Scheduler(new EventBus(), {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 500,
    });
    scheduler.registerHeartbeat(() => {});

    const result = buildSchedulerCheck(scheduler)();

    expect(result).toMatchObject({
      status: 'healthy',
      meta: {
        taskCount: 1,
        heartbeatTaskRegistered: true,
        activeMode: 'split',
      },
    });
  });

  it('keeps scheduler healthy when tasks are present but no heartbeat task is registered', () => {
    const scheduler = new Scheduler(new EventBus(), {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 500,
    });
    scheduler.register({
      id: 'reflection',
      name: 'Reflection',
      type: 'every',
      intervalMs: 5_000,
      run: async () => {},
      state: 'active',
    });

    const result = buildSchedulerCheck(scheduler)();

    expect(result).toMatchObject({
      status: 'healthy',
      meta: {
        taskCount: 1,
        heartbeatTaskRegistered: false,
        activeMode: 'split',
      },
    });
  });

  it('reports scheduler degraded only when no tasks are registered at all', () => {
    const scheduler = new Scheduler(new EventBus(), {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 500,
    });

    const result = buildSchedulerCheck(scheduler)();

    expect(result).toMatchObject({
      status: 'degraded',
      detail: 'No scheduler tasks are registered',
      meta: {
        taskCount: 0,
        heartbeatTaskRegistered: false,
        activeMode: 'split',
      },
    });
  });

  it('reports the reasoning probe slot and resolved backend route in llm health metadata', async () => {
    const gateway = {
      dims: 384,
      complete: vi.fn(async () => ({
        content: 'OK',
        toolCalls: [],
        model: 'openrouter/moonshotai/kimi-k2.5',
        inputTokens: 5,
        outputTokens: 1,
        stopReason: 'stop',
        providerObservability: {
          routeKind: 'registered_model',
          requestedProvider: 'openrouter',
          requestedModel: 'openrouter/moonshotai/kimi-k2.5',
          backendProvider: 'openrouter',
          backendModel: 'moonshotai/kimi-k2.5',
          backendApi: 'chat.completions',
          systemRole: {
            transport: 'openai_system',
            supportsSystemRole: true,
            supportsDeveloperRole: true,
            usesOutOfBandSystemPrompt: false,
          },
          promptCaching: {
            configured: false,
            engaged: false,
            reason: 'disabled',
          },
          providerWireMessages: [],
        },
      })),
    } as any;

    const checks = buildApiHealthChecks(
      {
        config: {
          primaryModel: 'openrouter/z-ai/glm-5',
          primaryProvider: 'openrouter',
          modelRoster: {
            chat: {
              model: 'openrouter/z-ai/glm-5',
              provider: 'openrouter',
              maxTokens: 4096,
            },
            reasoning: {
              model: 'openrouter/moonshotai/kimi-k2.5',
              provider: 'openrouter',
              maxTokens: 4096,
            },
          },
        } as any,
        memoryStore: {
          getStats: async () => ({ total: 0, avgSalience: 0 }),
        } as any,
        gateway,
        scheduler: new Scheduler(new EventBus(), {
          tickIntervalMs: 100,
          heartbeatIntervalMs: 500,
        }),
        runtimeStatusMeta,
      },
      {
        enabled: true,
        timeoutMs: 10_000,
        cacheTtlMs: 0,
      },
    );

    const result = await checks.llm();

    expect(gateway.complete).toHaveBeenCalledWith(
      expect.any(Object),
      'reasoning',
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
    expect(result).toMatchObject({
      status: 'healthy',
      meta: {
        provider: 'openrouter',
        model: 'openrouter/moonshotai/kimi-k2.5',
        probePurpose: 'reasoning',
        probeSlot: 'reasoning',
        requestedProvider: 'openrouter',
        requestedModel: 'openrouter/moonshotai/kimi-k2.5',
        resolvedProvider: 'openrouter',
        resolvedModel: 'moonshotai/kimi-k2.5',
        resolvedBackendApi: 'chat.completions',
        resolvedRouteKind: 'registered_model',
        responseModel: 'openrouter/moonshotai/kimi-k2.5',
      },
    });
  });
});
