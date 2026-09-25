// `llm.decide` (epic 4lf3r): the agent's route to the optional remote Jev
// decision backend. The gateway owns the OpenRouter key and re-checks the
// owner policy per call; a refusal is a POLICY_DENIED error before any
// network I/O, and the agent answers locally. The audit summary is
// content-free (site id and question count only, never the state).

import { JSONRPCErrorException } from 'json-rpc-2.0';
import { GatewayErrors, type LLMDecideParams, type LLMDecideResult } from '../protocol.js';
import { JevDecisionRefusedError } from '../jev-decision-service.js';
import { gatewayMethodParamDecoders } from './params.js';
import { registerAuditedDescriptors } from './register.js';
import { defineAuditedMethod, type GatewayMethodRuntime } from './types.js';

export function registerLlmDecideMethod(runtime: GatewayMethodRuntime): void {
  registerAuditedDescriptors(runtime, [
    defineAuditedMethod({
      name: 'llm.decide',
      decode: gatewayMethodParamDecoders['llm.decide'],
      handler: async (params: LLMDecideParams, methodRuntime): Promise<LLMDecideResult> => {
        const service = methodRuntime.jevDecisions;
        if (!service) {
          throw new JSONRPCErrorException('Remote decision backend is not wired', GatewayErrors.POLICY_DENIED);
        }
        const companionId = methodRuntime.authenticatedCompanionId();
        try {
          return await service.decide({
            siteId: params.siteId,
            state: params.state,
            questions: params.questions,
            ...(companionId ? { companionId } : {}),
            ...(params.telemetryVisibility ? { telemetryVisibility: params.telemetryVisibility } : {}),
          });
        } catch (error) {
          if (error instanceof JevDecisionRefusedError) {
            throw new JSONRPCErrorException(error.message, GatewayErrors.POLICY_DENIED);
          }
          throw error;
        }
      },
      summary: (params: LLMDecideParams) => ({
        siteId: params.siteId,
        questionCount: Object.keys(params.questions).length,
      }),
    }),
  ]);
}
