import type {
  Context as PiContext,
  Model,
  SimpleStreamOptions,
  ThinkingLevel,
} from '@earendil-works/pi-ai';
import type {
  LLMCallAccountingContext,
  LLMContext,
  LLMPromptCacheObservability,
  LLMProviderObservability,
  LLMProviderWireMessage,
} from '../../shared/contracts/runtime.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { ResolvedCorrelationMetadata } from './correlation.js';
import type { RoutingCandidate } from './routing.js';
import {
  createModel,
  createOpenAICompatibleEndpointModel,
  resolveRegisteredModel,
  resolveSystemRoleCapabilityMetadata,
  type OpenAICompatibleApi,
} from './models.js';
import type { ProviderRuntime } from './provider-runtime.js';
import {
  contextMessagesToPiMessages,
  mergeSystemContextIntoSystemPrompt,
} from './message-conversion.js';
import { toPiTools } from './conversion.js';
import {
  buildPromptCacheObservability,
} from './client-prompt-cache.js';
import { captureProviderWirePayload } from './wire-payload-capture.js';
import {
  type CredentialReference,
  resolveOptionalEnvCredential,
  resolveProviderApiKey,
} from '../../boundary/custody/credential-vault.js';
import { resolveConfiguredLiteLLMApiKey } from '../../system/config/providers-config.js';
import { normalizeProxyModelId } from './client-response-helpers.js';
import { createComponentLogger } from '../../shared/logger.js';

const log = createComponentLogger('LLMClient');

const FULL_KNOB_PASSTHROUGH_PROVIDERS = new Set([
  'openrouter',
  'litellm',
  'local_endpoint',
]);

export interface LLMRequestOptions extends SimpleStreamOptions {
  zdr?: boolean;
  provider?: { order: string[] };
  contextWindow?: number;
  topP?: number;
  topK?: number;
  frequencyPenalty?: number;
  repetitionPenalty?: number;
}

/** Owns provider model resolution, request construction, and as-sent capture. */
export class LLMRequestCapability {
  constructor(
    private readonly config: SubstrateConfig,
    private readonly litellmBaseUrl: string | null,
    private readonly litellmApiKeyRef: CredentialReference,
    private readonly runtime: ProviderRuntime,
  ) {}

  getModelAndKey(candidate: RoutingCandidate): {
    model: Model<any>;
    apiKey: string | undefined;
  } {
    const modelId = this.shouldNormalizeProxyModelId(candidate)
      ? normalizeProxyModelId(candidate.provider, candidate.model)
      : candidate.model;
    const routedModelOptions = {
      reasoning: candidate.supportsReasoning ?? candidate.thinkingEnabled ?? false,
      supportsVision: candidate.supportsVision ?? false,
    };

    if (candidate.requestBaseUrl) {
      const apiKey = candidate.requestApiKeyEnv
        ? resolveOptionalEnvCredential(this.config.credentialVault, candidate.requestApiKeyEnv)
        : undefined;
      return {
        model: createOpenAICompatibleEndpointModel({
          baseUrl: candidate.requestBaseUrl,
          modelId,
          provider: candidate.provider,
          routeLabel: candidate.provider.replace(/_/g, ' '),
          maxTokens: candidate.maxTokens,
          contextWindow: candidate.contextWindow,
          reasoning: routedModelOptions.reasoning,
          supportsVision: routedModelOptions.supportsVision,
          api: this.resolveOpenAICompatibleApi(candidate),
        }),
        apiKey,
      };
    }

    if (this.litellmBaseUrl) {
      return {
        model: createModel(
          this.litellmBaseUrl,
          modelId,
          candidate.maxTokens,
          candidate.contextWindow,
          this.resolveOpenAICompatibleApi(candidate),
          routedModelOptions,
        ),
        apiKey: resolveConfiguredLiteLLMApiKey({
          credentialVault: this.config.credentialVault,
          litellmApiKeyRef: this.litellmApiKeyRef,
        }),
      };
    }

    const model = resolveRegisteredModel(this.runtime, candidate.provider, modelId);
    if (!model) {
      throw new Error(
        `Unknown model "${modelId}" for provider "${candidate.provider}". `
        + 'Configure LiteLLM in providers.json or update the canonical model config in models.json.',
      );
    }
    return {
      model,
      apiKey: resolveProviderApiKey(candidate.provider, this.config, process.env),
    };
  }

