// ── Provider Runtime Boundary ──
// Repository-owned seam over the upstream pi-ai provider dispatch API.
// The implementation owns one gateway-scoped Models collection; all pi-ai
// construction and provider registration lives here so call sites depend on
// this boundary instead of upstream globals.

import {
  createModels,
  createProvider,
  envApiKeyAuth,
  type Models,
  type MutableModels,
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import type {
  Api,
  AuthResult,
  AssistantMessage,
  AssistantMessageEvent,
  Context as PiContext,
  Model,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { createOpenAICompatibleEndpointModel } from './models.js';

export type ProviderRuntimeCompleteResult = AssistantMessage;

export interface ProviderRuntime {
  /**
   * Dispatch a non-streaming completion for the selected model.
   */
  complete(
    model: Model<any>,
    context: PiContext,
    options?: SimpleStreamOptions,
  ): Promise<ProviderRuntimeCompleteResult>;

  /**
   * Dispatch a streaming completion for the selected model.
   */
  stream(
    model: Model<any>,
    context: PiContext,
    options?: SimpleStreamOptions,
  ): AsyncIterable<AssistantMessageEvent>;

  /**
   * Enumerate provider identifiers registered in the runtime.
   */
  getProviders(): readonly string[];

  /**
   * Enumerate models registered for a provider by id.
   */
  getModels(provider: string): readonly Model<Api>[];

  /** Resolve provider-scoped auth through the runtime-owned Models collection. */
  getAuth(provider: string | Model<Api>): Promise<AuthResult | undefined>;
}

function asMutableModels(models: Models): MutableModels {
  if (!('setProvider' in models)) {
    throw new Error('Provider runtime requires a MutableModels collection');
  }
  return models as MutableModels;
}

function registerOpenAICompatibleEndpointProvider(
  models: MutableModels,
  providerId: string,
  displayName: string,
  envApiKeyNames: readonly string[],
): void {
  models.setProvider(
    createProvider({
      id: providerId,
      name: displayName,
      auth: {
        apiKey: envApiKeyAuth(`${displayName} API key`, envApiKeyNames),
      },
      models: [],
      api: openAICompletionsApi(),
    }),
  );
}

/**
 * Register the OpenAI-compatible endpoint providers that PSFN historically
 * routed by model `provider` id. These have no static catalog; models are
 * supplied per-request through {@link createModel} / {@link createOpenAICompatibleEndpointModel}.
 * This preserves explicit configured endpoint behavior while the migration to
 * typed generic providers proceeds in later beads.
 */
function registerLegacyEndpointProviders(models: MutableModels): void {
  registerOpenAICompatibleEndpointProvider(models, 'litellm', 'LiteLLM', ['LITELLM_API_KEY']);
  registerOpenAICompatibleEndpointProvider(models, 'local_endpoint', 'Local endpoint', []);
}

type ProviderRuntimeConfig = Pick<SubstrateConfig, 'providerRegistry' | 'modelRegistry'>;

function registerConfiguredProviders(models: MutableModels, config: ProviderRuntimeConfig): void {
  for (const provider of config.providerRegistry?.providers ?? []) {
    if (!provider.enabled || provider.type !== 'generic_openai') continue;
    if (!provider.apiBaseUrl) {
      throw new Error(`Configured provider "${provider.id}" is missing apiBaseUrl`);
    }
    const apiBaseUrl = provider.apiBaseUrl;
    const configuredModels = (config.modelRegistry?.models ?? [])
      .filter((entry) => entry.enabled !== false && entry.identity.provider === provider.id)
      .map((entry) => {
        if (!entry.apiKind) {
          throw new Error(`Configured model "${entry.id}" is missing apiKind`);
        }
        return createOpenAICompatibleEndpointModel({
          baseUrl: apiBaseUrl,
          modelId: entry.identity.model,
          provider: provider.id,
          routeLabel: provider.label ?? provider.id,
          contextWindow: entry.tuning?.contextWindow ?? entry.capabilities?.contextWindow,
          maxTokens: entry.tuning?.maxOutputTokens ?? entry.capabilities?.maxOutputTokens,
          reasoning: entry.capabilities?.supportsReasoning === true
            && entry.tuning?.thinkingEnabled !== false,
          supportsVision: entry.capabilities?.supportsVision === true,
          api: entry.apiKind,
          cost: entry.cost,
        });
      });
    models.setProvider(createProvider({
      id: provider.id,
      name: provider.label ?? provider.id,
      baseUrl: apiBaseUrl,
      auth: {
        apiKey: envApiKeyAuth(
          `${provider.label ?? provider.id} API key`,
          provider.apiKeyRef ? [provider.apiKeyRef.envName] : [],
        ),
      },
      models: configuredModels,
      api: {
        'openai-completions': openAICompletionsApi(),
        'openai-responses': openAIResponsesApi(),
      },
    }));
  }
}

/**
 * Gateway-owned pi-ai runtime. Holds one Models collection and delegates
 * stream/completion/lookup calls to it. The default constructor registers
 * all built-in providers; callers may also inject a pre-built Models instance.
 */
export class PiProviderRuntime implements ProviderRuntime {
  private readonly models: MutableModels;

  constructor(models?: Models, config?: ProviderRuntimeConfig) {
    this.models = models ? asMutableModels(models) : builtinModels();
    registerLegacyEndpointProviders(this.models);
    if (config) registerConfiguredProviders(this.models, config);
  }

  complete(
    model: Model<any>,
    context: PiContext,
    options?: SimpleStreamOptions,
  ): Promise<ProviderRuntimeCompleteResult> {
    return this.models.completeSimple(model, context, options);
  }

  stream(
    model: Model<any>,
    context: PiContext,
    options?: SimpleStreamOptions,
  ): AsyncIterable<AssistantMessageEvent> {
    return this.models.streamSimple(model, context, options);
  }

  getProviders(): readonly string[] {
    return this.models.getProviders().map((provider) => provider.id);
  }

  getModels(provider: string): readonly Model<Api>[] {
    return this.models.getModels(provider);
  }

  getAuth(provider: string | Model<Api>): Promise<AuthResult | undefined> {
    return typeof provider === 'string'
      ? this.models.getAuth(provider)
      : this.models.getAuth(provider);
  }
}

/**
 * Factory for tests and composition that need an empty, mutable Models
 * collection without built-in providers registered.
 */
export function createEmptyProviderRuntime(): PiProviderRuntime {
  return new PiProviderRuntime(createModels());
}
