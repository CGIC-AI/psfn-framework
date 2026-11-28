// Jev decision call pricing for the usage ledger and model budget.
//
// A decision call must never become an unknown-cost row: under an enabled
// budget one unknown row refuses every later chat turn for the companion.
// Every call is therefore priced BEFORE dispatch at its worst case — the
// request's UTF-8 byte length as input tokens (a byte-level tokenizer never
// emits more tokens than bytes) plus the configured output bound — and that
// worst case is what admission reserves. What is BOOKED is what was sent and
// received (lomm1): a completed call its reported tokens; an aborted or
// timed-out call, or one whose connection failed, the request it sent and no
// output (none was received); a 2xx reply that could not be read the worst
// case, since output was produced but its size is unknown; an HTTP error
// answer generated nothing and is a known $0.

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

/** What one decision request can bill: the admission worst case, and its prompt alone. */
export function jevRequestCostBoundsUsd(
  pricing: JevDecisionPricing,
  requestBody: Readonly<Record<string, unknown>>,
): { worstCaseUsd: number; inputBoundUsd: number } {
  const inputTokenBound = Buffer.byteLength(JSON.stringify(requestBody), 'utf8');
  return {
    worstCaseUsd: priceTokens(pricing, inputTokenBound, pricing.maxOutputTokens),
    inputBoundUsd: priceTokens(pricing, inputTokenBound, 0),
  };
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
  bounds: { worstCaseUsd: number; inputBoundUsd: number } | undefined;
  result: JevTransportResult;
}): { estimatedCostUsd?: number; costSource: ModelUsageCostSource } {
  const { outcome, usage, httpStatus } = input.result;
  const providerPriced = outcome.ok && outcome.costUsd !== undefined;
  let estimatedCostUsd: number | undefined;
  if (!outcome.ok && isHttpRefusal(httpStatus)) {
    estimatedCostUsd = 0;
  } else if (input.pricing && outcome.ok && usage) {
    estimatedCostUsd = priceTokens(input.pricing, usage.inputTokens, usage.outputTokens);
  } else if (input.bounds) {
    // No status: the call ended before any reply was read, so no output was received.
    estimatedCostUsd = httpStatus === undefined ? input.bounds.inputBoundUsd : input.bounds.worstCaseUsd;
  }
  const costSource: ModelUsageCostSource = providerPriced
    ? 'provider'
    : (estimatedCostUsd !== undefined && estimatedCostUsd > 0 ? 'estimate' : 'none');
  return { ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}), costSource };
}
