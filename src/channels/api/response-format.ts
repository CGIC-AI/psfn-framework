import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
} from './types.js';

export interface ApiErrorEnvelope {
  error: {
    message: string;
    type: string;
    param: null;
    code: null;
    details?: Record<string, unknown>;
  };
}

export interface ApiModelListResponse {
  object: 'list';
  data: [{
    id: string;
    object: 'model';
    created: number;
    owned_by: 'psfn';
  }];
}

export interface ChatCompletionResponseInput {
  id: string;
  created: number;
  model: string;
  content: string;
  inputTokens: number;
  outputTokens: number;
}

export interface StreamingChunkMetadata {
  completionId: string;
  created: number;
  model: string;
}

export const SSE_RESPONSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
} as const;

export function buildApiErrorEnvelope(
  type: string,
  message: string,
  details?: Record<string, unknown>,
): ApiErrorEnvelope {
  return {
    error: {
      message,
      type,
      param: null,
      code: null,
      ...(details ? { details } : {}),
    },
  };
}

export function buildModelListResponse(
  modelName: string,
  createdUnixSeconds: number,
): ApiModelListResponse {
  return {
    object: 'list',
    data: [{
      id: modelName,
      object: 'model',
      created: createdUnixSeconds,
      owned_by: 'psfn',
    }],
  };
}

export function buildChatCompletionResponse(
  input: ChatCompletionResponseInput,
): ChatCompletionResponse {
  return {
    id: input.id,
    object: 'chat.completion',
    created: input.created,
    model: input.model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: input.content },
      finish_reason: 'stop',
    }],
    usage: {
      prompt_tokens: input.inputTokens,
      completion_tokens: input.outputTokens,
      total_tokens: input.inputTokens + input.outputTokens,
    },
  };
}

export function buildStreamingRoleChunk(metadata: StreamingChunkMetadata): ChatCompletionChunk {
  return {
    id: metadata.completionId,
    object: 'chat.completion.chunk',
    created: metadata.created,
    model: metadata.model,
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  };
}

export function buildStreamingContentChunk(
  metadata: StreamingChunkMetadata,
  content: string,
): ChatCompletionChunk {
  return {
    id: metadata.completionId,
    object: 'chat.completion.chunk',
    created: metadata.created,
    model: metadata.model,
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  };
}

export function buildStreamingFinishChunk(metadata: StreamingChunkMetadata): ChatCompletionChunk {
  return {
    id: metadata.completionId,
    object: 'chat.completion.chunk',
    created: metadata.created,
    model: metadata.model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  };
}

export function buildStreamingErrorChunk(
  metadata: StreamingChunkMetadata,
  content: string,
): ChatCompletionChunk {
  return {
    id: metadata.completionId,
    object: 'chat.completion.chunk',
    created: metadata.created,
    model: metadata.model,
    choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }],
  };
}

export function formatSseDataEvent(chunk: ChatCompletionChunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

export function formatSseDoneEvent(): string {
  return 'data: [DONE]\n\n';
}
