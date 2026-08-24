// ── Routed Endpoint Model Factory ──
// Creates pi-ai Model objects for OpenAI-compatible routed endpoints, such as
// a configured shared OpenAI-compatible router.

import type { Api, Model } from '@earendil-works/pi-ai';
import type {
  LLMSystemPromptTransport,
  LLMSystemRoleCapabilityMetadata,
  ModelApiKind,
  ModelRegistryCostMetadata,
} from '../../shared/contracts/runtime.js';

interface ModelLookupRuntime {
  getModels(provider: string): readonly Model<Api>[];
}

export type OpenAICompatibleApi = ModelApiKind;

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
  /** Reviewed per-million-token catalog cost used for estimates. */
  cost?: ModelRegistryCostMetadata;
  /** Format for reasoning parameter — required when reasoning: true */
  thinkingFormat?: 'openai' | 'zai' | 'qwen';
}

function resolveRoutedThinkingFormat(
  modelId: string,
  configured: OpenAICompatibleEndpointModelConfig['thinkingFormat'],
): OpenAICompatibleEndpointModelConfig['thinkingFormat'] | 'openrouter' {
  if (configured) return configured;
  // Routed endpoint model ids use the first path segment as the upstream
  // protocol owner. Preserve that explicit OpenRouter namespace so pi-ai emits
  // `reasoning: { effort: "none" }` when thinking is not enabled. Treating the
  // same id as generic OpenAI omits the off control, and GLM-4.5V defaults to
  // thinking until it can exhaust the response budget without answer text.
  return modelId.startsWith('openrouter/') ? 'openrouter' : undefined;
}

export function usesDirectZaiEndpoint(baseUrl: string): boolean {
  return /^https?:\/\/(?:api\.z\.ai|open\.bigmodel\.cn)(?=[:/]|$)/iu.test(baseUrl.trim());
}

export function requiresThinkingDisabledForRequiredTools(
  api: unknown,
  baseUrl: unknown,
): boolean {
  if (api !== 'openai-completions' || typeof baseUrl !== 'string') return false;
  return /^https:\/\/api\.kimi\.com\/coding(?:\/|$)/iu.test(baseUrl.trim());
}

function supportsOpenAIDeveloperRoleAtEndpoint(provider: string, baseUrl: string): boolean {
  const normalizedProvider = provider.trim().toLowerCase();
  const normalizedBaseUrl = baseUrl.trim().toLowerCase();
  const isZai = normalizedProvider === 'zai' || normalizedBaseUrl.includes('api.z.ai');
  const isMoonshot = normalizedProvider === 'moonshotai'
    || normalizedProvider === 'moonshotai-cn'
    || normalizedBaseUrl.includes('api.moonshot.')
    || normalizedBaseUrl.includes('api.kimi.com');
  const isCloudflareWorkersAI = normalizedProvider === 'cloudflare-workers-ai'
    || normalizedBaseUrl.includes('api.cloudflare.com');
  const isCloudflareAiGateway = normalizedProvider === 'cloudflare-ai-gateway'
    || normalizedBaseUrl.includes('gateway.ai.cloudflare.com');
  const isNonStandard = normalizedProvider === 'cerebras'
    || normalizedBaseUrl.includes('cerebras.ai')
    || normalizedProvider === 'xai'
    || normalizedBaseUrl.includes('api.x.ai')
    || normalizedBaseUrl.includes('chutes.ai')
    || normalizedBaseUrl.includes('deepseek.com')
    || isZai
    || isMoonshot
    || normalizedProvider === 'opencode'
    || normalizedBaseUrl.includes('opencode.ai')
    || isCloudflareWorkersAI
    || isCloudflareAiGateway;
  return !isNonStandard;
}

export function resolveRegisteredModel(
  runtime: ModelLookupRuntime,
  provider: string,
  modelId: string,
): Model<Api> | null {
  const models = runtime.getModels(provider);
  if (!Array.isArray(models)) return null;
  return models.find((model) => model.id === modelId) ?? null;
}

/**
 * Create a pi-ai Model that routes through an OpenAI-compatible endpoint.
 */
export function createOpenAICompatibleEndpointModel(
  config: OpenAICompatibleEndpointModelConfig,
 ): Model<OpenAICompatibleApi> {
  const routeLabel = config.routeLabel?.trim() || 'routed endpoint';
  const thinkingFormat = resolveRoutedThinkingFormat(config.modelId, config.thinkingFormat);
  return {
    id: config.modelId,
    name: `${config.modelId} (via ${routeLabel})`,
    api: config.api ?? 'openai-completions',
    provider: config.provider,
    baseUrl: config.baseUrl,
    reasoning: config.reasoning ?? false,
    input: config.supportsVision ? ['text', 'image'] : ['text'],
    cost: {
      input: config.cost?.inputPer1MUsd ?? 0,
      output: config.cost?.outputPer1MUsd ?? 0,
      cacheRead: config.cost?.cacheReadPer1MUsd ?? 0,
      cacheWrite: config.cost?.cacheWritePer1MUsd ?? 0,
    },
    contextWindow: config.contextWindow ?? 128_000,
    maxTokens: config.maxTokens ?? 4096,
    compat: {
      supportsStore: false,
      maxTokensField: 'max_tokens',
      ...(!supportsOpenAIDeveloperRoleAtEndpoint(config.provider, config.baseUrl)
        ? { supportsDeveloperRole: false }
        : {}),
      ...(usesDirectZaiEndpoint(config.baseUrl) ? { zaiToolStream: true } : {}),
      ...(config.reasoning && thinkingFormat
        ? { thinkingFormat }
        : {}),
    },
  };
}

function supportsOpenAIDeveloperRole(model: Model<any>): boolean {
  const compat = model.compat as { supportsDeveloperRole?: boolean } | undefined;
  return compat?.supportsDeveloperRole ?? supportsOpenAIDeveloperRoleAtEndpoint(
    model.provider,
    typeof model.baseUrl === 'string' ? model.baseUrl : '',
  );
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
