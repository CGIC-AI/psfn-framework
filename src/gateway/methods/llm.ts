import type {
  LLMChatParams,
  LLMCompleteParams,
  LLMEmbedParams,
  LLMChunkNotification,
} from '../protocol.js';
import type { AuditedMethodDescriptor, GatewayMethodRuntime } from './types.js';
import { registerAuditedDescriptors } from './register.js';

const llmDescriptors: Array<AuditedMethodDescriptor<any, unknown>> = [
  {
    name: 'llm.chat',
    handler: async (params: LLMChatParams, runtime) => {
      const requestId = params.requestId ?? runtime.nextStreamRequestId();
      const response = await runtime.llmProvider.stream(
        {
          systemPrompt: params.systemPrompt,
          messages: params.messages,
          ...(params.tools?.length ? { tools: params.tools } : {}),
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
    summary: (p: LLMChatParams) => ({ model: p.model, stream: p.stream }),
  },
  {
    name: 'llm.complete',
    handler: async (params: LLMCompleteParams, runtime) => {
      const response = await runtime.llmProvider.complete(
        { systemPrompt: params.systemPrompt, messages: params.messages },
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
    summary: (p: LLMCompleteParams) => ({ purpose: p.purpose }),
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
