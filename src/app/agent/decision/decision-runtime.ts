// Agent-process wiring for the typed decision primitive (epic 4lf3r). One
// DecisionRuntime per agent process, shared by every decision site. The local
// backend reuses the agent's gateway-backed LLM provider port, so decision
// calls ride the same admission, budget and usage accounting as every other
// background call.

import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import { createDecisionRuntime, type DecisionRuntime } from '../../../primitives/llm/decision/decide.js';
import { createLocalDecisionBackend } from '../../../primitives/llm/decision/local-backend.js';

export interface AgentDecisionRuntimeOptions {
  llmProvider: Pick<LLMProviderPort, 'complete'>;
}

export function buildAgentDecisionRuntime(options: AgentDecisionRuntimeOptions): DecisionRuntime {
  return createDecisionRuntime({
    local: createLocalDecisionBackend({
      llmProvider: options.llmProvider,
      resolveQuestionMode: () => 'combined',
    }),
  });
}
