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
import {
  type CredentialReference,
  type CredentialVaultPort,
  resolveOptionalCredentialReference,
} from '../../boundary/custody/credential-vault.js';
import { createOpenAICompatibleEndpointModel } from './models.js';
import { resolveCompletionTokenBudget } from './completion-budget.js';

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

  /**
   * Resolve a configured provider credential solely through the gateway-owned
   * credential vault. Returns the resolved secret, or `undefined` when the
   * provider has no configured `apiKeyRef` / `openRouterApiKeyRef` (callers
   * fail closed). Never falls back to process.env or a LiteLLM default.
   */
  resolveProviderApiKey(provider: string): string | undefined;
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
 * Register the OpenAI-compatible endpoint providers that the runtime routes by model
 * `provider` id when no static catalog applies. Models are supplied per-request
 * through {@link createOpenAICompatibleEndpointModel}.
 */
function registerLegacyEndpointProviders(models: MutableModels): void {
  registerOpenAICompatibleEndpointProvider(models, 'local_endpoint', 'Local endpoint', []);
}

type ProviderRuntimeConfig = Pick<
  SubstrateConfig,
  'providerRegistry' | 'modelRegistry' | 'credentialVault' | 'openRouterApiKeyRef'
>;

function resolveConfiguredProviderCredentialReference(
  provider: string,
  config: ProviderRuntimeConfig,
): CredentialReference | undefined {
  const normalized = provider.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === 'openrouter') {
    return config.openRouterApiKeyRef;
  }
  const providers = config.providerRegistry?.providers ?? [];
  const matchById = providers.find((entry) => entry.enabled && entry.id === normalized);
  const matchByType = providers.find((entry) => entry.enabled && entry.type === normalized);
  return (matchById ?? matchByType)?.apiKeyRef;
}

/**
 * Resolve a configured provider credential through the vault only. No process.env
 * fallback and no LiteLLM default: a provider without a resolvable configured
 * reference yields `undefined` so callers can fail closed.
 */
export function resolveConfiguredProviderCredential(
  provider: string,
  config: ProviderRuntimeConfig,
): string | undefined {
  const reference = resolveConfiguredProviderCredentialReference(provider, config);
  if (!reference) return undefined;
  const vault: CredentialVaultPort | undefined = config.credentialVault;
  return resolveOptionalCredentialReference(vault, reference);
}

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
          maxTokens: resolveCompletionTokenBudget({
            configuredMaxOutputTokens: entry.tuning?.maxOutputTokens,
            capabilityMaxOutputTokens: entry.capabilities?.maxOutputTokens,
          }),
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
  private readonly config: ProviderRuntimeConfig;

  constructor(models?: Models, config: ProviderRuntimeConfig = {}) {
    this.models = models ? asMutableModels(models) : builtinModels();
    this.config = config;
    registerLegacyEndpointProviders(this.models);
    registerConfiguredProviders(this.models, config);
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

  resolveProviderApiKey(provider: string): string | undefined {
    return resolveConfiguredProviderCredential(provider, this.config);
  }
}

/**
 * Factory for tests and composition that need an empty, mutable Models
 * collection without built-in providers registered.
 */
export function createEmptyProviderRuntime(): PiProviderRuntime {
  return new PiProviderRuntime(createModels());
}
