import type { AgentTool } from '../../boundary/pi-agent/index.js';
import type { LLMProviderPort, MemoryProvider } from '../../core/agent/contracts.js';
import { SubstrateAgent } from '../../core/agent/substrate-agent.js';
import type { EventBus } from '../../shared/event-bus.js';
import type { SessionStore } from '../../persistence/sessions/store.js';
import { SessionManager } from '../../core/session/manager.js';
import type { RuntimeMode } from '../../core/agent/tool-wiring-validator.js';
import type { CapabilityAccess } from '../../system/capabilities/access.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { sanitizeCoreSubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { allowShardRequestScopedCapabilityTransport } from './request-scoped-capability-transport.js';

export interface CreateShardAgentRuntimeOptions {
  readonly eventBus: EventBus;
  readonly llmProvider: LLMProviderPort;
  readonly sessionStore: SessionStore;
  readonly runtimeConfig: SubstrateConfig;
  readonly systemPrompt: string;
  readonly runtimeMode?: RuntimeMode;
  readonly capabilityAccess: CapabilityAccess;
  readonly memoryProvider: MemoryProvider | null;
  readonly exposeMemory: boolean;
  readonly tools: readonly AgentTool<any>[];
}

export function createShardAgentRuntime(
  options: CreateShardAgentRuntimeOptions,
): Readonly<{ agentLoop: SubstrateAgent; sessionManager: SessionManager }> {
  const sessionManager = new SessionManager(
    options.sessionStore,
    options.runtimeConfig,
    options.eventBus,
  );
  const agentLoop = new SubstrateAgent(
    options.eventBus,
    options.llmProvider,
    sessionManager,
    options.systemPrompt,
    sanitizeCoreSubstrateConfig(options.runtimeConfig),
    {
      runtimeMode: options.runtimeMode,
      backgroundWorkDisabled: true,
      allowCapabilityDeniedTransport: allowShardRequestScopedCapabilityTransport,
    },
  );
  agentLoop.setCapabilityAccess(options.capabilityAccess);
  if (options.memoryProvider && options.exposeMemory) {
    agentLoop.memoryProvider = options.memoryProvider;
  }
  for (const tool of options.tools) {
    agentLoop.registerTool(tool);
  }
  return { agentLoop, sessionManager };
}
