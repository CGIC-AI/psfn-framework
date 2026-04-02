// ── Routed Endpoint Model Factory ──
// Creates pi-ai Model objects for OpenAI-compatible routed endpoints.
// LiteLLM is one supported backend, not the generic abstraction itself.

import { getModels, getProviders } from '@mariozechner/pi-ai';
import type { Api, KnownProvider, Model } from '@mariozechner/pi-ai';

export interface OpenAICompatibleEndpointModelConfig {
  /** OpenAI-compatible base URL, e.g. http://localhost:4000/v1 */
  baseUrl: string;
  /** Model ID as expected by the routed endpoint */
  modelId: string;
  /** Logical provider identifier for routing and telemetry */
  provider: string;
  /** Human-readable route label for operator and test clarity */
  routeLabel?: string;
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
 * Create a pi-ai Model that routes through an OpenAI-compatible endpoint.
 */
export function createOpenAICompatibleEndpointModel(
  config: OpenAICompatibleEndpointModelConfig,
 ): Model<'openai-completions'> {
  const routeLabel = config.routeLabel?.trim() || 'routed endpoint';
  return {
    id: config.modelId,
    name: `${config.modelId} (via ${routeLabel})`,
    api: 'openai-completions',
    provider: config.provider,
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
 * Create a pi-ai Model that routes through LiteLLM.
 * LiteLLM handles the upstream provider credentials behind a virtual key.
 */
export function createLiteLLMModel(
  config: Omit<OpenAICompatibleEndpointModelConfig, 'provider' | 'routeLabel'>,
): Model<'openai-completions'> {
  return createOpenAICompatibleEndpointModel({
    ...config,
    provider: 'litellm',
    routeLabel: 'LiteLLM',
  });
}
