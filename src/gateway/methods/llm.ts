import type {
  LLMChatParams,
  LLMCompleteParams,
  LLMEmbedParams,
  LLMChunkNotification,
} from '../protocol.js';
import type { AuditedMethodDescriptor, GatewayMethodRuntime } from './types.js';
import type { CorrelationMetadata, CompletionPurpose, ObservabilityCallType } from '../../types.js';
import { registerAuditedDescriptors } from './register.js';

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
        toolName: params.toolName,
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
        toolName: p.toolName,
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
        toolName: params.toolName,
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
        toolName: p.toolName,
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
  toolName?: string;
  purpose: string;
}): CorrelationMetadata {
  return {
    ...(params.turnId ? { turnId: params.turnId } : {}),
    ...(params.requestId ? { requestId: params.requestId } : {}),
    ...(params.channelId ? { channelId: params.channelId } : {}),
    callType: params.callType,
    ...(params.toolName ? { toolName: params.toolName } : {}),
    purpose: params.purpose,
  };
}

function inferCallType(
  purpose: CompletionPurpose,
  channelId: string | undefined,
): ObservabilityCallType {
  if (channelId?.toLowerCase().startsWith('internal:')) {
    return 'scheduled';
  }
  switch (purpose) {
    case 'summary':
      return 'summary';
    case 'extraction':
      return 'memory';
    case 'reasoning':
      return 'tool';
    case 'background':
    case 'import_processing':
    default:
      return 'background';
  }
}

function toSummaryCorrelation(
  correlation: CorrelationMetadata,
): Record<string, unknown> {
  return {
    ...(correlation.turnId ? { turnId: correlation.turnId } : {}),
    ...(correlation.requestId ? { requestId: correlation.requestId } : {}),
    ...(correlation.channelId ? { channelId: correlation.channelId } : {}),
    callType: correlation.callType,
    ...(correlation.toolName ? { toolName: correlation.toolName } : {}),
    purpose: correlation.purpose,
  };
}
