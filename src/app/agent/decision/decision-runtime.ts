// Agent-process wiring for the typed decision primitive (epic 4lf3r). One
// DecisionRuntime per agent process, shared by every decision site. The local
// backend reuses the agent's gateway-backed LLM provider port, so decision
// calls ride the same admission, budget and usage accounting as every other
// background call. Settings are read per call from this process's runtime
// config, but nothing reloads that config after a settings.json write: the
// Garden applies a save to its own config view only, and the gateway's remote
// decision service keeps its startup copy. A decisionBackend change therefore
// takes effect after the gateway and agents restart, and the Garden save
// response reports it as restart-required (bead psfn-framework-y7mjg).

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
