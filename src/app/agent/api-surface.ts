import {
  CachedActiveHealthProbe,
  resolveActiveHealthProbeConfig,
  toActiveProbeMeta,
} from '../../channels/api/active-health-probe.js';
import type { GatewayClient } from '../../boundary/gateway/client.js';
import type { MemoryStorePort } from '../../faculties/memory/memory-store-port.js';
import type { Scheduler } from '../../core/scheduler/scheduler.js';
import { parseOptionalPositiveIntEnv } from '../../shared/utils/env.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { RuntimeStatusMetadata } from '../../system/lifecycle/runtime-mode.js';
import type { ApiServerConfig } from '../../channels/api/server.js';

export interface AgentApiSurfaceBindings {
  apiHost?: string;
  apiPort?: number;
  adminPort?: number;
}

export function buildApiHealthChecks(
  options: {
    config: SubstrateConfig;
    memoryStore: MemoryStorePort;
    gateway: GatewayClient;
    scheduler: Scheduler;
    runtimeStatusMeta: RuntimeStatusMetadata;
  },
  activeProbeConfig: ReturnType<typeof resolveActiveHealthProbeConfig>,
): NonNullable<ApiServerConfig['healthChecks']> {
  const llmActiveProbe = new CachedActiveHealthProbe(activeProbeConfig);
  const embeddingsActiveProbe = new CachedActiveHealthProbe(activeProbeConfig);

  return {
    memory: async () => {
      const stats = await options.memoryStore.getStats();
      return {
        status: 'healthy',
        meta: {
          total: stats.total,
          avgSalience: Number(stats.avgSalience.toFixed(4)),
          ...options.runtimeStatusMeta,
        },
      };
    },
    llm: async () => {
      const configured = Boolean(options.config.primaryModel && options.config.primaryProvider);
      const baseMeta = {
        provider: options.config.primaryProvider,
        model: options.config.primaryModel,
        ...toActiveProbeMeta(activeProbeConfig),
        ...options.runtimeStatusMeta,
      };

      if (!configured) {
        return {
          status: 'degraded',
          detail: 'Primary model/provider is not configured',
          meta: baseMeta,
        };
      }

      if (!activeProbeConfig.enabled) {
        return {
          status: 'healthy',
          meta: baseMeta,
        };
      }

      const probeResult = await llmActiveProbe.run(async (signal) => {
        await options.gateway.complete(
          {
            systemPrompt: 'You are a health check. Respond with exactly: OK',
            messages: [{ role: 'user', content: 'health probe' }],
          },
          'reasoning',
          { signal },
        );
      });
      const meta = {
        ...baseMeta,
        ...toActiveProbeMeta(activeProbeConfig, probeResult),
      };

      if (!probeResult.ok) {
        return {
          status: 'degraded',
          detail: probeResult.reason ?? 'LLM connectivity probe failed',
          meta,
        };
      }

      return {
        status: 'healthy',
        meta,
      };
    },
    discord: () => ({
      status: 'degraded',
      detail: 'Discord transport runs outside the agent container',
      meta: options.runtimeStatusMeta,
    }),
    embeddings: async () => {
      const baseMeta = {
        dims: options.gateway.dims,
        ...toActiveProbeMeta(activeProbeConfig),
        ...options.runtimeStatusMeta,
      };
      if (!Number.isFinite(options.gateway.dims) || options.gateway.dims <= 0) {
        return {
          status: 'degraded',
          detail: 'Embedding dimensions are invalid',
          meta: baseMeta,
        };
      }

      if (!activeProbeConfig.enabled) {
        return {
          status: 'healthy',
          meta: baseMeta,
        };
      }

      const probeResult = await embeddingsActiveProbe.run(async (signal) => {
        const vector = await options.gateway.embed('health probe', { signal });
        if (vector.length !== options.gateway.dims) {
          throw new Error(`Embedding probe dimension mismatch: expected ${options.gateway.dims}, got ${vector.length}`);
        }
      });
      const meta = {
        ...baseMeta,
        ...toActiveProbeMeta(activeProbeConfig, probeResult),
      };

      if (!probeResult.ok) {
        return {
          status: 'degraded',
          detail: probeResult.reason ?? 'Embeddings connectivity probe failed',
          meta,
        };
      }

      return {
        status: 'healthy',
        meta,
      };
    },
    scheduler: () => {
      const taskCount = options.scheduler.taskCount;
      const hasHealthcheckTask = Boolean(options.scheduler.getTask('healthcheck'));
      if (!hasHealthcheckTask) {
        return {
          status: 'degraded',
          detail: 'Healthcheck task is not registered',
          meta: { taskCount, ...options.runtimeStatusMeta },
        };
      }
      return {
        status: 'healthy',
        meta: { taskCount, ...options.runtimeStatusMeta },
      };
    },
  };
}

export function resolveAgentApiSurfaceBindings(
  env: NodeJS.ProcessEnv = process.env,
): AgentApiSurfaceBindings {
  return {
    apiHost: env.API_HOST || undefined,
    apiPort: parseOptionalPositiveIntEnv(env.API_PORT),
    adminPort: parseOptionalPositiveIntEnv(env.ADMIN_PORT),
  };
}
