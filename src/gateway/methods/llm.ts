import type {
  LLMChatParams,
  LLMCompleteParams,
  LLMEmbedParams,
  LLMChunkNotification,
} from '../protocol.js';
import type { AuditedMethodDescriptor, GatewayMethodRuntime } from './types.js';
import type { CorrelationMetadata, CompletionPurpose, ObservabilityCallType } from '../../types.js';
import { registerAuditedDescriptors } from './register.js';
import {
  inferCallType as inferCorrelationCallType,
  resolveCorrelationMetadata,
} from '../../llm/correlation.js';

const llmDescriptors: Array<AuditedMethodDescriptor<any, unknown>> = [
  {
    name: 'llm.chat',
    handler: async (params: LLMChatParams, runtime) => {
      const requestId = params.requestId ?? runtime.nextStreamRequestId();
      const correlation = buildCorrelation({
        turnId: params.turnId,
        requestId,
        channelId: params.channelId,
        callType: params.callType ?? 'chat',
        originType: params.originType,
        originStage: params.originStage,
        toolName: params.toolName,
        toolCallId: params.toolCallId,
        purpose: params.purpose ?? 'chat',
      });
      const response = await runtime.llmProvider.stream(
        {
          systemPrompt: params.systemPrompt,
          messages: params.messages,
          ...(params.tools?.length ? { tools: params.tools } : {}),
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
      model: p.model,
      stream: p.stream,
      ...toSummaryCorrelation(buildCorrelation({
        turnId: p.turnId,
        requestId: p.requestId,
        channelId: p.channelId,
        callType: p.callType ?? 'chat',
        originType: p.originType,
        originStage: p.originStage,
        toolName: p.toolName,
        toolCallId: p.toolCallId,
        purpose: p.purpose ?? 'chat',
      })),
    }),
  },
  {
    name: 'llm.complete',
    handler: async (params: LLMCompleteParams, runtime) => {
      const correlation = buildCorrelation({
        turnId: params.turnId,
        requestId: params.requestId ?? params.turnId,
        channelId: params.channelId,
        callType: params.callType ?? inferCallType(params.purpose, params.channelId),
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
      purpose: p.purpose,
      ...toSummaryCorrelation(buildCorrelation({
        turnId: p.turnId,
        requestId: p.requestId ?? p.turnId,
        channelId: p.channelId,
        callType: p.callType ?? inferCallType(p.purpose, p.channelId),
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
];

export function registerLLMMethods(runtime: GatewayMethodRuntime): void {
  registerAuditedDescriptors(runtime, llmDescriptors);
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
