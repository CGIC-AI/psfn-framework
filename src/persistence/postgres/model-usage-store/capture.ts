import { createHash } from 'node:crypto';
import type {
  EnabledIcpCostBreakerPolicy,
  ModelUsageCostBreakdown,
  ModelUsageEvent,
  ModelUsageEventInput,
} from '../../../shared/telemetry/model-usage.js';
import { normalizeModelUsageAttribution } from '../../../shared/telemetry/model-usage-attribution.js';
import { reconcileModelUsageAccounting } from '../../../shared/telemetry/model-usage-accounting.js';
import { boundModelUsageMetadata } from '../../../shared/telemetry/model-usage-metadata.js';
import { isRecord } from '../../../shared/utils/types.js';
import {
  canonicalize,
  dayKey,
  inputNonNegativeCost,
  inputNonNegativeInteger,
  monthKey,
  normalizeTelemetryVisibility,
  optionalText,
} from './common.js';

export function normalizeText(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : fallback;
}


export function validateEnabledIcpCostPolicy(
  policy: unknown,
): EnabledIcpCostBreakerPolicy {
  if (!isRecord(policy) || policy.enabled !== true) {
    throw new Error('ICP conversation cost accounting requires an enabled owner policy');
  }
  const warningThresholdUsd = inputNonNegativeCost(
    policy.warningThresholdUsd,
    'policy.warningThresholdUsd',
  );
  const hardLimitUsd = inputNonNegativeCost(policy.hardLimitUsd, 'policy.hardLimitUsd');
  const finalCloseoutReserveUsd = inputNonNegativeCost(
    policy.finalCloseoutReserveUsd,
    'policy.finalCloseoutReserveUsd',
  );
  if (
    warningThresholdUsd <= 0
    || finalCloseoutReserveUsd <= 0
    || Math.abs((warningThresholdUsd + finalCloseoutReserveUsd) - hardLimitUsd) > 1e-9
  ) {
    throw new Error('ICP conversation cost policy thresholds do not define one exact closeout band');
  }
  const pendingReservationStaleAfterMs = inputNonNegativeInteger(
    policy.pendingReservationStaleAfterMs,
    'policy.pendingReservationStaleAfterMs',
  );
  if (pendingReservationStaleAfterMs <= 0 || !isRecord(policy.includedCostPurposes)) {
    throw new Error('ICP conversation cost policy requires a positive stale interval and purpose map');
  }
  const includedCostPurposes = policy.includedCostPurposes;
  const purposeKeys = ['conversation_turn', 'tool', 'summary', 'extraction', 'sidecar'] as const;
  const conversationTurn = includedCostPurposes.conversation_turn;
  const tool = includedCostPurposes.tool;
  const summary = includedCostPurposes.summary;
  const extraction = includedCostPurposes.extraction;
  const sidecar = includedCostPurposes.sidecar;
  if (
    Object.keys(includedCostPurposes).some(
      key => !purposeKeys.some(purpose => purpose === key),
    )
    || typeof conversationTurn !== 'boolean'
    || typeof tool !== 'boolean'
    || typeof summary !== 'boolean'
    || typeof extraction !== 'boolean'
    || typeof sidecar !== 'boolean'
    || !conversationTurn
  ) {
    throw new Error('ICP conversation cost policy has an invalid includedCostPurposes map');
  }
  return {
    enabled: true,
    warningThresholdUsd,
    hardLimitUsd,
    finalCloseoutReserveUsd,
    pendingReservationStaleAfterMs,
    includedCostPurposes: {
      conversation_turn: conversationTurn,
      tool,
      summary,
      extraction,
      sidecar,
    },
  };
}

export function readIcpCostPurposeFromMetadata(metadata: Record<string, unknown>): string | undefined {
  const icpCost = metadata.icpCost;
  if (!isRecord(icpCost) || typeof icpCost.purpose !== 'string') return undefined;
  return icpCost.purpose.trim() || undefined;
}

function mergeCostTotal(
  cost: ModelUsageCostBreakdown | undefined,
  total: number | undefined,
  field: string,
): ModelUsageCostBreakdown | undefined {
  if (!cost && total === undefined) return undefined;
  if (
    cost?.total !== undefined
    && total !== undefined
    && Math.round(cost.total * 1_000_000_000_000) !== Math.round(total * 1_000_000_000_000)
  ) {
    throw new Error(`${field}Usd must match the structured total`);
  }
  return {
    ...(cost ?? {}),
    ...(cost?.total === undefined && total !== undefined ? { total } : {}),
  };
}


export function eventFingerprint(event: ModelUsageEvent): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(event)))
    .digest('hex');
}

