// ── LiteLLM Model Factory ──
// Creates pi-ai Model objects pointing at a LiteLLM proxy.
// When LITELLM_BASE_URL is set, LLMClient uses these instead of getModel().

import type { Model } from '@mariozechner/pi-ai';

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
    provider: 'litellm' as any,
    baseUrl: config.baseUrl,
    reasoning: config.reasoning ?? false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.contextWindow ?? 128_000,
    maxTokens: config.maxTokens ?? 4096,
    compat: {
      supportsStore: false,
      maxTokensField: 'max_tokens',
    },
  };
}

/** Known model defaults for Purrsephone's preferred models */
const MODEL_DEFAULTS: Record<string, Partial<LiteLLMModelConfig>> = {
  'z-ai/glm-5': { contextWindow: 128_000, maxTokens: 16384, reasoning: true },
  'deepseek/deepseek-v3.2': { contextWindow: 128_000, maxTokens: 16384 },
  'moonshotai/kimi-k2.5': { contextWindow: 128_000, maxTokens: 16384, reasoning: true },
};

/**
 * Create a LiteLLM model with sensible defaults for known models.
 * Falls back to generic defaults for unknown model IDs.
 */
export function createModel(baseUrl: string, modelId: string, maxTokens?: number): Model<'openai-completions'> {
  const defaults = MODEL_DEFAULTS[modelId] ?? {};
  return createLiteLLMModel({
    baseUrl,
    modelId,
    contextWindow: defaults.contextWindow,
    maxTokens: maxTokens ?? defaults.maxTokens,
    reasoning: defaults.reasoning,
  });
}
