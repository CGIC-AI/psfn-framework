// ── pi-agent-core Stream Adapter ──
// Bridges our LLM configuration into pi-agent-core's StreamFn interface.
// Single-process: wraps streamSimple with LiteLLM proxy / direct provider apiKey.
// Gateway mode: would use GatewayClient (future, PSFN-d5n).

import { streamSimple, getEnvApiKey } from '@mariozechner/pi-ai';
import type { Model } from '@mariozechner/pi-ai';
import type { StreamFn } from '@mariozechner/pi-agent-core';
import type {
  ModelBudgetBlockedEvent,
  MessageModelOverride,
  ModelPurpose,
  CorrelationMetadata,
  SubstrateConfig,
} from '../types.js';
import { createModel, resolveRegisteredModel } from '../llm/models.js';
import { resolveRoutingCandidates, type RoutingCandidate, type RoutingPurpose } from '../llm/routing.js';
import { markErrorAsNonRetryable, withRetry } from '../llm/retry.js';
import { llmRetryConfig } from '../llm/retry-config.js';
import { createComponentLogger } from '../logger.js';
import { getRequestContext } from '../llm/request-context.js';
import { toCorrelationLogFields } from '../llm/correlation.js';
import {
  findRegistryEntryByModelId,
  findRegistryEntryByProviderModel,
  ModelBudgetController,
  ModelBudgetExceededError,
  normalizeModelIdForProvider,
} from '../llm/model-budget.js';

const log = createComponentLogger('StreamAdapter');

export interface SubstrateStreamRuntimeOptions {
  onBudgetBlocked?: (event: ModelBudgetBlockedEvent) => void;
}

/**
 * Create a StreamFn for pi-agent-core's Agent.
 *
 * The returned function wraps `streamSimple` with the API key resolved
 * from our config (LiteLLM proxy key or provider env key).
 *
 * The model is passed in by the Agent — use `resolveModel()` to create it
 * from SubstrateConfig and set it via `agent.setModel()`.
 */
