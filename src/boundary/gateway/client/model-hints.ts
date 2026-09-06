import type { LLMModelHint } from '../../../shared/contracts/runtime.js';
import { normalizeModelHint, OPTIONAL_MODEL_HINT_NORMALIZATION } from '../../../primitives/llm/model-hint-routing.js';

export function mergeGatewayModelHints(
  contextHint: LLMModelHint | undefined,
  optionHint: LLMModelHint | undefined,
): LLMModelHint | undefined {
  const normalizedContext = normalizeModelHint(contextHint, OPTIONAL_MODEL_HINT_NORMALIZATION);
  const normalizedOption = normalizeModelHint(optionHint, OPTIONAL_MODEL_HINT_NORMALIZATION);
  if (!normalizedContext && !normalizedOption) return undefined;
  return {
    ...(normalizedContext ?? {}),
    ...(normalizedOption ?? {}),
  };
}
