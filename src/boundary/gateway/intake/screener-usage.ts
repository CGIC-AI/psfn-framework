// Intake screener usage ledger (psfn-framework-1fyyi).
//
// The L2/L3/vision screeners call their provider through the tool-less
// screener transport, not LLMClient, so their spend never reached
// model_usage_events. This records one content-free row per provider dispatch
// (including a schema-repair retry), priced from the model registry entry the
// screener route resolved to and attributed to the screening companion.
//
// Pricing: a dispatch is recorded only when the registry prices every token
// bucket it used. An unpriced row would count as an unknown-cost attempt in
// the budget projection and block every later dispatch under an enabled
// budget, so an unpriced screener model is reported loudly (once per model)
// instead. Missing cost metadata keeps failing closed at LLM dispatch through
// the budget gate, unchanged.

import { randomUUID } from 'node:crypto';
import { resolveModelUsageCostRates } from '../../../primitives/llm/model-budget.js';
import { estimateConservativeModelUsageCostUsd } from '../../../shared/telemetry/model-usage-accounting.js';
import type { ModelUsageRecorder } from '../../../shared/telemetry/model-usage.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import { createComponentLogger } from '../../../shared/logger.js';
import type { ScreenerAttemptUsage, ScreenerModel } from './screener-transport.js';

const log = createComponentLogger('intake-screener-usage');

type IntakeScreenerTier = 'l2' | 'l3' | 'vision';

const TIER_PURPOSE = {
  l2: 'background',
  l3: 'reasoning',
  vision: 'vision',
} as const;

/** Returns the per-dispatch observer for one screener call on `model`. */
export type IntakeScreenerUsageLedger = (
  tier: IntakeScreenerTier,
  model: ScreenerModel,
) => ((attempt: ScreenerAttemptUsage) => void) | undefined;

export function createIntakeScreenerUsageLedger(options: {
  recorder: ModelUsageRecorder;
  config: SubstrateConfig;
  /** Owning companion of the screening composition; absent in single-companion mode. */
  companionId?: string;
}): IntakeScreenerUsageLedger {
  const unpricedReported = new Set<string>();
  return (tier, model) => {
    // A bare model string exists only in fetch-isolated tests; production
    // routes always carry provider identity.
    if (typeof model === 'string') return undefined;
    const logicalCallId = `intake-${tier}:${randomUUID()}`;
    let attemptNumber = 0;
    return (attempt) => {
      attemptNumber += 1;
      const rates = resolveModelUsageCostRates(options.config, model);
      const estimatedCostUsd = estimateConservativeModelUsageCostUsd({
        inputTokens: attempt.inputTokens,
        outputTokens: attempt.outputTokens,
        cacheReadTokens: attempt.cacheReadTokens,
        cacheWriteTokens: attempt.cacheWriteTokens,
      }, rates);
      const label = `${model.provider}/${model.model}`;
      if (estimatedCostUsd === undefined) {
        if (!unpricedReported.has(label)) {
          unpricedReported.add(label);
          log.warn('Intake screener model has no registry pricing; its usage is not ledgered', {
            tier,
            model: label,
            ...(model.slotKey ? { slotKey: model.slotKey } : {}),
          });
        }
        return;
      }
      void options.recorder.recordUsageEvent({
        logicalCallId,
        attempt: attemptNumber,
        startedAtMs: attempt.startedAtMs,
        completedAtMs: attempt.completedAtMs,
        durationMs: Math.max(0, attempt.completedAtMs - attempt.startedAtMs),
        status: attempt.status,
        callKind: 'completion',
        telemetryVisibility: 'operator_visible',
        attribution: {
          ...(options.companionId ? { companionId: options.companionId } : {}),
          callType: 'background',
          purpose: TIER_PURPOSE[tier],
          originType: 'background',
          originStage: `intake:${tier}`,
          service: 'intake_screening',
          process: `intake.${tier}`,
        },
        provider: model.provider,
        model: model.model,
        ...(model.slotKey ? { slotKey: model.slotKey } : {}),
        requestedProvider: model.provider,
        requestedModel: model.model,
        inputTokens: attempt.inputTokens,
        outputTokens: attempt.outputTokens,
        cacheReadTokens: attempt.cacheReadTokens,
        cacheWriteTokens: attempt.cacheWriteTokens,
        estimatedCostUsd,
        // The store derives the cost source from the reconciled totals: a
        // positive estimate is 'estimate', a zero-rate (subscription) dispatch
        // is a known $0 with source 'none' (y3k38).
        costSource: estimatedCostUsd > 0 ? 'estimate' : 'none',
        ...(attempt.errorCode ? { errorCode: attempt.errorCode } : {}),
      }).catch((error: unknown) => {
        log.warn('Failed to record intake screener usage', {
          tier,
          model: label,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    };
  };
}
