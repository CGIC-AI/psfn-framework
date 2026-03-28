import type {
  LLMChatParams,
  LLMCompleteParams,
  LLMDiscoverModelsParams,
  LLMDiscoverModelsResult,
  LLMEmbedParams,
  LLMInvalidateModelDiscoveryParams,
  LLMInvalidateModelDiscoveryResult,
  LLMChunkNotification,
} from '../protocol.js';
import type { AuditedMethodDescriptor, GatewayMethodRuntime } from './types.js';
import type { CorrelationMetadata, CompletionPurpose, LLMModelHint, ObservabilityCallType } from '../../../shared/contracts/runtime.js';
import { registerAuditedDescriptors } from './register.js';
import {
  inferCallType as inferCorrelationCallType,
  resolveCorrelationMetadata,
} from '../../../llm/correlation.js';

const llmDescriptors: Array<AuditedMethodDescriptor<any, unknown>> = [
  {
    name: 'llm.chat',
    handler: async (params: LLMChatParams, runtime) => {
      const shardRouting = resolveShardChannelRouting(params.channelId);
      const requestId = params.requestId ?? runtime.nextStreamRequestId();
      const callType = params.callType ?? (shardRouting ? 'tool' : 'chat');
      const purpose = normalizePurpose(params.purpose) ?? (shardRouting ? 'shard.execution' : 'chat');
      const modelHint = extractModelHintFromParams(params);
      const correlation = buildCorrelation({
        turnId: params.turnId,
        requestId,
        channelId: params.channelId,
        callType,
        originType: params.originType,
        originStage: params.originStage,
        toolName: params.toolName,
        toolCallId: params.toolCallId,
        purpose,
      });
      const response = await runtime.llmProvider.stream(
        {
          systemPrompt: params.systemPrompt,
          messages: params.messages,
          ...(params.tools?.length ? { tools: params.tools } : {}),
          ...(modelHint ? { modelHint } : {}),
          correlation,
        },
        params.stream ? {
          onText: (text) => {
            runtime.notifyAll('llm.chunk', { requestId, text } satisfies LLMChunkNotification);
          },
        } : undefined,
      );
      return {
        content: response.content,
        ...(response.reasoning ? { reasoning: response.reasoning } : {}),
        toolCalls: response.toolCalls,
        model: response.model,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        stopReason: response.stopReason,
        requestId,
      };
    },
    summary: (p: LLMChatParams) => ({
      ...toShardRoutingSummary(resolveShardChannelRouting(p.channelId)),
      model: p.model,
      stream: p.stream,
      ...toSummaryCorrelation(buildCorrelation({
        turnId: p.turnId,
        requestId: p.requestId,
        channelId: p.channelId,
        callType: p.callType ?? (resolveShardChannelRouting(p.channelId) ? 'tool' : 'chat'),
        originType: p.originType,
        originStage: p.originStage,
        toolName: p.toolName,
        toolCallId: p.toolCallId,
        purpose: normalizePurpose(p.purpose) ?? (resolveShardChannelRouting(p.channelId) ? 'shard.execution' : 'chat'),
      })),
    }),
  },
  {
    name: 'llm.complete',
    handler: async (params: LLMCompleteParams, runtime) => {
      const shardRouting = resolveShardChannelRouting(params.channelId);
      const inferredCallType = inferCallType(params.purpose, params.channelId);
      const modelHint = extractModelHintFromParams(params);
      const correlation = buildCorrelation({
        turnId: params.turnId,
        requestId: params.requestId ?? params.turnId,
        channelId: params.channelId,
        callType: params.callType ?? (shardRouting && inferredCallType === 'chat'
          ? 'tool'
          : inferredCallType),
        originType: params.originType,
        originStage: params.originStage,
        toolName: params.toolName,
        toolCallId: params.toolCallId,
        purpose: params.purpose,
      });
      const response = await runtime.llmProvider.complete(
        {
          systemPrompt: params.systemPrompt,
          messages: params.messages,
          ...(modelHint ? { modelHint } : {}),
          correlation,
        },
        params.purpose,
      );
      return {
        content: response.content,
        ...(response.reasoning ? { reasoning: response.reasoning } : {}),
        model: response.model,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        stopReason: response.stopReason,
      };
    },
    summary: (p: LLMCompleteParams) => ({
      ...toShardRoutingSummary(resolveShardChannelRouting(p.channelId)),
      purpose: p.purpose,
      ...toSummaryCorrelation(buildCorrelation({
        turnId: p.turnId,
        requestId: p.requestId ?? p.turnId,
        channelId: p.channelId,
        callType: p.callType ?? (() => {
          const shardRouting = resolveShardChannelRouting(p.channelId);
          const inferred = inferCallType(p.purpose, p.channelId);
          if (shardRouting && inferred === 'chat') return 'tool';
          return inferred;
        })(),
        originType: p.originType,
        originStage: p.originStage,
        toolName: p.toolName,
        toolCallId: p.toolCallId,
        purpose: p.purpose,
      })),
    }),
  },
  {
    name: 'llm.embed',
    handler: async (params: LLMEmbedParams, runtime) => {
      const embeddings = await runtime.embeddingService.embedBatch(params.texts);
      return { embeddings: embeddings.map(e => Array.from(e)) };
    },
    summary: (p: LLMEmbedParams) => ({ textCount: p.texts.length }),
  },
  {
    name: 'llm.discover_models',
    handler: async (_params: LLMDiscoverModelsParams, runtime): Promise<LLMDiscoverModelsResult> => {
      const discovery = requireModelDiscovery(runtime);
      return {
        models: await discovery.getAvailableModels(),
      };
    },
  },
  {
    name: 'llm.invalidate_model_discovery',
    handler: async (
      _params: LLMInvalidateModelDiscoveryParams,
      runtime,
    ): Promise<LLMInvalidateModelDiscoveryResult> => {
      const discovery = requireModelDiscovery(runtime);
      discovery.invalidateCache();
      return { success: true };
    },
  },
];

