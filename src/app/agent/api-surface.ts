import type { SubstrateAgent } from '../../core/agent/substrate-agent.js';
import {
  createApiServerChannelAdapterFactoryEntry,
  createOpenHomeChannelAdapterFactoryEntry,
  requireChannelAdapter,
} from '../startup/composition/channel-runtime.js';
import {
  CachedActiveHealthProbe,
  resolveActiveHealthProbeConfig,
  toActiveProbeMeta,
} from '../../channels/api/active-health-probe.js';
import { resolveApiCorsAllowedOrigins } from '../../channels/api/http-policy.js';
import type { ApiServer, ApiServerConfig } from '../../channels/api/server.js';
import { createApiVoiceWebSocketRuntime } from '../../channels/api/voice-websocket-runtime.js';
import {
  buildExternalChannelProfiles,
  type RuntimeChannelsConfig,
} from '../../channels/config.js';
import type { ChannelAdapter } from '../../channels/types.js';
import type { ContactStore } from '../../contacts/store.js';
import type { GatewayClient } from '../../boundary/gateway/client.js';
import type { MemoryStore } from '../../memory/store.js';
import type { Scheduler } from '../../scheduler/scheduler.js';
import type { EventBus } from '../../shared/event-bus.js';
import { createComponentLogger } from '../../shared/logger.js';
import { parseOptionalPositiveIntEnv, parsePositiveIntEnv } from '../../shared/utils/env.js';
import type { EligibilityGate } from '../../system/capabilities/eligibility.js';
import type { SessionManager } from '../../session/manager.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { RuntimeStatusMetadata } from '../../system/lifecycle/runtime-mode.js';
import {
  buildChannelAdapterFactoryManifest,
  loadChannelAdaptersFromManifest,
} from '../startup/support/channel-lifecycle.js';
import { isExplicitTrue, parseCommaSeparatedEnv } from '../startup/support/env-parsing.js';

const log = createComponentLogger('Agent');
const DEFAULT_API_REQUEST_TIMEOUT_MS = 90_000;
const DISABLED_VOICE_WEBSOCKET_PATH = '/v1/voice/ws-disabled';

export interface AgentApiSurfaceBindings {
  apiHost?: string;
  apiPort?: number;
  adminHost?: string;
  adminPort?: number;
}

export interface StartOptionalApiServerOptions extends AgentApiSurfaceBindings {
  config: SubstrateConfig;
  env?: NodeJS.ProcessEnv;
  channelsConfig: RuntimeChannelsConfig;
  agentLoop: SubstrateAgent;
  eventBus: EventBus;
  eligibilityGate: EligibilityGate;
  sessionManager: SessionManager;
  contactStore: ContactStore;
  memoryStore: MemoryStore;
  gateway: GatewayClient;
  scheduler: Scheduler;
  runtimeStatusMeta: RuntimeStatusMetadata;
}

function buildApiHealthChecks(
  options: Pick<
    StartOptionalApiServerOptions,
    'config' | 'memoryStore' | 'gateway' | 'scheduler' | 'runtimeStatusMeta'
  >,
  activeProbeConfig: ReturnType<typeof resolveActiveHealthProbeConfig>,
): NonNullable<ApiServerConfig['healthChecks']> {
  const llmActiveProbe = new CachedActiveHealthProbe(activeProbeConfig);
  const embeddingsActiveProbe = new CachedActiveHealthProbe(activeProbeConfig);

  return {
    memory: () => {
      const stats = options.memoryStore.getStats();
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
          throw new Error(
            `Embedding probe dimension mismatch: expected ${options.gateway.dims}, got ${vector.length}`,
          );
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
      if (!hasHeartbeatTask) {
        return {
          status: 'degraded',
          detail: 'Heartbeat task is not registered',
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
    adminHost: env.ADMIN_HOST || undefined,
    adminPort: parseOptionalPositiveIntEnv(env.ADMIN_PORT),
  };
}

export async function startOptionalApiServer(
  options: StartOptionalApiServerOptions,
): Promise<ApiServer | undefined> {
  if (!options.apiPort) {
    return undefined;
  }

  const env = options.env ?? process.env;
  const allowInsecureWithoutAuth = isExplicitTrue(env.ALLOW_INSECURE_LOCAL_API);
  const corsAllowedOrigins = resolveApiCorsAllowedOrigins({
    explicitAllowlist: parseCommaSeparatedEnv(env.API_CORS_ALLOWLIST),
    adminHost: options.adminHost,
    adminPort: options.adminPort,
  });
  const voiceWebSocketRuntime = createApiVoiceWebSocketRuntime({
    agentLoop: options.agentLoop,
    eventBus: options.eventBus,
    config: options.config,
    eligibilityGate: options.eligibilityGate,
  });
  const voiceWebSocketPath = voiceWebSocketRuntime
    ? undefined
    : DISABLED_VOICE_WEBSOCKET_PATH;
  if (!voiceWebSocketRuntime) {
    log.info('API voice websocket runtime gated off: STT/TTS runtime is not fully wired');
  }

  const activeProbeConfig = resolveActiveHealthProbeConfig(env);
  const apiChannelRegistry = new Map<string, ChannelAdapter>();
  const apiChannelManifest = buildChannelAdapterFactoryManifest([
    createOpenHomeChannelAdapterFactoryEntry(),
    createApiServerChannelAdapterFactoryEntry({
      port: options.apiPort,
      host: options.apiHost,
      agentLoop: options.agentLoop,
      eventBus: options.eventBus,
      sessionManager: options.sessionManager,
      contactStore: options.contactStore,
      apiKey: env.API_KEY || undefined,
      adminToken: env.ADMIN_TOKEN || undefined,
      allowInsecureWithoutAuth,
      corsAllowedOrigins,
      modelName: env.API_MODEL_NAME,
      externalChannelProfiles: buildExternalChannelProfiles(options.channelsConfig),
      requestTimeoutMs: parsePositiveIntEnv(
        env.API_REQUEST_TIMEOUT_MS,
        DEFAULT_API_REQUEST_TIMEOUT_MS,
      ),
      voiceWebSocketPath,
      voiceWebSocketRuntime,
      healthChecks: buildApiHealthChecks(options, activeProbeConfig),
    }),
  ]);
  await loadChannelAdaptersFromManifest(
    apiChannelRegistry,
    apiChannelManifest,
    (registry) => options.agentLoop.setChannelRegistry(registry),
    log,
    options.eligibilityGate,
  );

  const apiServer = requireChannelAdapter<ApiServer>(apiChannelRegistry, 'api');
  await apiServer.start();
  log.info(`API server listening on port ${options.apiPort}`);
  return apiServer;
}
