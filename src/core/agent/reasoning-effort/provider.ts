import { getRequestContext } from '../../../primitives/llm/request-context.js';
import { toCompletionRoutingPurpose } from '../../../primitives/llm/routing.js';
import type { LLMProviderPort } from '../contracts.js';
import type { ReasoningEffortRuntime } from './runtime.js';

/**
 * A provider port whose direct completions carry the reasoning effort of the
 * lane they run on (free-time choice, reflection deliberation). The lane comes
 * from the call's own correlation, or the ambient request context. A caller
 * that already names an effort keeps it; calls on no lane are unchanged.
 */
export function withLaneReasoningEffort(
  provider: LLMProviderPort,
  runtime: Pick<ReasoningEffortRuntime, 'resolveModelHint'>,
): LLMProviderPort {
  return {
    stream: (context, callbacks, options) => provider.stream(context, callbacks, options),
    complete: (context, purpose, options) => {
      if (options?.modelHint?.thinkingEffort !== undefined) {
        return provider.complete(context, purpose, options);
      }
      const correlation = options?.correlation ?? options?.workSpec?.correlation ?? getRequestContext();
      const hint = runtime.resolveModelHint(toCompletionRoutingPurpose(purpose), correlation);
      if (!hint) return provider.complete(context, purpose, options);
      return provider.complete(context, purpose, {
        ...options,
        modelHint: { ...options?.modelHint, ...hint },
      });
    },
  };
}