export function normalizeEvent(
  input: ModelUsageEventInput,
  expectedCompanionId?: string,
): ModelUsageEvent {
  const declaredCurrency = optionalText(input.currency)?.toUpperCase();
  if (declaredCurrency && declaredCurrency !== 'USD') {
    throw new Error('currency must be USD until explicit currency conversion is implemented');
  }
  const recordedAtMs = inputNonNegativeInteger(input.recordedAtMs, 'recordedAtMs', Date.now());
  const startedAtMs = inputNonNegativeInteger(input.startedAtMs, 'startedAtMs', recordedAtMs);
  const completedAtMs = input.completedAtMs !== undefined
    ? inputNonNegativeInteger(input.completedAtMs, 'completedAtMs')
    : undefined;
  const durationMs = input.durationMs !== undefined
    ? inputNonNegativeInteger(input.durationMs, 'durationMs')
    : (completedAtMs !== undefined ? Math.max(0, completedAtMs - startedAtMs) : undefined);
  const inputTokens = inputNonNegativeInteger(input.inputTokens, 'inputTokens');
  const outputTokens = inputNonNegativeInteger(input.outputTokens, 'outputTokens');
  const cacheReadTokens = inputNonNegativeInteger(input.cacheReadTokens, 'cacheReadTokens');
  const cacheWriteTokens = inputNonNegativeInteger(input.cacheWriteTokens, 'cacheWriteTokens');
  const providerCost = mergeCostTotal(input.providerCost, input.providerCostUsd, 'providerCost');
  const estimatedCost = mergeCostTotal(input.estimatedCost, input.estimatedCostUsd, 'estimatedCost');
  const effectiveCost = mergeCostTotal(input.effectiveCost, input.effectiveCostUsd, 'effectiveCost');
  const accounting = reconcileModelUsageAccounting({
    usage: {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      ...(input.totalTokens !== undefined ? { totalTokens: input.totalTokens } : {}),
    },
    ...(providerCost ? { providerCost } : {}),
    ...(estimatedCost ? { estimatedCost } : {}),
    ...(effectiveCost ? { effectiveCost } : {}),
    ...(input.costSource ? { costSource: input.costSource } : {}),
  });
  const providerCostUsd = accounting.providerCost.total;
  const estimatedCostUsd = accounting.estimatedCost.total;
  const effectiveCostUsd = accounting.effectiveCost.total;
  const logicalCallId = normalizeText(input.logicalCallId, `usage-${recordedAtMs}`);
  const attempt = inputNonNegativeInteger(input.attempt, 'attempt');
  const telemetryVisibility = normalizeTelemetryVisibility(input.telemetryVisibility);
  const operatorVisible = telemetryVisibility === 'operator_visible';
  const declaredCompanionId = optionalText(input.attribution.companionId);
  if (!expectedCompanionId && !declaredCompanionId) {
    throw new Error('Fleet model usage events require an explicit companionId attribution');
  }
  if (expectedCompanionId && declaredCompanionId && declaredCompanionId !== expectedCompanionId) {
    throw new Error(
      `Model usage companion attribution ${JSON.stringify(declaredCompanionId)} does not match `
      + `the store tenant ${JSON.stringify(expectedCompanionId)}`,
    );
  }
  const attribution = normalizeModelUsageAttribution({
    ...input.attribution,
    ...(expectedCompanionId ? { companionId: expectedCompanionId } : {}),
    // companion_private calls (e.g. blinded introspection audits) must not persist
    // turn/request/channel/tool linkage that could re-identify the private context.
    ...(operatorVisible
      ? {}
      : {
          turnId: undefined,
          requestId: undefined,
          channelId: undefined,
          toolName: undefined,
          toolCallId: undefined,
        }),
    // Embedding is the ledger origin even when it runs inside extraction or
    // retrieval request context. Preserve the enclosing session attribution,
    // but do not mislabel the metered model operation itself.
    ...(input.callKind === 'embedding' ? { originStage: 'embedding' } : {}),
  });

  return {
    id: normalizeText(input.id, `${logicalCallId}:${attempt}`),
    logicalCallId,
    attempt,
    recordedAtMs,
    startedAtMs,
    ...(completedAtMs !== undefined ? { completedAtMs } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(input.ttftMs !== undefined ? { ttftMs: inputNonNegativeInteger(input.ttftMs, 'ttftMs') } : {}),
    dayKey: dayKey(recordedAtMs),
    monthKey: monthKey(recordedAtMs),
    status: input.status,
    settlement: input.settlement ?? (input.status === 'success' ? 'complete' : 'unknown'),
    callKind: input.callKind,
    telemetryVisibility,
    attribution,
    provider: normalizeText(input.provider, 'unknown'),
    model: normalizeText(input.model, 'unknown'),
    ...(optionalText(input.slotKey) ? { slotKey: optionalText(input.slotKey) } : {}),
    ...(optionalText(input.requestedProvider) ? { requestedProvider: optionalText(input.requestedProvider) } : {}),
    ...(optionalText(input.requestedModel) ? { requestedModel: optionalText(input.requestedModel) } : {}),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: accounting.usage.totalTokens,
    ...(providerCostUsd !== undefined ? { providerCostUsd } : {}),
    ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
    ...(effectiveCostUsd !== undefined ? { effectiveCostUsd } : {}),
    providerCost: accounting.providerCost,
    estimatedCost: accounting.estimatedCost,
    effectiveCost: accounting.effectiveCost,
    costSource: accounting.costSource,
    ...(optionalText(declaredCurrency ?? accounting.effectiveCost.currency ?? accounting.providerCost.currency ?? accounting.estimatedCost.currency)
      ? { currency: optionalText(declaredCurrency ?? accounting.effectiveCost.currency ?? accounting.providerCost.currency ?? accounting.estimatedCost.currency) }
      : {}),
    ...(optionalText(input.stopReason) ? { stopReason: optionalText(input.stopReason) } : {}),
    ...(optionalText(input.errorCode) ? { errorCode: optionalText(input.errorCode) } : {}),
    ...(optionalText(input.errorMessage) ? { errorMessage: optionalText(input.errorMessage) } : {}),
    metadata: boundModelUsageMetadata(input.metadata),
  };
}
