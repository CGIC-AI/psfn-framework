// Jev decision call pricing for the usage ledger and model budget.
//
// A decision call must never become an unknown-cost row: under an enabled
// budget one unknown row refuses every later chat turn for the companion.
// Every call is therefore priced BEFORE dispatch at its worst case — the
// request's UTF-8 byte length as input tokens (a byte-level tokenizer never
// emits more tokens than bytes) plus the configured output bound — and that
// worst case is what an aborted, timed-out or unreadable call is charged. A
// completed call is charged its reported tokens; an HTTP error answer
// generated nothing and is a known $0.

import type { JevTransportResult } from '../../primitives/llm/decision/jev-transport.js';
import type { JevDecisionPricing } from '../../system/config/decision-backend-config.js';
import { ceilModelUsageUsd } from '../../shared/telemetry/model-usage-accounting.js';
import type { ModelUsageCostSource } from '../../shared/telemetry/model-usage.js';

const TOKENS_PER_PRICING_UNIT = 1_000_000;

function priceTokens(pricing: JevDecisionPricing, inputTokens: number, outputTokens: number): number {
  return ceilModelUsageUsd(
    (inputTokens / TOKENS_PER_PRICING_UNIT) * pricing.inputPer1MUsd
    + (outputTokens / TOKENS_PER_PRICING_UNIT) * pricing.outputPer1MUsd,
  );
}

/** Conservative upper bound on what one decision request can bill. */
export function jevWorstCaseCostUsd(
  pricing: JevDecisionPricing,
  requestBody: Readonly<Record<string, unknown>>,
): number {
  const inputTokenBound = Buffer.byteLength(JSON.stringify(requestBody), 'utf8');
  return priceTokens(pricing, inputTokenBound, pricing.maxOutputTokens);
}

function isHttpRefusal(httpStatus: number | undefined): boolean {
  return httpStatus !== undefined && (httpStatus < 200 || httpStatus >= 300);
}

/**
 * The estimate and cost source a decision usage row carries. Without pricing
 * (only reachable while the model budget is not enforced) an unreadable call
 * stays unknown.
 */
export function jevDecisionRowCost(input: {
  pricing: JevDecisionPricing | null;
  worstCaseUsd: number | undefined;
  result: JevTransportResult;
}): { estimatedCostUsd?: number; costSource: ModelUsageCostSource } {
  const { outcome, usage, httpStatus } = input.result;
  const providerPriced = outcome.ok && outcome.costUsd !== undefined;
  let estimatedCostUsd: number | undefined;
  if (!outcome.ok && isHttpRefusal(httpStatus)) {
    estimatedCostUsd = 0;
  } else if (input.pricing && outcome.ok && usage) {
    estimatedCostUsd = priceTokens(input.pricing, usage.inputTokens, usage.outputTokens);
  } else if (input.worstCaseUsd !== undefined) {
    estimatedCostUsd = input.worstCaseUsd;
  }
  const costSource: ModelUsageCostSource = providerPriced
    ? 'provider'
    : (estimatedCostUsd !== undefined && estimatedCostUsd > 0 ? 'estimate' : 'none');
  return { ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}), costSource };
}
