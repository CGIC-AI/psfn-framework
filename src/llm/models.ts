// ── LiteLLM Model Factory ──
// Creates pi-ai Model objects pointing at a LiteLLM proxy.
// When LITELLM_BASE_URL is set, LLMClient uses these instead of getModel().

import { getModels, getProviders } from '@mariozechner/pi-ai';
import type { Api, KnownProvider, Model } from '@mariozechner/pi-ai';

export interface LiteLLMModelConfig {
  /** LiteLLM proxy base URL, e.g. http://localhost:4000/v1 */
  baseUrl: string;
  /** Model ID as known to LiteLLM (e.g. z-ai/glm-5) */
  modelId: string;
  /** Context window size in tokens */
  contextWindow?: number;
  /** Max output tokens */
  maxTokens?: number;
  /** Supports reasoning/thinking blocks */
  reasoning?: boolean;
  /** Format for reasoning parameter — required when reasoning: true */
  thinkingFormat?: 'openai' | 'zai' | 'qwen';
}

function isKnownProvider(provider: string): provider is KnownProvider {
  const providers = getProviders();
  return Array.isArray(providers) && providers.some((knownProvider) => knownProvider === provider);
}

export function resolveRegisteredModel(provider: string, modelId: string): Model<Api> | null {
  if (!isKnownProvider(provider)) return null;
  return getModels(provider).find((model) => model.id === modelId) ?? null;
}

/**
 * Create a pi-ai Model that routes through LiteLLM proxy.
 * The proxy handles real API keys — the agent only needs a virtual key.
 */
export function createLiteLLMModel(config: LiteLLMModelConfig): Model<'openai-completions'> {
  return {
    id: config.modelId,
    name: `${config.modelId} (via LiteLLM)`,
    api: 'openai-completions',
    provider: 'litellm',
    baseUrl: config.baseUrl,
    reasoning: config.reasoning ?? false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.contextWindow ?? 128_000,
    maxTokens: config.maxTokens ?? 4096,
    compat: {
      supportsStore: false,
      maxTokensField: 'max_tokens',
      ...(config.reasoning && config.thinkingFormat ? { thinkingFormat: config.thinkingFormat } : {}),
    },
  };
}

/**
 * Create a LiteLLM model using caller-provided routing metadata.
 */
export function createModel(
  baseUrl: string,
  modelId: string,
  maxTokens?: number,
  contextWindow?: number,
): Model<'openai-completions'> {
  return createLiteLLMModel({
    baseUrl,
    modelId,
    contextWindow,
    maxTokens,
  });
}
