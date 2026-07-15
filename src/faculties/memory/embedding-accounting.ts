import { randomUUID } from 'node:crypto';
import type { LLMUsageDetails } from '../../shared/contracts/runtime.js';
import type { ModelUsageRecorder } from '../../shared/telemetry/model-usage.js';
import {
  reconcileModelUsageAccounting,
  type ModelUsageCostRates,
} from '../../shared/telemetry/model-usage-accounting.js';
import type {
  EmbeddingBatchWithUsageResult,
  EmbeddingRuntimeProvider,
} from './embedding.js';
import { extractProviderAttemptUsageDetails } from '../../shared/telemetry/provider-attempt-error.js';
import { hasProviderCostEvidenceConflict } from '../../shared/telemetry/provider-cost-evidence.js';
import { getRequestContext } from '../../primitives/llm/request-context.js';
import { getRunChargeSnapshot } from '../../shared/telemetry/run-charge.js';

interface EmbeddingProviderWithUsage extends EmbeddingRuntimeProvider {
  embedBatchWithUsage?(texts: string[]): Promise<EmbeddingBatchWithUsageResult>;
}

export interface AccountedEmbeddingRuntimeProvider extends EmbeddingRuntimeProvider {
  readonly recordsModelUsageInternally: true;
  embedBatchWithUsage(texts: string[]): Promise<EmbeddingBatchWithUsageResult>;
}

export interface EmbeddingUsageAccountingOptions {
  estimatedRates?: ModelUsageCostRates;
  companionId?: string;
}

