import {
  CachedActiveHealthProbe,
  resolveActiveHealthProbeConfig,
  toActiveProbeMeta,
} from '../../channels/api/active-health-probe.js';
import type { GatewayClient } from '../../boundary/gateway/client.js';
import type { MemoryStorePort } from '../../faculties/memory/memory-store-port.js';
import type { Scheduler } from '../../core/scheduler/scheduler.js';
import type { LLMProviderObservability, ModelSlot } from '../../shared/contracts/runtime.js';
import { parseOptionalPositiveIntEnv } from '../../shared/utils/env.js';
import { buildLLMWorkSpec, completeWithWorkSpec } from '../../primitives/llm/work-spec.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { RUNTIME_MODE, type RuntimeMode, type RuntimeStatusMetadata } from '../../system/lifecycle/runtime-mode.js';
import type { ApiServerConfig } from '../../channels/api/server.js';
import {
  getPostgresStoreReadinessSnapshot,
  type PostgresRuntimeReadinessSnapshot,
} from '../../persistence/postgres/runtime-readiness.js';

// Runtime topologies where the Discord transport is owned by the gateway/host
// process rather than this agent container. Health reporting treats Discord as
// delegated (not-applicable) in these modes instead of a permanent 'degraded'.
const DISCORD_DELEGATING_RUNTIME_MODES: readonly RuntimeMode[] = [
  RUNTIME_MODE.SPLIT,
  RUNTIME_MODE.GATEWAY_AGENT,
];

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
    postgresReadiness?: () => PostgresRuntimeReadinessSnapshot;
  },
  activeProbeConfig: ReturnType<typeof resolveActiveHealthProbeConfig>,
): NonNullable<ApiServerConfig['healthChecks']> {
  const llmActiveProbe = new CachedActiveHealthProbe(activeProbeConfig);
  const embeddingsActiveProbe = new CachedActiveHealthProbe(activeProbeConfig);

  return {
    memory: async () => {
      const stats = await options.memoryStore.getStats();
      const postgresReadiness = (
        options.postgresReadiness ?? getPostgresStoreReadinessSnapshot
      )();
      const optionalDegradation = postgresReadiness.degraded.filter(
        entry => entry.requirement === 'optional',
      );
      const requiredDegradation = postgresReadiness.degraded.some(
        entry => entry.requirement === 'required',
      );
      const postgresUnavailable = postgresReadiness.phase !== 'ready' || requiredDegradation;
      return {
        status: postgresUnavailable ? 'degraded' : 'healthy',
        ...(postgresUnavailable
          ? {
              detail: postgresReadiness.phase !== 'ready'
                ? `PostgreSQL startup readiness is ${postgresReadiness.phase}`
                : 'A required PostgreSQL store became unavailable after startup',
            }
          : {}),
        meta: {
          total: stats.total,
          avgSalience: Number(stats.avgSalience.toFixed(4)),
          postgresReadiness: {
            phase: postgresReadiness.phase,
            status: optionalDegradation.length > 0 ? 'degraded' : 'ok',
            degradedStores: optionalDegradation.map(entry => ({
              store: entry.store,
              label: entry.label,
            })),
          },
          ...options.runtimeStatusMeta,
        },
      };
    },
    llm: async () => {
      const probeRoute = resolveReasoningProbeRoute(options.config);
      const configured = Boolean(probeRoute.model && probeRoute.provider);
      const baseMeta = {
        provider: probeRoute.provider,
        model: probeRoute.model,
        probePurpose: 'reasoning',
        probeSlot: probeRoute.slot,
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
        const response = await completeWithWorkSpec(
          options.gateway,
          {
            systemPrompt: 'You are a health check. Respond with exactly: OK',
            messages: [{ role: 'user', content: 'health probe' }],
          },
          buildLLMWorkSpec({ purpose: 'reasoning', durable: false }),
          { signal },
        );
        return buildResolvedProbeRouteMeta(response.model, response.providerObservability);
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
    discord: () => {
      // Discord transport runs in the gateway/host process, not the agent
      // container. In these split runtime topologies the agent cannot observe
      // it, so report it as delegated (not-applicable) instead of permanently
      // poisoning aggregate health with a placeholder 'degraded'. If a future
      // co-located topology owns the transport in this process, it will not be
      // listed as delegating and falls through to the honest degraded
      // placeholder rather than masking a real outage.
      if (DISCORD_DELEGATING_RUNTIME_MODES.includes(options.runtimeStatusMeta.activeMode)) {
        return {
          status: 'healthy',
          detail: 'Discord transport is delegated to the gateway (not applicable to the agent container)',
          meta: { ...options.runtimeStatusMeta, delegated: true },
        };
      }
      return {
        status: 'degraded',
        detail: 'Discord transport runs outside the agent container',
        meta: options.runtimeStatusMeta,
      };
    },
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
      const hasHeartbeatTask = Boolean(options.scheduler.getTask('heartbeat'));
      if (taskCount === 0) {
        return {
          status: 'degraded',
          detail: 'No scheduler tasks are registered',
          meta: { taskCount, heartbeatTaskRegistered: hasHeartbeatTask, ...options.runtimeStatusMeta },
        };
      }
      return {
        status: 'healthy',
        meta: { taskCount, heartbeatTaskRegistered: hasHeartbeatTask, ...options.runtimeStatusMeta },
      };
    },
  };
}

function resolveReasoningProbeRoute(config: SubstrateConfig): {
  slot: 'reasoning' | 'chat' | 'primary';
  provider?: string;
  model?: string;
} {
  const reasoningSlot = config.modelRoster.reasoning;
  if (isConfiguredModelSlot(reasoningSlot)) {
    return {
      slot: 'reasoning',
      provider: reasoningSlot.provider,
      model: reasoningSlot.model,
    };
  }

  const chatSlot = config.modelRoster.chat;
  if (isConfiguredModelSlot(chatSlot)) {
    return {
      slot: 'chat',
      provider: chatSlot.provider,
      model: chatSlot.model,
    };
  }

  return {
    slot: 'primary',
    provider: config.primaryProvider,
    model: config.primaryModel,
  };
}

function isConfiguredModelSlot(slot: ModelSlot | undefined): slot is ModelSlot {
  return Boolean(slot?.provider && slot.model);
}

function buildResolvedProbeRouteMeta(
  responseModel: string,
  providerObservability?: LLMProviderObservability,
): Record<string, unknown> {
  if (!providerObservability) {
    return { responseModel };
  }

  return {
    responseModel,
    requestedProvider: providerObservability.requestedProvider,
    requestedModel: providerObservability.requestedModel,
    resolvedProvider: providerObservability.backendProvider,
    resolvedModel: providerObservability.backendModel,
    resolvedBackendApi: providerObservability.backendApi,
    resolvedRouteKind: providerObservability.routeKind,
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
