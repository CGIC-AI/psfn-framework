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
import { stripChargeAttribution } from '../../shared/telemetry/model-usage-attribution.js';

/** zn2iy: optional per-call cancellation, forwarded to the wrapped provider. */
interface EmbeddingUsageCancellation {
  signal?: AbortSignal;
}

interface EmbeddingProviderWithUsage extends EmbeddingRuntimeProvider {
  embedBatchWithUsage?(
    texts: string[],
    options?: EmbeddingUsageCancellation,
  ): Promise<EmbeddingBatchWithUsageResult>;
}

export interface AccountedEmbeddingRuntimeProvider extends EmbeddingRuntimeProvider {
  readonly recordsModelUsageInternally: true;
  embedBatchWithUsage(
    texts: string[],
    options?: EmbeddingUsageCancellation,
  ): Promise<EmbeddingBatchWithUsageResult>;
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
    const correlation = stripChargeAttribution(getRequestContext() ?? {});
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
        ...(correlation.companionId
          ? { companionId: correlation.companionId }
          : (options.companionId ? { companionId: options.companionId } : {})),
        ...(correlation.sessionId ? { sessionId: correlation.sessionId } : {}),
        ...(correlation.channelId ? { channelId: correlation.channelId } : {}),
        ...(correlation.channelType ? { channelType: correlation.channelType } : {}),
        callType: 'memory',
        purpose: 'embedding',
        originType: correlation.originType ?? correlation.callType ?? 'memory',
        originStage: correlation.originStage ?? 'embedding',
        service: 'memory',
        process: 'embedding',
        ...(correlation.turnId ? { turnId: correlation.turnId } : {}),
        ...(correlation.requestId ? { requestId: correlation.requestId } : {}),
        ...(correlation.toolName ? { toolName: correlation.toolName } : {}),
        ...(correlation.toolCallId ? { toolCallId: correlation.toolCallId } : {}),
        ...(correlation.shardId ? { shardId: correlation.shardId } : {}),
        ...(correlation.subagentId ? { subagentId: correlation.subagentId } : {}),
        ...(correlation.conversationId ? { conversationId: correlation.conversationId } : {}),
        ...(correlation.rootInitiationId ? { rootInitiationId: correlation.rootInitiationId } : {}),
        ...(correlation.workloadType ? { workloadType: correlation.workloadType } : {}),
        ...(correlation.workloadId ? { workloadId: correlation.workloadId } : {}),
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

  const embedBatchWithUsage = async (
    texts: string[],
    options?: EmbeddingUsageCancellation,
  ): Promise<EmbeddingBatchWithUsageResult> => {
    if (texts.length === 0) return { embeddings: [] };
    const logicalCallId = `embedding:${randomUUID()}`;
    const startedAtMs = Date.now();
    let result: EmbeddingBatchWithUsageResult;
    try {
      result = provider.embedBatchWithUsage
        ? await provider.embedBatchWithUsage(texts, options)
        : { embeddings: await provider.embedBatch(texts, options) };
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
    async embed(text: string, options?: EmbeddingUsageCancellation): Promise<Float32Array> {
      const result = await embedBatchWithUsage([text], options);
      const first = result.embeddings[0];
      if (!first) throw new Error('Embedding returned no results');
      return first;
    },
    async embedBatch(texts: string[], options?: EmbeddingUsageCancellation): Promise<Float32Array[]> {
      return (await embedBatchWithUsage(texts, options)).embeddings;
    },
    embedBatchWithUsage,
  };
}
