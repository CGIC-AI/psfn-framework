// ── pi-agent-core Stream Adapter ──
// Bridges our LLM configuration into pi-agent-core's StreamFn interface.
// Single-process: wraps streamSimple with LiteLLM proxy / direct provider apiKey.
// Gateway mode: would use GatewayClient (future, PSFN-d5n).

import { streamSimple, getEnvApiKey } from '@mariozechner/pi-ai';
import type { Model } from '@mariozechner/pi-ai';
import type { StreamFn } from '@mariozechner/pi-agent-core';
import type {
  MessageModelOverride,
  ModelPurpose,
  SubstrateConfig,
} from '../types.js';
import { createModel, resolveRegisteredModel } from '../llm/models.js';
import { withRetry } from '../llm/retry.js';
import { llmRetryConfig } from '../llm/retry-config.js';
import { createComponentLogger } from '../logger.js';
import { getRequestContext } from '../llm/request-context.js';
import { toCorrelationLogFields } from '../llm/correlation.js';

const log = createComponentLogger('StreamAdapter');

/**
 * Create a StreamFn for pi-agent-core's Agent.
 *
 * The returned function wraps `streamSimple` with the API key resolved
 * from our config (LiteLLM proxy key or provider env key).
 *
 * The model is passed in by the Agent — use `resolveModel()` to create it
 * from SubstrateConfig and set it via `agent.setModel()`.
 */
export function createSubstrateStreamFn(config: SubstrateConfig): StreamFn {
  const litellmBaseUrl = process.env.LITELLM_BASE_URL ?? null;

  return (model, context, options) => {
    const correlationFields = toCorrelationLogFields(getRequestContext());
    const modelProvider = resolveModelProvider(model);
    // Resolve API key: prefer caller's, then LiteLLM key, then provider env key
    const apiKey = options?.apiKey
      ?? (litellmBaseUrl ? process.env.LITELLM_API_KEY : undefined)
      ?? (modelProvider ? getEnvApiKey(modelProvider) : undefined)
      ?? getEnvApiKey(config.primaryProvider)
      ?? undefined;

    return withRetry(
      async () => streamSimple(model, context, {
        ...options,
        apiKey,
      }),
      llmRetryConfig(config),
      {
        onRetry: ({ attempt, maxRetries, delayMs, error }) => {
          log.warn('LLM stream failed, retrying', {
            model: String(model.id),
            attempt,
            maxRetries,
            delayMs,
            error: error.message,
            ...correlationFields,
          });
        },
      },
    );
  };
}

function resolveModelProvider(model: Model<any>): string | undefined {
  const provider = (model as { provider?: unknown }).provider;
  return typeof provider === 'string' && provider.trim().length > 0
    ? provider
    : undefined;
}

/**
 * Resolve a pi-ai Model object from SubstrateConfig for a given purpose.
 *
 * Uses LiteLLM proxy if LITELLM_BASE_URL is set, otherwise falls back
 * to pi-ai's built-in model registry via resolveRegisteredModel().
 */
export function resolveModel(
  config: SubstrateConfig,
  purpose: ModelPurpose = 'chat',
): Model<any> {
  const litellmBaseUrl = process.env.LITELLM_BASE_URL ?? null;

  // Resolve slot with fallback chains: background→chat, reasoning→chat, longContext→chat
  const slot = config.modelRoster[purpose]
    ?? (purpose !== 'chat' ? config.modelRoster.chat : undefined);

  if (!slot) {
    throw new Error(
      `No model configured for purpose '${purpose}'. Set model roster in config or .env.`,
    );
  }

  if (litellmBaseUrl) {
    const modelId = normalizeLiteLLMModelId(slot.provider, slot.model);
    const model = createModel(litellmBaseUrl, modelId, slot.maxTokens);
    return ensurePurposeInputCapabilities(model, purpose);
  }

  // Direct provider mode — use pi-ai's built-in registry.
  // resolveRegisteredModel() handles the string→KnownProvider type boundary safely.
  const model = resolveRegisteredModel(slot.provider, slot.model);
  if (!model) {
    throw new Error(
      `Unknown model "${slot.model}" for provider "${slot.provider}". ` +
      `Set LITELLM_BASE_URL or check model roster config.`,
    );
  }
  return ensurePurposeInputCapabilities(model, purpose);
}

export function resolveExplicitModel(
  selection: MessageModelOverride,
): Model<any> {
  const litellmBaseUrl = process.env.LITELLM_BASE_URL ?? null;

  if (litellmBaseUrl) {
    const modelId = normalizeLiteLLMModelId(selection.provider, selection.model);
    const model = createModel(litellmBaseUrl, modelId, selection.maxTokens);
    return ensurePurposeInputCapabilities(model, selection.purpose);
  }

  const registered = resolveRegisteredModel(selection.provider, selection.model);
  if (!registered) {
    throw new Error(
      `Unknown model "${selection.model}" for provider "${selection.provider}". ` +
      'Use a known direct provider model or configure LiteLLM.',
    );
  }

  const resolved = {
    ...registered,
    ...(selection.maxTokens !== undefined ? { maxTokens: selection.maxTokens } : {}),
    ...(selection.contextWindow !== undefined ? { contextWindow: selection.contextWindow } : {}),
  };
  return ensurePurposeInputCapabilities(resolved, selection.purpose);
}

function ensurePurposeInputCapabilities(
  model: Model<any>,
  purpose: ModelPurpose | undefined,
): Model<any> {
  if (purpose !== 'vision') {
    return model;
  }

  const currentInput = Array.isArray(model.input)
    ? model.input.filter((cap): cap is 'text' | 'image' => cap === 'text' || cap === 'image')
    : [];
  const nextInput: Array<'text' | 'image'> = [...currentInput];
  if (!nextInput.includes('text')) nextInput.unshift('text');
  if (!nextInput.includes('image')) nextInput.push('image');

  return {
    ...model,
    input: nextInput,
  };
}

function normalizeLiteLLMModelId(provider: string, modelId: string): string {
  const normalizedProvider = provider.trim().toLowerCase();
  const normalizedModelId = modelId.trim();
  if (!normalizedModelId) return normalizedModelId;
  if (normalizedProvider !== 'openrouter') return normalizedModelId;
  if (normalizedModelId.startsWith('openrouter/')) return normalizedModelId;

  // OpenRouter model IDs are typically vendor-qualified (e.g. google/gemini-3-flash-preview).
  // In LiteLLM mode we normalize these to the openrouter/* wildcard namespace.
  return normalizedModelId.includes('/')
    ? `openrouter/${normalizedModelId}`
    : normalizedModelId;
}