export function createSubstrateStreamFn(
  config: SubstrateConfig,
  runtimeOptions: SubstrateStreamRuntimeOptions = {},
): StreamFn {
  const litellmBaseUrl = process.env.LITELLM_BASE_URL ?? null;
  const budgetController = new ModelBudgetController(config);

  return (model, context, options) => {
    const requestContext = getRequestContext();
    const correlationFields = toCorrelationLogFields(requestContext);
    const modelProvider = resolveModelProvider(model);
    const effectiveProvider = (modelProvider ?? config.primaryProvider).trim().toLowerCase();
    const rawModelId = String(model.id);
    const normalizedModelId = normalizeModelIdForProvider(effectiveProvider, rawModelId);
    const resolvedMaxTokens = resolveStreamMaxTokens(model, options?.maxTokens, config.primaryMaxTokens);
    const registryEntry = findRegistryEntryByProviderModel(config, effectiveProvider, normalizedModelId)
      ?? (effectiveProvider === 'litellm'
        ? findRegistryEntryByModelId(config, normalizedModelId)
        : undefined);
    const candidate: RoutingCandidate = {
      provider: registryEntry?.identity.provider ?? effectiveProvider,
      model: registryEntry?.identity.model ?? normalizedModelId,
      maxTokens: resolvedMaxTokens,
      ...(registryEntry ? { slotKey: registryEntry.id } : {}),
    };
    const purpose = resolveStreamBudgetPurpose(requestContext);
    const process = requestContext?.originStage ?? requestContext?.purpose ?? 'agent.stream.prompt';
    const service = requestContext?.callType ?? 'chat';
    const estimatedInputTokens = estimateContextInputTokens(context);
    const preflight = budgetController.evaluatePreflight({
      candidate,
      purpose,
      service,
      process,
      estimatedInputTokens,
      correlation: requestContext,
    });
    if (!preflight.allowed && preflight.blockedEvent) {
      runtimeOptions.onBudgetBlocked?.(preflight.blockedEvent);
      throw markErrorAsNonRetryable(new ModelBudgetExceededError(preflight.blockedEvent));
    }

    // Resolve API key: prefer caller's, then LiteLLM key, then provider env key
    const apiKey = options?.apiKey
      ?? (litellmBaseUrl ? process.env.LITELLM_API_KEY : undefined)
      ?? (modelProvider ? getEnvApiKey(modelProvider) : undefined)
      ?? getEnvApiKey(config.primaryProvider)
      ?? undefined;

    return withRetry(
      async () => {
        const stream = streamSimple(model, context, {
          ...options,
          apiKey,
        });

        return wrapStreamWithUsageRecording(stream, (inputTokens, outputTokens) => {
          budgetController.recordUsage({
            candidate,
            purpose,
            service,
            process,
            inputTokens,
            outputTokens,
            correlation: requestContext,
          });
        });
      },
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

function resolveStreamMaxTokens(model: Model<any>, optionsMaxTokens: unknown, fallback: number): number {
  if (typeof optionsMaxTokens === 'number' && Number.isFinite(optionsMaxTokens) && optionsMaxTokens > 0) {
    return Math.floor(optionsMaxTokens);
  }
  if (typeof model.maxTokens === 'number' && Number.isFinite(model.maxTokens) && model.maxTokens > 0) {
    return Math.floor(model.maxTokens);
  }
  return fallback;
}

function resolveStreamBudgetPurpose(context: Partial<CorrelationMetadata> | undefined): RoutingPurpose {
  const raw = context?.purpose?.toLowerCase() ?? '';
  if (raw.includes('vision')) return 'vision';
  if (raw.includes('reasoning')) return 'reasoning';
  if (raw.includes('summary')) return 'summary';
  if (raw.includes('extraction')) return 'extraction';
  if (raw.includes('import')) return 'import_processing';
  if (raw.includes('background')) return 'background';
  if (raw.includes('context')) return 'context';
  if (raw.includes('longcontext') || raw.includes('long_context')) return 'context';
  return 'chat';
}

function estimateContextInputTokens(context: unknown): number {
  const countChars = (value: unknown): number => {
    if (typeof value === 'string') return value.length;
    if (Array.isArray(value)) return value.reduce((sum, entry) => sum + countChars(entry), 0);
    if (value && typeof value === 'object') {
      return Object.values(value as Record<string, unknown>).reduce((sum, entry) => sum + countChars(entry), 0);
    }
    return 0;
  };
  const charCount = countChars(context);
  return Math.max(1, Math.ceil(charCount / 4));
}

function wrapStreamWithUsageRecording(
  stream: AsyncIterable<any>,
  onDone: (inputTokens: number, outputTokens: number) => void,
): AsyncIterable<any> {
  return (async function* streamWithUsage() {
    for await (const event of stream) {
      if (event?.type === 'done') {
        const inputTokens = Number.isFinite(event?.message?.usage?.input) ? Math.floor(event.message.usage.input) : 0;
        const outputTokens = Number.isFinite(event?.message?.usage?.output) ? Math.floor(event.message.usage.output) : 0;
        onDone(inputTokens, outputTokens);
      }
      yield event;
    }
  })();
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
  const selection = resolveModelSelection(config, purpose);

  if (litellmBaseUrl) {
    const modelId = normalizeLiteLLMModelId(selection.provider, selection.model);
    const model = createModel(litellmBaseUrl, modelId, selection.maxTokens);
    return ensurePurposeInputCapabilities(model, purpose);
  }

  // Direct provider mode — use pi-ai's built-in registry.
  // resolveRegisteredModel() handles the string→KnownProvider type boundary safely.
  const model = resolveRegisteredModel(selection.provider, selection.model);
  if (!model) {
    throw new Error(
      `Unknown model "${selection.model}" for provider "${selection.provider}". ` +
      'Set LITELLM_BASE_URL or update the canonical model config in models.json.',
    );
  }
  return ensurePurposeInputCapabilities(model, purpose);
}

export function resolveModelSelection(
  config: SubstrateConfig,
  purpose: ModelPurpose = 'chat',
): RoutingCandidate {
  const routingPurpose = toRoutingPurpose(purpose);
  const candidates = resolveRoutingCandidates(config, routingPurpose);
  const selected = candidates[0];
  if (selected) {
    return selected;
  }

  throw new Error(
    `No eligible model configured for purpose '${purpose}'. ` +
    'Add a primary model for this purpose in config.modelRegistry.',
  );
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

  const currentInput: Array<'text' | 'image'> = Array.isArray(model.input)
    ? model.input
    : [];
  const nextInput: Array<'text' | 'image'> = [...currentInput];
  if (!nextInput.includes('text')) nextInput.unshift('text');
  if (!nextInput.includes('image')) nextInput.push('image');

  return {
    ...model,
    input: nextInput,
  };
}

function toRoutingPurpose(purpose: ModelPurpose): RoutingPurpose {
  if (purpose === 'context') {
    return 'context';
  }
  return purpose;
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
