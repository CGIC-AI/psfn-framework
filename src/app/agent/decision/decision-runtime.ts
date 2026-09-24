// Agent-process wiring for the typed decision primitive (epic 4lf3r). One
// DecisionRuntime per agent process, shared by every decision site. The local
// backend reuses the agent's gateway-backed LLM provider port, so decision
// calls ride the same admission, budget and usage accounting as every other
// background call. Settings are read live from the runtime config, so a
// settings.json reload changes the backend without a restart.

import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import type { GatewayClient } from '../../../boundary/gateway/client.js';
import { createGatewayRemoteDecisionBackend } from './gateway-remote-backend.js';
import { resolveDecisionShadowLedgerPath } from '../../../persistence/layout.js';
import {
  createDecisionRuntime,
  type DecisionRuntime,
} from '../../../primitives/llm/decision/decide.js';
import { createLocalDecisionBackend } from '../../../primitives/llm/decision/local-backend.js';
import { createJsonlDecisionShadowSink } from '../../../primitives/llm/decision/shadow-record.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';

export interface AgentDecisionRuntimeOptions {
  config: Pick<SubstrateConfig, 'decisionBackend'>;
  llmProvider: Pick<LLMProviderPort, 'complete'>;
  /** Gateway RPC for the optional remote (Jev) backend. */
  gateway: Pick<GatewayClient, 'decide'>;
  companionDataDir: string;
}

export function buildAgentDecisionRuntime(options: AgentDecisionRuntimeOptions): DecisionRuntime {
  const { config } = options;
  return createDecisionRuntime({
    local: createLocalDecisionBackend({
      llmProvider: options.llmProvider,
      resolveQuestionMode: () => config.decisionBackend?.localQuestionMode ?? 'combined',
    }),
    jev: createGatewayRemoteDecisionBackend(options.gateway),
    resolveSettings: () => config.decisionBackend,
    shadowSink: createJsonlDecisionShadowSink(resolveDecisionShadowLedgerPath(options.companionDataDir)),
  });
}
