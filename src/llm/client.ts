import {
  getModel,
  streamSimple,
  completeSimple,
  getEnvApiKey,
  type TextContent,
  type Message,
  type UserMessage,
  type AssistantMessage,
  type Model,
} from '@mariozechner/pi-ai';
import type {
  ContextMessage,
  LLMContext,
  LLMResponse,
  StreamCallbacks,
  SubstrateConfig,
  ToolCall,
} from '../types.js';
import { createModel } from './models.js';

export class LLMClient {
  private config: SubstrateConfig;
  private litellmBaseUrl: string | null;

  constructor(config: SubstrateConfig, litellmBaseUrl?: string) {
    this.config = config;
    this.litellmBaseUrl = litellmBaseUrl ?? process.env.LITELLM_BASE_URL ?? null;
  }

  private getModelAndKey(provider: string, modelId: string, maxTokens?: number): { model: Model<any>; apiKey: string | undefined } {
    if (this.litellmBaseUrl) {
      return {
        model: createModel(this.litellmBaseUrl, modelId, maxTokens),
        apiKey: process.env.LITELLM_API_KEY ?? undefined,
      };
    }
    const model = getModel(provider as any, modelId as any);
    if (!model) {
      throw new Error(`Unknown model "${modelId}" for provider "${provider}". Set LITELLM_BASE_URL or check PRIMARY_MODEL / EXTRACTION_MODEL in .env`);
    }
    return {
      model,
      apiKey: getEnvApiKey(provider) ?? undefined,
    };
  }

  async stream(context: LLMContext, callbacks?: StreamCallbacks): Promise<LLMResponse> {
    const { model, apiKey } = this.getModelAndKey(
      this.config.primaryProvider,
      this.config.primaryModel,
    );

    try {
      const eventStream = streamSimple(
        model,
        {
          systemPrompt: context.systemPrompt,
          messages: toPiMessages(context.messages),
        },
        { apiKey, maxTokens: 16384 },
      );

      let content = '';
      const toolCalls: ToolCall[] = [];
      let finalResponse: LLMResponse | null = null;

      for await (const event of eventStream) {
        switch (event.type) {
          case 'text_delta':
            content += event.delta;
            callbacks?.onText?.(event.delta);
            break;

          case 'toolcall_end':
            toolCalls.push({
              id: event.toolCall.id,
              name: event.toolCall.name,
              input: event.toolCall.arguments,
            });
            callbacks?.onToolCall?.(event.toolCall.name, event.toolCall.arguments);
            break;

          case 'done':
            // If text_delta events didn't fire, extract text from content blocks
            if (!content && event.message.content) {
              content = event.message.content
                .filter((block: any) => block.type === 'text')
                .map((block: any) => block.text)
                .join('');
            }
            // Normalize away stringified content block arrays from streaming
            content = normalizeContent(content);
            finalResponse = {
              content,
              toolCalls,
              model: event.message.model,
              inputTokens: event.message.usage.input,
              outputTokens: event.message.usage.output,
              stopReason: event.reason,
            };
            break;

          case 'error':
            throw new Error(event.error.errorMessage ?? 'LLM stream error');
        }
      }

      if (!finalResponse) {
        finalResponse = {
          content,
          toolCalls,
          model: String(model.id),
          inputTokens: 0,
          outputTokens: 0,
          stopReason: 'unknown',
        };
      }

      callbacks?.onDone?.(finalResponse);
      return finalResponse;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      callbacks?.onError?.(err);
      throw err;
    }
  }

  async complete(context: LLMContext, purpose: 'extraction' | 'summary'): Promise<LLMResponse> {
    const provider = purpose === 'extraction'
      ? this.config.extractionProvider
      : this.config.primaryProvider;
    const modelId = purpose === 'extraction'
      ? this.config.extractionModel
      : this.config.primaryModel;

    const { model, apiKey } = this.getModelAndKey(provider, modelId, 2048);

    const response = await completeSimple(
      model,
      {
        systemPrompt: context.systemPrompt,
        messages: toPiMessages(context.messages),
      },
      { apiKey, maxTokens: 8192 },
    );

    const content = response.content
      .filter((block): block is TextContent => block.type === 'text')
      .map(block => block.text)
      .join('');

    return {
      content: normalizeContent(content),
      toolCalls: [],
      model: response.model,
      inputTokens: response.usage.input,
      outputTokens: response.usage.output,
      stopReason: response.stopReason,
    };
  }
}

// ── Content normalization ──
// pi-ai + LiteLLM sometimes delivers content block arrays as stringified text via streaming,
// e.g. [{'type': 'text', 'text': 'actual response'}]. This strips the wrapping to prevent
// compounding on subsequent turns (stored malformatted content gets re-wrapped by the LLM).
const SQ_PREFIX = "[{'type': 'text', 'text': '";
const DQ_PREFIX = '[{"type": "text", "text": "';

function extractQuotedText(s: string, startIndex: number, quoteChar: string): string | null {
  let result = '';
  for (let i = startIndex; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      const next = s[i + 1];
      if (next === '\\') { result += '\\'; i++; }
      else if (next === quoteChar) { result += quoteChar; i++; }
      else if (next === 'n') { result += '\n'; i++; }
      else if (next === 't') { result += '\t'; i++; }
      else { result += s[i]; }
    } else if (s[i] === quoteChar) {
      // Found closing quote — return extracted text (ignore trailing garbage)
      return result;
    } else {
      result += s[i];
    }
  }
  return null; // No closing quote found
}

export function normalizeContent(content: string): string {
  let result = content;
  for (let i = 0; i < 3; i++) {
    const t = result.trim();
    if (t.startsWith(SQ_PREFIX)) {
      const extracted = extractQuotedText(t, SQ_PREFIX.length, "'");
      if (extracted !== null) { result = extracted; continue; }
    }
    if (t.startsWith(DQ_PREFIX)) {
      const extracted = extractQuotedText(t, DQ_PREFIX.length, '"');
      if (extracted !== null) { result = extracted; continue; }
    }
    break;
  }
  return result;
}

function toPiMessages(messages: ContextMessage[]): Message[] {
  const now = Date.now();
  return messages.map((m): Message => {
    if (m.role === 'user') {
      return {
        role: 'user',
        content: m.content,
        timestamp: now,
      } satisfies UserMessage;
    }
    // Assistant messages in conversation replay — construct minimal AssistantMessage
    return {
      role: 'assistant',
      content: [{ type: 'text', text: m.content }],
      api: '',
      provider: '',
      model: '',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop',
      timestamp: now,
    } satisfies AssistantMessage;
  });
}
