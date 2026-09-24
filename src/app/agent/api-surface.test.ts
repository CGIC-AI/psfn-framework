import { describe, expect, it, vi } from 'vitest';
import { fromPartial } from '@total-typescript/shoehorn';
import { EventBus } from '../../shared/event-bus.js';
import { Scheduler } from '../../core/scheduler/scheduler.js';
import { buildApiHealthChecks } from './api-surface.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { MemoryStorePort } from '../../faculties/memory/memory-store-port.js';
import type { GatewayClient } from '../../boundary/gateway/client.js';
import type { RuntimeStatusMetadata } from '../../system/lifecycle/runtime-mode.js';
import { JSONRPCErrorException } from 'json-rpc-2.0';
import { GatewayErrors } from '../../boundary/gateway/protocol.js';

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
        config: fromPartial<SubstrateConfig>({
          primaryModel: 'openrouter/moonshotai/kimi-k2.5',
          primaryProvider: 'openrouter',
          modelRoster: {},
        }),
        memoryStore: fromPartial<MemoryStorePort>({
          getStats: async () => ({ total: 0, avgSalience: 0 }),
        }),
        gateway: fromPartial<GatewayClient>({
          dims: 384,
        }),
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

  it('reports durable optional PostgreSQL degradation while the workload remains runtime-ready', async () => {
    const scheduler = new Scheduler(new EventBus(), {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 500,
    });
    const checks = buildApiHealthChecks(
      {
        config: fromPartial<SubstrateConfig>({
          primaryModel: 'openrouter/moonshotai/kimi-k2.5',
          primaryProvider: 'openrouter',
          modelRoster: {},
        }),
        memoryStore: fromPartial<MemoryStorePort>({
          getStats: async () => ({ total: 4, avgSalience: 0.5 }),
        }),
        gateway: fromPartial<GatewayClient>({ dims: 384 }),
        scheduler,
        runtimeStatusMeta,
        postgresReadiness: () => ({
          phase: 'ready',
          pending: [],
          readyStores: ['memory'],
          degraded: [{
            store: 'analysis_workbench_trace',
            label: 'analysis workbench trace',
            requirement: 'optional',
            mismatch: 'migration role cannot create relation',
          }],
        }),
      },
      { enabled: false, timeoutMs: 10_000, cacheTtlMs: 10_000 },
    );

    await expect(checks.memory?.()).resolves.toMatchObject({
      status: 'healthy',
      meta: {
        total: 4,
        postgresReadiness: {
          phase: 'ready',
          status: 'degraded',
          degradedStores: [{
            store: 'analysis_workbench_trace',
            label: 'analysis workbench trace',
          }],
        },
      },
    });
  });

  function buildDiscordCheck(activeMode: string) {
    const checks = buildApiHealthChecks(
      {
        config: fromPartial<SubstrateConfig>({
          primaryModel: 'openrouter/moonshotai/kimi-k2.5',
          primaryProvider: 'openrouter',
          modelRoster: {},
        }),
        memoryStore: fromPartial<MemoryStorePort>({
          getStats: async () => ({ total: 0, avgSalience: 0 }),
        }),
        gateway: fromPartial<GatewayClient>({ dims: 384 }),
        scheduler: new Scheduler(new EventBus(), {
          tickIntervalMs: 100,
          heartbeatIntervalMs: 500,
        }),
        runtimeStatusMeta: fromPartial<RuntimeStatusMetadata>({ ...runtimeStatusMeta, activeMode }),
      },
      { enabled: false, timeoutMs: 10_000, cacheTtlMs: 10_000 },
    );
    return checks.discord;
  }

  it('reports Discord as delegated (healthy, not-applicable) in a split runtime topology', () => {
    const result = buildDiscordCheck('split')();

    expect(result).toMatchObject({
      status: 'healthy',
      detail: 'Discord transport is delegated to the gateway (not applicable to the agent container)',
      meta: {
        activeMode: 'split',
        delegated: true,
      },
    });
  });

  it('reports Discord as delegated in the gateway-agent runtime topology', () => {
    const result = buildDiscordCheck('gateway-agent')();

    expect(result).toMatchObject({
      status: 'healthy',
      meta: {
        activeMode: 'gateway-agent',
        delegated: true,
      },
    });
  });

  function buildProbeChecks(gateway: GatewayClient) {
    return buildApiHealthChecks(
      {
        config: fromPartial<SubstrateConfig>({
          primaryModel: 'openrouter/z-ai/glm-5',
          primaryProvider: 'openrouter',
          modelRoster: {
            chat: { model: 'openrouter/z-ai/glm-5', provider: 'openrouter', maxTokens: 4096 },
            reasoning: {
              model: 'openrouter/moonshotai/kimi-k2.5',
              provider: 'openrouter',
              maxTokens: 4096,
            },
          },
        }),
        memoryStore: fromPartial<MemoryStorePort>({
          getStats: async () => ({ total: 0, avgSalience: 0 }),
        }),
        gateway,
        scheduler: new Scheduler(new EventBus(), { tickIntervalMs: 100, heartbeatIntervalMs: 500 }),
        runtimeStatusMeta,
      },
      { enabled: true, timeoutMs: 10_000, cacheTtlMs: 0 },
    );
  }

  it('checks llm health through token-free model discovery, never a completion', async () => {
    const complete = vi.fn();
    const chat = vi.fn();
    const gateway = fromPartial<GatewayClient>({
      dims: 384,
      complete,
      chat,
      getAvailableModels: vi.fn(async () => [{ id: 'moonshotai/kimi-k2.5' }, { id: 'z-ai/glm-5' }]),
    });

    const result = await buildProbeChecks(gateway).llm();

    expect(gateway.getAvailableModels).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'healthy',
      meta: {
        provider: 'openrouter',
        model: 'openrouter/moonshotai/kimi-k2.5',
        probeKind: 'model_discovery',
        probeSlot: 'reasoning',
        gatewayReachable: true,
        discovery: 'listed',
        discoveredModelCount: 2,
        modelListed: true,
      },
    });
  });

  it('reports an unlisted route model as metadata without degrading llm health', async () => {
    const gateway = fromPartial<GatewayClient>({
      dims: 384,
      getAvailableModels: vi.fn(async () => [{ id: 'other/model' }]),
    });

    await expect(buildProbeChecks(gateway).llm()).resolves.toMatchObject({
      status: 'healthy',
      meta: { modelListed: false, discoveredModelCount: 1 },
    });
  });

  it('keeps llm healthy with an unconfigured discovery catalog when the gateway answers', async () => {
    const gateway = fromPartial<GatewayClient>({
      dims: 384,
      getAvailableModels: vi.fn(async () => {
        throw new JSONRPCErrorException(
          'Gateway model discovery is unavailable.',
          GatewayErrors.MODEL_DISCOVERY_UNCONFIGURED,
        );
      }),
    });

    await expect(buildProbeChecks(gateway).llm()).resolves.toMatchObject({
      status: 'healthy',
      meta: { gatewayReachable: true, discovery: 'unconfigured' },
    });
  });

  it('degrades llm but reports the gateway reachable when provider discovery fails behind it', async () => {
    const gateway = fromPartial<GatewayClient>({
      dims: 384,
      getAvailableModels: vi.fn(async () => {
        throw new JSONRPCErrorException('OpenRouter models API returned 503', 0);
      }),
    });

    await expect(buildProbeChecks(gateway).llm()).resolves.toMatchObject({
      status: 'degraded',
      detail: 'OpenRouter models API returned 503',
      meta: { gatewayReachable: true },
    });
  });

  it('degrades llm and reports the gateway unreachable when the transport fails', async () => {
    const gateway = fromPartial<GatewayClient>({
      dims: 384,
      getAvailableModels: vi.fn(async () => {
        throw new Error('Gateway connection closed');
      }),
    });

    await expect(buildProbeChecks(gateway).llm()).resolves.toMatchObject({
      status: 'degraded',
      detail: 'Gateway connection closed',
      meta: { gatewayReachable: false },
    });
  });

  it('checks embeddings from configuration only, never an embedding request', () => {
    const embed = vi.fn();
    const gateway = fromPartial<GatewayClient>({ dims: 384, embed });

    expect(buildProbeChecks(gateway).embeddings()).toMatchObject({
      status: 'healthy',
      meta: { dims: 384, probeMode: 'configuration' },
    });
    expect(embed).not.toHaveBeenCalled();
  });

  it('degrades embeddings when configured dimensions are invalid', () => {
    const gateway = fromPartial<GatewayClient>({ dims: 0, embed: vi.fn() });

    expect(buildProbeChecks(gateway).embeddings()).toMatchObject({
      status: 'degraded',
      detail: 'Embedding dimensions are invalid',
    });
  });
});
