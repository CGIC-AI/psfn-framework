import { toFlooredPositiveInteger } from '../../shared/utils/numeric.js';

export interface CompletionTokenBudgetInput {
  requestedMaxTokens?: unknown;
  configuredMaxOutputTokens?: unknown;
  capabilityMaxOutputTokens?: unknown;
  fallbackMaxTokens?: unknown;
}

/**
 * Resolve one completion ceiling without allowing a call-site hint to exceed
 * the selected model's owner tuning or declared provider capability.
 */
export function resolveCompletionTokenBudget(
  input: CompletionTokenBudgetInput,
): number | undefined {
  const requested = toFlooredPositiveInteger(input.requestedMaxTokens);
  const configured = toFlooredPositiveInteger(input.configuredMaxOutputTokens);
  const capability = toFlooredPositiveInteger(input.capabilityMaxOutputTokens);
  const fallback = toFlooredPositiveInteger(input.fallbackMaxTokens);
  const selected = requested ?? configured ?? capability ?? fallback;
  if (selected === undefined) return undefined;

  const declaredCeilings = [configured, capability].filter(
    (value): value is number => value !== undefined,
  );
  const ceilings = declaredCeilings.length > 0
    ? declaredCeilings
    : (fallback !== undefined ? [fallback] : []);
  return ceilings.length > 0 ? Math.min(selected, ...ceilings) : selected;
}