export function withEmbeddingUsageAccounting(
  provider: EmbeddingProviderWithUsage,
  recorder: ModelUsageRecorder,
  options: EmbeddingUsageAccountingOptions = {},
): AccountedEmbeddingRuntimeProvider {
  const record = async (
    logicalCallId: string,
    startedAtMs: number,
    status: 'success' | 'failure',
    texts: string[],
    usageDetails?: LLMUsageDetails,
    error?: unknown,
  ): Promise<void> => {
    const completedAtMs = Date.now();
    const correlation = getRequestContext();
    const chargeSnapshot = getRunChargeSnapshot();
    const accounting = usageDetails
      ? reconcileModelUsageAccounting({
          usage: {
            inputTokens: usageDetails.input,
            outputTokens: usageDetails.output,
            cacheReadTokens: usageDetails.cacheRead,
            cacheWriteTokens: usageDetails.cacheWrite,
            totalTokens: usageDetails.totalTokens,
          },
          ...(usageDetails.cost ? { providerCost: usageDetails.cost } : {}),
          ...(options.estimatedRates ? { estimatedRates: options.estimatedRates } : {}),
        })
      : undefined;
    await recorder.recordUsageEvent({
      logicalCallId,
      attempt: 1,
      recordedAtMs: completedAtMs,
      startedAtMs,
      completedAtMs,
      durationMs: Math.max(0, completedAtMs - startedAtMs),
      status,
      settlement: usageDetails
        ? (hasProviderCostEvidenceConflict(usageDetails.raw) ? 'partial' : 'complete')
        : 'unknown',
      callKind: 'embedding',
      attribution: {
        ...(correlation?.companionId
          ? { companionId: correlation.companionId }
          : (options.companionId ? { companionId: options.companionId } : {})),
        ...(correlation?.sessionId ? { sessionId: correlation.sessionId } : {}),
        ...(correlation?.channelId ? { channelId: correlation.channelId } : {}),
        ...(correlation?.channelType ? { channelType: correlation.channelType } : {}),
        callType: 'memory',
        purpose: 'embedding',
        originType: correlation?.originType ?? correlation?.callType ?? 'memory',
        originStage: correlation?.originStage ?? 'embedding',
        service: 'memory',
        process: 'embedding',
        ...(correlation?.turnId ? { turnId: correlation.turnId } : {}),
        ...(correlation?.requestId ? { requestId: correlation.requestId } : {}),
        ...(correlation?.toolName ? { toolName: correlation.toolName } : {}),
        ...(correlation?.toolCallId ? { toolCallId: correlation.toolCallId } : {}),
        ...(chargeSnapshot?.lane
          ? { chargeLane: chargeSnapshot.lane }
          : (correlation?.chargeLane ? { chargeLane: correlation.chargeLane } : {})),
        ...(chargeSnapshot?.surface
          ? { chargeSurface: chargeSnapshot.surface }
          : { chargeSurface: provider.kind === 'api' ? 'externalEmbedding' : 'localEmbedding' }),
        ...(chargeSnapshot?.chargeEventId
          ? { chargeEventId: chargeSnapshot.chargeEventId }
          : (correlation?.chargeEventId ? { chargeEventId: correlation.chargeEventId } : {})),
        ...(chargeSnapshot?.lineage.runId
          ? { chargeRunId: chargeSnapshot.lineage.runId }
          : (correlation?.chargeRunId ? { chargeRunId: correlation.chargeRunId } : {})),
        ...(chargeSnapshot?.lineage.rootRunId
          ? { chargeRootRunId: chargeSnapshot.lineage.rootRunId }
          : (correlation?.chargeRootRunId ? { chargeRootRunId: correlation.chargeRootRunId } : {})),
        ...(chargeSnapshot?.lineage.parentRunId
          ? { chargeParentRunId: chargeSnapshot.lineage.parentRunId }
          : (correlation?.chargeParentRunId ? { chargeParentRunId: correlation.chargeParentRunId } : {})),
        ...(correlation?.shardId ? { shardId: correlation.shardId } : {}),
        ...(correlation?.subagentId ? { subagentId: correlation.subagentId } : {}),
        ...(correlation?.conversationId ? { conversationId: correlation.conversationId } : {}),
        ...(correlation?.rootInitiationId ? { rootInitiationId: correlation.rootInitiationId } : {}),
        ...(correlation?.workloadType ? { workloadType: correlation.workloadType } : {}),
        ...(correlation?.workloadId ? { workloadId: correlation.workloadId } : {}),
      },
      provider: provider.kind,
      model: provider.model,
      requestedProvider: provider.kind,
      requestedModel: provider.model,
      inputTokens: accounting?.usage.inputTokens ?? 0,
      outputTokens: accounting?.usage.outputTokens ?? 0,
      cacheReadTokens: accounting?.usage.cacheReadTokens ?? 0,
      cacheWriteTokens: accounting?.usage.cacheWriteTokens ?? 0,
      totalTokens: accounting?.usage.totalTokens ?? 0,
      ...(accounting ? {
        providerCost: accounting.providerCost,
        estimatedCost: accounting.estimatedCost,
        effectiveCost: accounting.effectiveCost,
        costSource: accounting.costSource,
        ...(accounting.providerCost.total !== undefined
          ? { providerCostUsd: accounting.providerCost.total }
          : {}),
        ...(accounting.estimatedCost.total !== undefined
          ? { estimatedCostUsd: accounting.estimatedCost.total }
          : {}),
        ...(accounting.effectiveCost.total !== undefined
          ? { effectiveCostUsd: accounting.effectiveCost.total }
          : {}),
        ...(accounting.effectiveCost.currency
          ? { currency: accounting.effectiveCost.currency }
          : {}),
      } : {}),
      ...(error ? {
        errorCode: error instanceof Error ? error.name : 'EmbeddingError',
        errorMessage: error instanceof Error ? error.message : String(error),
      } : {}),
      metadata: {
        textCount: texts.length,
        totalInputChars: texts.reduce((total, text) => total + text.length, 0),
        dims: provider.dims,
        ...(usageDetails?.raw ? { rawUsage: usageDetails.raw } : {}),
      },
    });
  };

  const embedBatchWithUsage = async (texts: string[]): Promise<EmbeddingBatchWithUsageResult> => {
    if (texts.length === 0) return { embeddings: [] };
    const logicalCallId = `embedding:${randomUUID()}`;
    const startedAtMs = Date.now();
    let result: EmbeddingBatchWithUsageResult;
    try {
      result = provider.embedBatchWithUsage
        ? await provider.embedBatchWithUsage(texts)
        : { embeddings: await provider.embedBatch(texts) };
    } catch (error) {
      await record(
        logicalCallId,
        startedAtMs,
        'failure',
        texts,
        extractProviderAttemptUsageDetails(error),
        error,
      );
      throw error;
    }
    await record(logicalCallId, startedAtMs, 'success', texts, result.usageDetails);
    return result;
  };

  return {
    kind: provider.kind,
    model: provider.model,
    dims: provider.dims,
    recordsModelUsageInternally: true,
    async embed(text: string): Promise<Float32Array> {
      const result = await embedBatchWithUsage([text]);
      return result.embeddings[0];
    },
    async embedBatch(texts: string[]): Promise<Float32Array[]> {
      return (await embedBatchWithUsage(texts)).embeddings;
    },
    embedBatchWithUsage,
  };
}
