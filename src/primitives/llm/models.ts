// ── Routed Endpoint Model Factory ──
// Creates pi-ai Model objects for OpenAI-compatible routed endpoints.
// LiteLLM is one supported backend, not the generic abstraction itself.

import { getModels, getProviders } from '@mariozechner/pi-ai';
import type { Api, KnownProvider, Model } from '@mariozechner/pi-ai';
import type {
  LLMSystemPromptTransport,
  LLMSystemRoleCapabilityMetadata,
} from '../../shared/contracts/runtime.js';

export type OpenAICompatibleApi = 'openai-completions' | 'openai-responses';

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
  /** Supports image input */
  supportsVision?: boolean;
  /** OpenAI-compatible API shape to expose through pi-ai */
  api?: OpenAICompatibleApi;
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
 ): Model<OpenAICompatibleApi> {
  const routeLabel = config.routeLabel?.trim() || 'routed endpoint';
  return {
    id: config.modelId,
    name: `${config.modelId} (via ${routeLabel})`,
    api: config.api ?? 'openai-completions',
    provider: config.provider,
    baseUrl: config.baseUrl,
    reasoning: config.reasoning ?? false,
    input: config.supportsVision ? ['text', 'image'] : ['text'],
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
): Model<OpenAICompatibleApi> {
  return createOpenAICompatibleEndpointModel({
    ...config,
    provider: 'litellm',
    routeLabel: 'LiteLLM',
  });
}

export function createModel(
  baseUrl: string,
  modelId: string,
  maxTokens?: number,
  contextWindow?: number,
  api: OpenAICompatibleApi = 'openai-completions',
  options: {
    reasoning?: boolean;
    supportsVision?: boolean;
  } = {},
): Model<OpenAICompatibleApi> {
  return createOpenAICompatibleEndpointModel({
    baseUrl,
    modelId,
    provider: 'litellm',
    routeLabel: 'LiteLLM',
    maxTokens,
    contextWindow,
    api,
    reasoning: options.reasoning,
    supportsVision: options.supportsVision,
  });
}

function supportsOpenAIDeveloperRole(model: Model<any>): boolean {
  const provider = model.provider.trim().toLowerCase();
  const baseUrl = typeof model.baseUrl === 'string' ? model.baseUrl.toLowerCase() : '';
  const isZai = provider === 'zai' || baseUrl.includes('api.z.ai');
  const isNonStandard = provider === 'cerebras'
    || baseUrl.includes('cerebras.ai')
    || provider === 'xai'
    || baseUrl.includes('api.x.ai')
    || baseUrl.includes('chutes.ai')
    || baseUrl.includes('deepseek.com')
    || isZai
    || provider === 'opencode'
    || baseUrl.includes('opencode.ai');
  const compat = model.compat as { supportsDeveloperRole?: boolean } | undefined;
  return compat?.supportsDeveloperRole ?? !isNonStandard;
}

function resolveOpenAITransport(model: Model<any>): LLMSystemPromptTransport {
  if (model.api === 'openai-responses') {
    return model.reasoning ? 'openai_developer' : 'openai_system';
  }
  return model.reasoning && supportsOpenAIDeveloperRole(model) ? 'openai_developer' : 'openai_system';
}

export function resolveSystemRoleCapabilityMetadata(model: Model<any>): LLMSystemRoleCapabilityMetadata {
  switch (model.api) {
    case 'openai-completions':
    case 'openai-responses': {
      const supportsDeveloperRole = model.api === 'openai-responses'
        ? true
        : supportsOpenAIDeveloperRole(model);
      return {
        transport: resolveOpenAITransport(model),
        supportsSystemRole: true,
        supportsDeveloperRole,
        usesOutOfBandSystemPrompt: false,
      };
    }
    case 'anthropic':
      return {
        transport: 'anthropic_system',
        supportsSystemRole: true,
        supportsDeveloperRole: false,
        usesOutOfBandSystemPrompt: true,
      };
    case 'google-generative-ai':
    case 'google-vertex':
      return {
        transport: 'google_system_instruction',
        supportsSystemRole: true,
        supportsDeveloperRole: false,
        usesOutOfBandSystemPrompt: true,
      };
    default:
      return {
        transport: 'system_prompt',
        supportsSystemRole: true,
        supportsDeveloperRole: false,
        usesOutOfBandSystemPrompt: true,
      };
  }
}