  buildRequestOptions(
    candidate: RoutingCandidate,
    apiKey: string | undefined,
    extra: { signal?: AbortSignal; correlation?: ResolvedCorrelationMetadata } = {},
  ): LLMRequestOptions {
    const requestOptions: LLMRequestOptions = {
      apiKey,
      maxTokens: candidate.maxTokens,
      ...(extra.signal ? { signal: extra.signal } : {}),
    };

    if (candidate.contextWindow !== undefined) {
      requestOptions.contextWindow = candidate.contextWindow;
    }
    if (candidate.temperature !== undefined) {
      requestOptions.temperature = candidate.temperature;
    }
    const reasoning = this.resolveReasoningLevel(candidate);
    if (reasoning) {
      requestOptions.reasoning = reasoning;
    }
    if (this.supportsFullKnobPassthrough(candidate)) {
      if (candidate.topP !== undefined) requestOptions.topP = candidate.topP;
      if (candidate.topK !== undefined) requestOptions.topK = candidate.topK;
      if (candidate.frequencyPenalty !== undefined) {
        requestOptions.frequencyPenalty = candidate.frequencyPenalty;
      }
      if (candidate.repetitionPenalty !== undefined) {
        requestOptions.repetitionPenalty = candidate.repetitionPenalty;
      }
    }

    const promptCaching = buildPromptCacheObservability({
      promptCacheStrategy: candidate.promptCacheStrategy,
      promptCacheRetention: candidate.promptCacheRetention,
      promptCacheScope: candidate.promptCacheScope,
      correlation: extra.correlation,
    });
    if (promptCaching.engaged && promptCaching.retention && promptCaching.sessionId) {
      requestOptions.cacheRetention = promptCaching.retention;
      requestOptions.sessionId = promptCaching.sessionId;
    }

    if (candidate.provider === 'openrouter') {
      if (candidate.openRouterZdrOnly) {
        requestOptions.zdr = true;
      }
      if (candidate.openRouterProviderOrder && candidate.openRouterProviderOrder.length > 0) {
        requestOptions.provider = { order: [...candidate.openRouterProviderOrder] };
      }
    }
    return requestOptions;
  }

  buildTransportContext(
    context: LLMContext,
    candidate: RoutingCandidate,
    correlation: ResolvedCorrelationMetadata | undefined,
    accounting?: LLMCallAccountingContext,
  ): LLMContext {
    const hintModel = this.shouldNormalizeProxyModelId(candidate)
      ? normalizeProxyModelId(candidate.provider, candidate.model)
      : candidate.model;
    return {
      systemPrompt: context.systemPrompt,
      messages: context.messages,
      ...(context.tools?.length ? { tools: context.tools } : {}),
      ...(context.promptCacheBoundaries
        ? { promptCacheBoundaries: context.promptCacheBoundaries }
        : {}),
      modelHint: {
        model: hintModel,
        provider: candidate.provider,
        pin: true,
        maxTokens: candidate.maxTokens,
        ...(candidate.contextWindow !== undefined
          ? { contextWindow: candidate.contextWindow }
          : {}),
        ...(candidate.thinkingEnabled !== undefined
          ? { thinkingEnabled: candidate.thinkingEnabled }
          : {}),
        ...(candidate.thinkingEffort ? { thinkingEffort: candidate.thinkingEffort } : {}),
        ...(candidate.temperature !== undefined
          ? { temperature: candidate.temperature }
          : {}),
        ...(candidate.topP !== undefined ? { topP: candidate.topP } : {}),
        ...(candidate.topK !== undefined ? { topK: candidate.topK } : {}),
        ...(candidate.frequencyPenalty !== undefined
          ? { frequencyPenalty: candidate.frequencyPenalty }
          : {}),
        ...(candidate.repetitionPenalty !== undefined
          ? { repetitionPenalty: candidate.repetitionPenalty }
          : {}),
      },
      ...(correlation ? { correlation } : {}),
      ...(accounting ? { accounting } : {}),
    };
  }

