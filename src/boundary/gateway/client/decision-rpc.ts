// `llm.decide` client capability (epic 4lf3r): one typed decision through the
// gateway-owned remote (Jev) backend. Only the site id, JSON state and typed
// questions cross; the gateway re-checks the owner policy and refuses before
// any network call.

import type { LLMDecideParams, LLMDecideResult } from '../protocol.js';
import type { GatewayClientTransportRuntime } from './transport-runtime.js';

export type GatewayDecisionParams = Omit<LLMDecideParams, 'companionId'>;

export async function requestGatewayDecision(
  transport: Pick<GatewayClientTransportRuntime, 'requestWithAbortSignal'>,
  companionId: string | undefined,
  params: GatewayDecisionParams,
  signal?: AbortSignal,
): Promise<LLMDecideResult> {
  return await transport.requestWithAbortSignal<LLMDecideResult>(
    'llm.decide',
    { ...params, ...(companionId ? { companionId } : {}) },
    signal,
  );
}
