import { JSONRPCErrorException } from 'json-rpc-2.0';
import {
  ActiveHealthProbeFailure,
  CachedActiveHealthProbe,
  resolveActiveHealthProbeConfig,
  toActiveProbeMeta,
} from '../../channels/api/active-health-probe.js';
import type { GatewayClient } from '../../boundary/gateway/client.js';
import { GatewayErrors } from '../../boundary/gateway/protocol.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import type { MemoryStorePort } from '../../faculties/memory/memory-store-port.js';
import type { Scheduler } from '../../core/scheduler/scheduler.js';
import type { ModelSlot } from '../../shared/contracts/runtime.js';
import type { DiscoveredModel } from '../../primitives/llm/discovery.js';
import { parseOptionalPositiveIntEnv } from '../../shared/utils/env.js';
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
        probeKind: 'model_discovery',
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

      // Deterministic, token-free probe: list the gateway's model catalog
      // (llm.discover_models -> provider models endpoint, cached by discovery).
      // A completion or embedding here would bill every health poll and
      // compete with real work for the model-call gate.
      const probeResult = await llmActiveProbe.run(async () => {
        let models: DiscoveredModel[];
        try {
          models = await options.gateway.getAvailableModels();
        } catch (error) {
          if (isModelDiscoveryUnconfigured(error)) {
            // The gateway answered; there is simply no catalog to list.
            return { gatewayReachable: true, discovery: 'unconfigured' };
          }
          // A JSON-RPC error response proves the gateway link is alive even
          // though the provider models endpoint failed; anything else (closed
          // connection, rejected pending request) means the link is down.
          throw new ActiveHealthProbeFailure(
            toErrorMessage(error),
            { gatewayReachable: error instanceof JSONRPCErrorException },
            { cause: error },
          );
        }
        return {
          gatewayReachable: true,
          discovery: 'listed',
          ...buildModelCatalogProbeMeta(models, probeRoute),
        };
      });
      const meta = {
        ...baseMeta,
        ...toActiveProbeMeta(activeProbeConfig, probeResult),
      };

      if (!probeResult.ok) {
        return {
          status: 'degraded',
          detail: probeResult.reason ?? 'LLM model discovery probe failed',
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
    embeddings: () => {
      const baseMeta = {
        dims: options.gateway.dims,
        probeMode: 'configuration',
        ...options.runtimeStatusMeta,
      };
      if (!Number.isFinite(options.gateway.dims) || options.gateway.dims <= 0) {
        return {
          status: 'degraded',
          detail: 'Embedding dimensions are invalid',
          meta: baseMeta,
        };
      }

      // Configuration-only check: an embedding request here would bill every
      // health poll. Connectivity to the gateway is proven by the llm check.
      return {
        status: 'healthy',
        meta: baseMeta,
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

/**
 * Report whether the probed route's model appears in the discovered catalog.
 * This is metadata only: catalog ids and roster ids use different namespaces
 * across providers (e.g. `openrouter/<vendor>/<model>` vs `<vendor>/<model>`),
 * so an unlisted model does not by itself mean the route is unusable.
 */
function buildModelCatalogProbeMeta(
  models: readonly DiscoveredModel[],
  route: { provider?: string; model?: string },
): Record<string, unknown> {
  const catalogIds = new Set(models.map(model => model.id));
  const candidates = modelIdCandidates(route);
  return {
    discoveredModelCount: models.length,
    modelListed: candidates.some(candidate => catalogIds.has(candidate)),
  };
}

function isModelDiscoveryUnconfigured(error: unknown): boolean {
  return error instanceof JSONRPCErrorException
    && error.code === GatewayErrors.MODEL_DISCOVERY_UNCONFIGURED;
}

function modelIdCandidates(route: { provider?: string; model?: string }): string[] {
  const model = route.model;
  if (!model) return [];
  const providerPrefix = route.provider ? `${route.provider}/` : undefined;
  return providerPrefix && model.startsWith(providerPrefix)
    ? [model, model.slice(providerPrefix.length)]
    : [model];
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