  shouldNormalizeProxyModelId(candidate: RoutingCandidate): boolean {
    return !candidate.requestBaseUrl && this.litellmBaseUrl !== null;
  }

  buildPiContext(context: LLMContext): PiContext {
    return {
      systemPrompt: mergeSystemContextIntoSystemPrompt(context.systemPrompt, context.messages),
      messages: contextMessagesToPiMessages(context.messages),
      ...(context.tools?.length ? { tools: toPiTools(context.tools) } : {}),
    };
  }

  resolveRouteKind(candidate: RoutingCandidate): LLMProviderObservability['routeKind'] {
    if (candidate.requestBaseUrl) return 'request_base_url';
    if (this.litellmBaseUrl) return 'configured_litellm_proxy';
    return 'registered_model';
  }

  /**
   * Capture the true provider wire body as-sent. The hook is pass-through and
   * capture failures heal without changing or blocking the provider payload.
   */
  attachWirePayloadCapture(
    requestOptions: LLMRequestOptions,
    providerObservability: LLMProviderObservability,
    model: Model<any>,
  ): void {
    const priorOnPayload = requestOptions.onPayload;
    requestOptions.onPayload = async (payload, payloadModel) => {
      const prior = await priorOnPayload?.(payload, payloadModel);
      const sent = prior ?? payload;
      try {
        providerObservability.capturedWirePayload = captureProviderWirePayload(sent, model);
      } catch (error) {
        log.warn('Failed to capture provider wire payload', {
          error: error instanceof Error ? error.message : String(error),
          model: String(model.id),
        });
      }
      return prior;
    };
  }

  buildProviderObservability(
    candidate: RoutingCandidate,
    model: Model<any>,
    context: PiContext,
    correlation: ResolvedCorrelationMetadata | undefined,
    promptCachingOverride?: LLMPromptCacheObservability,
  ): LLMProviderObservability {
    const systemRole = resolveSystemRoleCapabilityMetadata(model);
    return {
      routeKind: this.resolveRouteKind(candidate),
      requestedProvider: candidate.provider,
      requestedModel: candidate.model,
      backendProvider: model.provider,
      backendModel: model.id,
      backendApi: model.api,
      ...(model.baseUrl ? { backendBaseUrl: model.baseUrl } : {}),
      systemRole,
      promptCaching: promptCachingOverride ?? buildPromptCacheObservability({
        promptCacheStrategy: candidate.promptCacheStrategy,
        promptCacheRetention: candidate.promptCacheRetention,
        promptCacheScope: candidate.promptCacheScope,
        correlation,
      }),
      providerWireMessages: this.toProviderWireMessages(context, systemRole),
    };
  }

  private resolveReasoningLevel(candidate: RoutingCandidate): ThinkingLevel | undefined {
    if (candidate.thinkingEnabled === false) return undefined;
    if (candidate.thinkingEffort) return candidate.thinkingEffort;
    if (candidate.thinkingEnabled === true) return 'medium';
    return undefined;
  }

  private supportsFullKnobPassthrough(candidate: RoutingCandidate): boolean {
    return FULL_KNOB_PASSTHROUGH_PROVIDERS.has(candidate.provider)
      || !!candidate.requestBaseUrl
      || this.litellmBaseUrl !== null;
  }

  private resolveOpenAICompatibleApi(candidate: RoutingCandidate): OpenAICompatibleApi {
    return candidate.promptCacheStrategy === 'openai_responses'
      ? 'openai-responses'
      : 'openai-completions';
  }

  private toProviderWireMessages(
    context: PiContext,
    systemTransport: ReturnType<typeof resolveSystemRoleCapabilityMetadata>,
  ): LLMProviderWireMessage[] {
    const messages: LLMProviderWireMessage[] = [];
    if (context.systemPrompt) {
      messages.push({
        role: systemTransport.transport === 'openai_developer'
          ? 'developer'
          : systemTransport.transport === 'google_system_instruction'
            ? 'system_instruction'
            : 'system',
        source: 'system_prompt',
        content: context.systemPrompt,
      });
    }
    for (const message of context.messages) {
      messages.push({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        source: 'message',
        content: typeof message.content === 'string'
          ? message.content
          : JSON.stringify(message.content),
      });
    }
    return messages;
  }
}