export function registerLLMMethods(runtime: GatewayMethodRuntime): void {
  registerAuditedDescriptors(runtime, llmDescriptors);
}

function requireModelDiscovery(
  runtime: GatewayMethodRuntime,
): NonNullable<GatewayMethodRuntime['modelDiscovery']> {
  if (!runtime.modelDiscovery) {
    throw new Error('Gateway model discovery is unavailable.');
  }
  return runtime.modelDiscovery;
}

function buildCorrelation(params: {
  turnId?: string;
  requestId?: string;
  channelId?: string;
  callType: ObservabilityCallType;
  originType?: ObservabilityCallType;
  originStage?: string;
  toolName?: string;
  toolCallId?: string;
  purpose: string;
}): CorrelationMetadata {
  return resolveCorrelationMetadata(
    {
      ...(params.turnId ? { turnId: params.turnId } : {}),
      ...(params.requestId ? { requestId: params.requestId } : {}),
      ...(params.channelId ? { channelId: params.channelId } : {}),
      callType: params.callType,
      ...(params.originType ? { originType: params.originType } : {}),
      ...(params.originStage ? { originStage: params.originStage } : {}),
      ...(params.toolName ? { toolName: params.toolName } : {}),
      ...(params.toolCallId ? { toolCallId: params.toolCallId } : {}),
      purpose: params.purpose,
    },
    undefined,
    params.purpose === 'chat' ? 'chat' : 'background',
  );
}

function inferCallType(
  purpose: CompletionPurpose,
  channelId: string | undefined,
): ObservabilityCallType {
  return inferCorrelationCallType(purpose, channelId);
}

function toSummaryCorrelation(
  correlation: CorrelationMetadata,
): Record<string, unknown> {
  return {
    ...(correlation.turnId ? { turnId: correlation.turnId } : {}),
    ...(correlation.requestId ? { requestId: correlation.requestId } : {}),
    ...(correlation.channelId ? { channelId: correlation.channelId } : {}),
    callType: correlation.callType,
    ...(correlation.originType ? { originType: correlation.originType } : {}),
    ...(correlation.originStage ? { originStage: correlation.originStage } : {}),
    ...(correlation.toolName ? { toolName: correlation.toolName } : {}),
    ...(correlation.toolCallId ? { toolCallId: correlation.toolCallId } : {}),
    purpose: correlation.purpose,
  };
}

function resolveShardChannelRouting(
  channelId: string | undefined,
): { shardId: string } | null {
  const normalized = channelId?.trim();
  if (!normalized || !normalized.startsWith('shard:')) {
    return null;
  }

  const shardId = normalized.slice('shard:'.length).trim();
  if (!shardId) {
    throw new Error('Shard channel routing requires a non-empty shard identifier.');
  }
  return { shardId };
}

function toShardRoutingSummary(
  shardRouting: { shardId: string } | null,
): Record<string, string> {
  if (!shardRouting) {
    return {};
  }
  return {
    routingTarget: 'shard',
    shardId: shardRouting.shardId,
  };
}

function normalizePurpose(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function extractModelHintFromParams(
  params: LLMChatParams | LLMCompleteParams,
): LLMModelHint | undefined {
  const model = normalizePurpose(params.model);
  const provider = normalizePurpose(params.provider)?.toLowerCase();
  const maxTokens = toPositiveInteger(params.maxTokens);
  const contextWindow = toPositiveInteger(params.contextWindow);
  const thinkingEnabled = typeof params.thinkingEnabled === 'boolean'
    ? params.thinkingEnabled
    : undefined;
  const thinkingEffort = toThinkingEffort(params.thinkingEffort);
  const temperature = toFiniteNumber(params.temperature);
  const topP = toUnitInterval(params.topP);
  const topK = toPositiveInteger(params.topK);
  const frequencyPenalty = toFiniteNumber(params.frequencyPenalty);
  const repetitionPenalty = toFiniteNumber(params.repetitionPenalty);
  if (
    !model
    && !provider
    && maxTokens === undefined
    && contextWindow === undefined
    && thinkingEnabled === undefined
    && thinkingEffort === undefined
    && temperature === undefined
    && topP === undefined
    && topK === undefined
    && frequencyPenalty === undefined
    && repetitionPenalty === undefined
  ) {
    return undefined;
  }
  return {
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(thinkingEnabled !== undefined ? { thinkingEnabled } : {}),
    ...(thinkingEffort !== undefined ? { thinkingEffort } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { topP } : {}),
    ...(topK !== undefined ? { topK } : {}),
    ...(frequencyPenalty !== undefined ? { frequencyPenalty } : {}),
    ...(repetitionPenalty !== undefined ? { repetitionPenalty } : {}),
  };
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}

function toPositiveInteger(value: unknown): number | undefined {
  const numeric = toFiniteNumber(value);
  if (numeric === undefined || numeric <= 0) return undefined;
  return Math.floor(numeric);
}

function toUnitInterval(value: unknown): number | undefined {
  const numeric = toFiniteNumber(value);
  if (numeric === undefined || numeric < 0 || numeric > 1) return undefined;
  return numeric;
}

function toThinkingEffort(value: unknown): LLMModelHint['thinkingEffort'] | undefined {
  switch (value) {
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return value;
    default:
      return undefined;
  }
}
