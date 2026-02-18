import {
  getModel,
  streamSimple,
  completeSimple,
  getEnvApiKey,
  type Model,
} from '@mariozechner/pi-ai';
import type {
  CompletionPurpose,
  LLMContext,
  LLMResponse,
  StreamCallbacks,
  SubstrateConfig,
  ToolCall,
} from '../types.js';
import { createModel } from './models.js';
import { withRetry, markErrorAsNonRetryable } from './retry.js';
import { llmRetryConfig } from './retry-config.js';
import {
  extractReasoningContent,
  extractTextContent,
  toPiContext,
} from './conversion.js';
import { createComponentLogger } from '../logger.js';

const log = createComponentLogger('LLMClient');

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

    const piContext = toPiContext(context);

    try {
      const finalResponse = await withRetry(async () => {
        const eventStream = streamSimple(
          model,
          piContext,
          { apiKey, maxTokens: this.config.primaryMaxTokens },
        );

        let content = '';
        let reasoning = '';
        const toolCalls: ToolCall[] = [];
        let response: LLMResponse | null = null;
        let emittedData = false;

        try {
          for await (const event of eventStream) {
            switch (event.type) {
              case 'text_delta':
                emittedData = true;
                content += event.delta;
                callbacks?.onText?.(event.delta);
                break;

              case 'thinking_delta':
                emittedData = true;
                reasoning += event.delta;
                break;

              case 'toolcall_end':
                emittedData = true;
                toolCalls.push({
                  id: event.toolCall.id,
                  name: event.toolCall.name,
                  input: event.toolCall.arguments,
                });
                callbacks?.onToolCall?.(event.toolCall.name, event.toolCall.arguments);
                break;

              case 'done': {
                // If text_delta events didn't fire, extract text from content blocks
                if (!content && event.message.content) {
                  content = extractTextContent(event.message.content as unknown[]);
                }
                // Extract reasoning from content blocks if thinking_delta didn't fire
                if (!reasoning && event.message.content) {
                  reasoning = extractReasoningContent(event.message.content as unknown[]);
                }
                // Normalize away stringified content block arrays from streaming
                content = normalizeContent(content);
                response = {
                  content,
                  ...(reasoning ? { reasoning } : {}),
                  toolCalls,
                  model: event.message.model,
                  inputTokens: event.message.usage.input,
                  outputTokens: event.message.usage.output,
                  stopReason: event.reason,
                };
                break;
              }

              case 'error': {
                const error = new Error(event.error.errorMessage ?? 'LLM stream error');
                if (emittedData) {
                  markErrorAsNonRetryable(error);
                }
                throw error;
              }
            }
          }
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          if (emittedData) {
            markErrorAsNonRetryable(err);
          }
          throw err;
        }

        if (response) {
          return response;
        }

        log.warn('Stream completed without done event', { model: String(model.id), hasContent: !!content });
        return {
          content,
          ...(reasoning ? { reasoning } : {}),
          toolCalls,
          model: String(model.id),
          inputTokens: 0,
          outputTokens: 0,
          stopReason: 'unknown',
        };
      }, llmRetryConfig(this.config), {
        onRetry: ({ attempt, maxRetries, delayMs, error }) => {
          log.warn('LLM stream failed, retrying', {
            model: String(model.id),
            attempt,
            maxRetries,
            delayMs,
            error: error.message,
          });
        },
      });

      callbacks?.onDone?.(finalResponse);
      return finalResponse;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      callbacks?.onError?.(err);
      throw err;
    }
  }

  async complete(context: LLMContext, purpose: CompletionPurpose): Promise<LLMResponse> {
    const { provider, modelId, maxTokens } = this.resolveCompletionTarget(purpose);
    const { model, apiKey } = this.getModelAndKey(provider, modelId, maxTokens);

    const piContext = toPiContext(context);
    const response = await withRetry(
      () => completeSimple(
        model,
        piContext,
        { apiKey, maxTokens },
      ),
      llmRetryConfig(this.config),
      {
        onRetry: ({ attempt, maxRetries, delayMs, error }) => {
          log.warn('LLM complete failed, retrying', {
            model: String(model.id),
            purpose,
            attempt,
            maxRetries,
            delayMs,
            error: error.message,
          });
        },
      },
    );

    const content = extractTextContent(response.content as unknown[]);
    const reasoning = extractReasoningContent(response.content as unknown[]);

    return {
      content: normalizeContent(content),
      ...(reasoning ? { reasoning } : {}),
      toolCalls: [],
      model: response.model,
      inputTokens: response.usage.input,
      outputTokens: response.usage.output,
      stopReason: response.stopReason,
    };
  }

  private resolveCompletionTarget(purpose: CompletionPurpose): {
    provider: string;
    modelId: string;
    maxTokens: number;
  } {
    if (purpose === 'extraction') {
      return {
        provider: this.config.extractionProvider,
        modelId: this.config.extractionModel,
        maxTokens: this.config.extractionMaxTokens,
      };
    }

    if (purpose === 'reasoning') {
      const reasoningSlot = this.config.modelRoster.reasoning ?? this.config.modelRoster.chat;
      if (reasoningSlot) {
        return {
          provider: reasoningSlot.provider,
          modelId: reasoningSlot.model,
          maxTokens: reasoningSlot.maxTokens,
        };
      }
    }

    return {
      provider: this.config.primaryProvider,
      modelId: this.config.primaryModel,
      maxTokens: this.config.primaryMaxTokens,
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

export { toPiTools } from './conversion.js';
