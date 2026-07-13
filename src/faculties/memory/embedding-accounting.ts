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

interface EmbeddingProviderWithUsage extends EmbeddingRuntimeProvider {
  embedBatchWithUsage?(texts: string[]): Promise<EmbeddingBatchWithUsageResult>;
}

export interface AccountedEmbeddingRuntimeProvider extends EmbeddingRuntimeProvider {
  readonly recordsModelUsageInternally: true;
  embedBatchWithUsage(texts: string[]): Promise<EmbeddingBatchWithUsageResult>;
}

export interface EmbeddingUsageAccountingOptions {
  estimatedRates?: ModelUsageCostRates;
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
      settlement: status === 'success' && usageDetails ? 'complete' : 'unknown',
      callKind: 'embedding',
      callType: 'memory',
      purpose: 'embedding',
      originType: 'memory',
      originStage: 'embedding',
      service: 'memory',
      process: 'embedding',
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
      await record(logicalCallId, startedAtMs, 'failure', texts, undefined, error);
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
