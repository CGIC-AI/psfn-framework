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
    return createModel(litellmBaseUrl, slot.model, slot.maxTokens);
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
  return model;
}

export function resolveExplicitModel(
  selection: MessageModelOverride,
): Model<any> {
  const litellmBaseUrl = process.env.LITELLM_BASE_URL ?? null;

  if (litellmBaseUrl) {
    return createModel(litellmBaseUrl, selection.model, selection.maxTokens);
  }

  const registered = resolveRegisteredModel(selection.provider, selection.model);
  if (!registered) {
    throw new Error(
      `Unknown model "${selection.model}" for provider "${selection.provider}". ` +
      'Use a known direct provider model or configure LiteLLM.',
    );
  }

  return {
    ...registered,
    ...(selection.maxTokens !== undefined ? { maxTokens: selection.maxTokens } : {}),
    ...(selection.contextWindow !== undefined ? { contextWindow: selection.contextWindow } : {}),
  };
}
