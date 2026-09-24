// Agent-side remote decision backend: forwards to the gateway's `llm.decide`
// (the gateway owns the OpenRouter key) and re-validates the returned answers
// against the questions that were asked, so a drifted or tampered result is a
// typed failure that the decision runtime answers locally.

import type { GatewayClient } from '../../../boundary/gateway/client.js';
import { revalidateDecisionAnswers } from '../../../primitives/llm/decision/answer-validation.js';
import type { RemoteDecisionBackend } from '../../../primitives/llm/decision/decide.js';

export function createGatewayRemoteDecisionBackend(
  gateway: Pick<GatewayClient, 'decide'>,
): RemoteDecisionBackend {
  return {
    async decide(request, signal) {
      const result = await gateway.decide({
        siteId: request.siteId,
        state: { ...request.state },
        questions: request.questions,
      }, signal);
      if (!result.ok) return { ...result, backend: 'jev' };
      const answers = result.backend === 'jev'
        ? revalidateDecisionAnswers(request.questions, result.answers)
        : null;
      if (!answers) return { ok: false, reason: 'invalid_output', backend: 'jev', latencyMs: result.latencyMs };
      return { ...result, answers };
    },
  };
}
