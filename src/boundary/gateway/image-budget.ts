// Budget pricing and admission for paid image generation (psfn-framework-6da92).
//
// Image calls are not token-priced LLM dispatches, so the LLM budget gate
// never saw them and their rows carried no cost. An OpenRouter image model is
// priced from its models.json `imageModels[].cost.perImageUsd`: the request's
// worst case (requested images at that price) must fit the enforced budget
// before dispatch, an unpriced model is refused while the budget is enforced,
// and the attempt row carries the provider-reported cost plus the estimate.

import { JSONRPCErrorException } from 'json-rpc-2.0';
import type { ImageModelRegistryEntry } from '../../shared/contracts/runtime-base.js';
import type { ImageMode } from '../../primitives/images/types.js';
import { ModelBudgetExceededError, type ModelBudgetController } from '../../primitives/llm/model-budget.js';
import { roundModelUsageUsd } from '../../shared/telemetry/model-usage-accounting.js';
import type { ModelUsageCostSource } from '../../shared/telemetry/model-usage.js';
import { GatewayErrors, type GatewayCorrelationParams } from './protocol.js';

export function findImageModelPricing(
  imageModels: readonly ImageModelRegistryEntry[] | undefined,
  mode: ImageMode,
  model: string,
): ImageModelRegistryEntry['cost'] {
  return imageModels?.find(entry => entry.model === model && entry.modes.includes(mode))?.cost;
}

export function imageWorstCaseCostUsd(perImageUsd: number, imageCount: number): number {
  return roundModelUsageUsd(perImageUsd * Math.max(1, imageCount));
}

/** Refuses an image dispatch that is unpriced or does not fit the enforced budget. */
export async function admitPaidImageDispatch(input: {
  budget: ModelBudgetController | undefined;
  budgetEnforced: boolean;
  provider: string;
  model: string;
  /** Requested image count; stands in for the token cap on this non-token dispatch. */
  imageCount: number;
  worstCaseUsd: number | undefined;
  correlation: GatewayCorrelationParams;
}): Promise<void> {
  if (!input.budgetEnforced) return;
  if (input.worstCaseUsd === undefined) {
    throw new JSONRPCErrorException(
      `Image model ${input.provider}:${input.model} has no models.json imageModels cost; `
      + 'paid image generation is refused while the model budget is enforced',
      GatewayErrors.POLICY_DENIED,
      { reason: 'missing_cost_metadata' },
    );
  }
  if (!input.budget) {
    throw new JSONRPCErrorException(
      'Model budget accounting is not wired for image generation',
      GatewayErrors.POLICY_DENIED,
      { reason: 'accounting_unavailable' },
    );
  }
  const preflight = await input.budget.evaluatePreflight({
    candidate: { provider: input.provider, model: input.model, maxTokens: input.imageCount },
    purpose: 'background',
    service: 'image',
    process: 'image.generate',
    estimatedInputTokens: 0,
    fixedEstimatedCostUsd: input.worstCaseUsd,
    correlation: {
      ...(input.correlation.companionId ? { companionId: input.correlation.companionId } : {}),
      ...(input.correlation.turnId ? { turnId: input.correlation.turnId } : {}),
      ...(input.correlation.requestId ? { requestId: input.correlation.requestId } : {}),
    },
  });
  if (!preflight.allowed && preflight.blockedEvent) {
    throw new ModelBudgetExceededError(preflight.blockedEvent, preflight.accountingError);
  }
}

/**
 * Cost fields for an image attempt row: the provider-reported amount when the
 * provider exposes it, otherwise the per-image estimate. A provider HTTP
 * refusal generated nothing ($0); any other failure is charged its worst case.
 */
export function imageAttemptCost(input: {
  status: 'success' | 'failure';
  providerCostUsd: number | undefined;
  perImageUsd: number | undefined;
  imageCount: number;
  worstCaseUsd: number | undefined;
  httpRefusal: boolean;
}): { providerCostUsd?: number; estimatedCostUsd?: number; costSource: ModelUsageCostSource } {
  let estimatedCostUsd: number | undefined;
  if (input.status === 'failure') {
    estimatedCostUsd = input.httpRefusal ? 0 : input.worstCaseUsd;
  } else if (input.perImageUsd !== undefined) {
    estimatedCostUsd = roundModelUsageUsd(input.perImageUsd * input.imageCount);
  }
  const providerCostUsd = input.status === 'success' ? input.providerCostUsd : undefined;
  const costSource: ModelUsageCostSource = providerCostUsd !== undefined
    ? 'provider'
    : (estimatedCostUsd !== undefined && estimatedCostUsd > 0 ? 'estimate' : 'none');
  return {
    ...(providerCostUsd !== undefined ? { providerCostUsd } : {}),
    ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
    costSource,
  };
}
