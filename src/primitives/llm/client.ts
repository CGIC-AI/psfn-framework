import { isRecord } from '../../shared/utils/types.js';
import {
  streamSimple,
  completeSimple,
  type Context as PiContext,
  type Model,
  type SimpleStreamOptions,
  type ThinkingLevel,
} from '@mariozechner/pi-ai';
import type {
  CompletionPurpose,
  CorrelationMetadata,
  LLMContext,
  LLMSystemPromptCacheBoundaries,
  LLMUsageCostDetails,
  LLMUsageDetails,
  LLMPromptCacheObservability,
  LLMProviderObservability,
  LLMModelHint,
  LLMResponse,
  LLMProviderWireMessage,
  ModelBudgetBlockedEvent,
  PromptCacheRetention,
  StreamCallbacks,
  ToolCall,
} from '../../shared/contracts/runtime.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { createModel, createOpenAICompatibleEndpointModel, type OpenAICompatibleApi } from './models.js';
import { withRetry, markErrorAsNonRetryable, isRetryableError } from './retry.js';
import { llmRetryConfig } from './retry-config.js';
import {
  extractReasoningContent,
  extractTextContent,
  toPiTools,
} from './conversion.js';
import {
  contextMessagesToPiMessages,
  mergeSystemContextIntoSystemPrompt,
} from './message-conversion.js';
import { createComponentLogger } from '../../shared/logger.js';
import { FallbackRunner } from './fallback.js';
import type { ImportPolicyAuditRecord, RoutingCandidate, RoutingPurpose } from './routing.js';
import {
  applyGlobalPromptCachePolicy,
  evaluateImportPolicy,
  resolveGlobalPromptCachePolicy,
  resolveRoutingCandidates,
} from './routing.js';
import {
  createSystemPromptCacheControlPayloadTransformer,
  resolvePromptCacheMechanism,
  verifySystemPromptCacheBoundaries,
  type PromptCachePayloadReport,
} from './prompt-cache.js';
import { resolveRegisteredModel, resolveSystemRoleCapabilityMetadata } from './models.js';
import {
  EligibilityDeniedError,
  type EligibilityDecision,
  type EligibilityGate,
} from '../../system/capabilities/eligibility.js';
import {
  type ResolvedCorrelationMetadata,
  inferCallType as inferCorrelationCallType,
  resolveCorrelationMetadata,
} from './correlation.js';
import {
  findRegistryEntryByModelId,
  ModelBudgetController,
  ModelBudgetExceededError,
  normalizeModelIdForProvider,
} from './model-budget.js';
import { countMessageTokens } from './tokens.js';
import {
  type CredentialReference,
  resolveProviderApiKey,
  resolveOptionalEnvCredential,
} from '../../boundary/custody/credential-vault.js';
import {
  resolveConfiguredLiteLLMApiKey,
  resolveConfiguredLiteLLMApiKeyReference,
  resolveConfiguredLiteLLMBaseUrl,
} from '../../system/config/providers-config.js';
import type { LLMProviderPort } from '../../core/agent/contracts.js';
import { resolveRuntimeLaneClassForModelCall } from '../../core/agent/worker-lanes.js';
import { ModelCallGate } from './model-call-gate.js';
import { clampVisionCompletionMaxTokens } from './vision-limits.js';
import type { ModelUsageRecorder } from '../../shared/telemetry/model-usage.js';
import { getRunChargeSnapshot } from '../../shared/telemetry/run-charge.js';
import {
  type CircuitBreakerTransition,
  SlidingWindowCircuitBreaker,
} from '../../shared/resilience/circuit-breaker.js';

const log = createComponentLogger('LLMClient');
const LLM_CIRCUIT_BREAKER_WINDOW_MS = 60_000;
const LLM_CIRCUIT_BREAKER_COOLDOWN_MS = 30_000;
const LLM_CIRCUIT_BREAKER_FAILURE_THRESHOLD = 3;
const PROVIDER_RESPONSE_PREFIX_ARTIFACTS = [
  '<｜begin▁of▁sentence｜>',
  '<｜begin_of_sentence｜>',
  '<|begin▁of▁sentence|>',
  '<|begin_of_sentence|>',
] as const;
const PROVIDER_RESPONSE_HEADER_ARTIFACT_PATTERN = /^#{1,6}\s+(?:(?:assistant|model|bot|character|companion|[^#\r\n]{1,80}'s)\s+)?response\s*:?(?:\r?\n|$)/iu;
const PROVIDER_RESPONSE_HEADER_POTENTIAL_MAX_CHARS = 120;

interface LLMRequestOptions extends SimpleStreamOptions {
  zdr?: boolean;
  provider?: { order: string[] };
  contextWindow?: number;
  topP?: number;
  topK?: number;
  frequencyPenalty?: number;
  repetitionPenalty?: number;
}

export type LLMCompletionModelHint = LLMModelHint;

export interface LLMCompletionOptions {
  signal?: AbortSignal;
  disableRetry?: boolean;
  modelHint?: LLMCompletionModelHint;
  correlation?: Partial<CorrelationMetadata>;
}

export interface LLMClientRuntimeOptions {
  litellmBaseUrl?: string;
  transport?: LLMProviderPort;
  eligibilityGate?: EligibilityGate;
  onEligibilityDecision?: (decision: EligibilityDecision) => void;
  onBudgetBlocked?: (event: ModelBudgetBlockedEvent) => void;
  usageRecorder?: ModelUsageRecorder;
  circuitBreaker?: SlidingWindowCircuitBreaker;
}

const FULL_KNOB_PASSTHROUGH_PROVIDERS = new Set(['openrouter', 'litellm', 'local_endpoint']);

export class SensitiveImportRoutePolicyError extends Error {
  readonly code = 'sensitive_import_route_rejected';
  readonly audit: ImportPolicyAuditRecord;
  readonly reason: string;

  constructor(audit: ImportPolicyAuditRecord, reason: string) {
    super(`Sensitive import route rejected by strict policy: ${reason}`);
    this.name = 'SensitiveImportRoutePolicyError';
    this.audit = audit;
    this.reason = reason;
  }
}

export class LegacyModelHintError extends Error {
  readonly code = 'legacy_model_hint_unsupported';
  readonly modelHint: string;

  constructor(modelHint: string) {
    super(
      `Legacy slot-key model hints are unsupported: "${modelHint}". ` +
      'Use provider-qualified model id (provider:model) or provide model + provider explicitly.',
    );
    this.name = 'LegacyModelHintError';
    this.modelHint = modelHint;
  }
}

export class LLMClient {
  private config: SubstrateConfig;
  private litellmBaseUrl: string | null;
  private litellmApiKeyRef: CredentialReference;
  private fallbackRunner: FallbackRunner;
  private budgetController: ModelBudgetController;
  private transport?: LLMProviderPort;
  private eligibilityGate?: EligibilityGate;
  private onEligibilityDecision?: (decision: EligibilityDecision) => void;
  private onBudgetBlocked?: (event: ModelBudgetBlockedEvent) => void;
  private modelCallGate: ModelCallGate;
  private usageRecorder?: ModelUsageRecorder;
  private circuitBreaker: SlidingWindowCircuitBreaker;
  private usageCallCounter = 0;

  constructor(
    config: SubstrateConfig,
    litellmBaseUrlOrOptions?: string | LLMClientRuntimeOptions,
  ) {
    const runtimeOptions = typeof litellmBaseUrlOrOptions === 'string'
      ? { litellmBaseUrl: litellmBaseUrlOrOptions }
      : (litellmBaseUrlOrOptions ?? {});
    this.config = config;
    this.litellmBaseUrl = runtimeOptions.litellmBaseUrl ?? resolveConfiguredLiteLLMBaseUrl(config);
    this.litellmApiKeyRef = resolveConfiguredLiteLLMApiKeyReference(config);
    this.fallbackRunner = new FallbackRunner();
    this.budgetController = new ModelBudgetController(config);
    this.transport = runtimeOptions.transport;
    this.eligibilityGate = runtimeOptions.eligibilityGate;
    this.onEligibilityDecision = runtimeOptions.onEligibilityDecision;
    this.onBudgetBlocked = runtimeOptions.onBudgetBlocked;
    this.usageRecorder = runtimeOptions.usageRecorder;
    this.modelCallGate = new ModelCallGate();
    this.circuitBreaker = runtimeOptions.circuitBreaker ?? new SlidingWindowCircuitBreaker({
      failureThreshold: LLM_CIRCUIT_BREAKER_FAILURE_THRESHOLD,
      windowMs: LLM_CIRCUIT_BREAKER_WINDOW_MS,
      cooldownMs: LLM_CIRCUIT_BREAKER_COOLDOWN_MS,
    });
  }

  private getModelAndKey(candidate: RoutingCandidate): { model: Model<any>; apiKey: string | undefined } {
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
    const model = resolveRegisteredModel(candidate.provider, modelId);
    if (!model) {
      throw new Error(
        `Unknown model "${modelId}" for provider "${candidate.provider}". `
        + 'Configure LiteLLM in providers.json or update the canonical model config in models.json.',
      );
    }
    return {
      model,
      apiKey: resolveProviderApiKey(candidate.provider, this.config),
    };
  }

  private buildRequestOptions(
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
      if (candidate.frequencyPenalty !== undefined) requestOptions.frequencyPenalty = candidate.frequencyPenalty;
      if (candidate.repetitionPenalty !== undefined) requestOptions.repetitionPenalty = candidate.repetitionPenalty;
    }

    const promptCaching = this.buildPromptCacheObservability(candidate, extra.correlation);
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

  private buildTransportContext(
    context: LLMContext,
    candidate: RoutingCandidate,
    correlation: ResolvedCorrelationMetadata | undefined,
  ): LLMContext {
    const hintModel = this.shouldNormalizeProxyModelId(candidate)
      ? normalizeProxyModelId(candidate.provider, candidate.model)
      : candidate.model;
    return {
      systemPrompt: context.systemPrompt,
      messages: context.messages,
      ...(context.tools?.length ? { tools: context.tools } : {}),
      ...(context.promptCacheBoundaries ? { promptCacheBoundaries: context.promptCacheBoundaries } : {}),
      modelHint: {
        model: hintModel,
        provider: candidate.provider,
        pin: true,
        maxTokens: candidate.maxTokens,
        ...(candidate.contextWindow !== undefined ? { contextWindow: candidate.contextWindow } : {}),
        ...(candidate.thinkingEnabled !== undefined ? { thinkingEnabled: candidate.thinkingEnabled } : {}),
        ...(candidate.thinkingEffort ? { thinkingEffort: candidate.thinkingEffort } : {}),
        ...(candidate.temperature !== undefined ? { temperature: candidate.temperature } : {}),
        ...(candidate.topP !== undefined ? { topP: candidate.topP } : {}),
        ...(candidate.topK !== undefined ? { topK: candidate.topK } : {}),
        ...(candidate.frequencyPenalty !== undefined ? { frequencyPenalty: candidate.frequencyPenalty } : {}),
        ...(candidate.repetitionPenalty !== undefined ? { repetitionPenalty: candidate.repetitionPenalty } : {}),
      },
      ...(correlation ? { correlation } : {}),
    };
  }

  private shouldNormalizeProxyModelId(candidate: RoutingCandidate): boolean {
    return !candidate.requestBaseUrl && this.litellmBaseUrl !== null;
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

  private resolvePromptCacheSessionId(
    candidate: RoutingCandidate,
    correlation: ResolvedCorrelationMetadata | undefined,
  ): string | undefined {
    if (!candidate.promptCacheStrategy || candidate.promptCacheRetention === 'none') {
      return undefined;
    }
    if (candidate.promptCacheScope === 'request') {
      return correlation?.requestId;
    }
    return correlation?.channelId;
  }

  private buildPromptCacheObservability(
    candidate: RoutingCandidate,
    correlation: ResolvedCorrelationMetadata | undefined,
  ): LLMPromptCacheObservability {
    if (!candidate.promptCacheStrategy) {
      return {
        configured: false,
        engaged: false,
      };
    }

    const retention = candidate.promptCacheRetention ?? 'short';
    const scope = candidate.promptCacheScope ?? 'channel';
    if (retention === 'none') {
      return {
        configured: true,
        engaged: false,
        strategy: candidate.promptCacheStrategy,
        retention,
        scope,
        reason: 'disabled',
      };
    }

    const sessionId = this.resolvePromptCacheSessionId(candidate, correlation);
    if (!sessionId) {
      return {
        configured: true,
        engaged: false,
        strategy: candidate.promptCacheStrategy,
        retention,
        scope,
        reason: 'missing_channel_id',
      };
    }

    return {
      configured: true,
      engaged: true,
      strategy: candidate.promptCacheStrategy,
      retention,
      scope,
      sessionId,
    };
  }

  /**
   * Model-agnostic provider cache engagement (E2.4): applied when the
   * models.json registry-wide promptCaching policy is enabled. Mutates the
   * request options with the params the resolved provider actually supports
   * (cacheRetention / sessionId / cache_control onPayload transformer) and
   * returns the promptCaching observability reflecting what was applied.
   * Returns null when the flag is off — zero wire change.
   */
  private applyModelAgnosticPromptCache(input: {
    candidate: RoutingCandidate;
    model: Model<any>;
    systemPrompt: string;
    boundaries: LLMSystemPromptCacheBoundaries | undefined;
    correlation: ResolvedCorrelationMetadata | undefined;
    requestOptions: LLMRequestOptions;
  }): LLMPromptCacheObservability | null {
    const { candidate, model, requestOptions } = input;
    if (candidate.promptCacheEnabled !== true) return null;

    const retention: PromptCacheRetention = candidate.promptCacheRetention ?? 'short';
    const scope = candidate.promptCacheScope ?? 'channel';
    // candidate.model is the requested (registry-identity) model id — e.g.
    // 'anthropic/claude-sonnet-4.5' on OpenRouter — which is the stable
    // discriminator even when a proxy route rewrites the backend model id.
    const mechanism = resolvePromptCacheMechanism({
      provider: candidate.provider,
      modelId: candidate.model,
      api: typeof (model as { api?: unknown }).api === 'string' ? (model as { api: string }).api : undefined,
    });
    if (retention === 'none') {
      return {
        configured: true,
        engaged: false,
        retention,
        scope,
        mechanism,
        reason: 'disabled',
        ...(candidate.promptCacheStrategy ? { strategy: candidate.promptCacheStrategy } : {}),
      };
    }

    const sessionId = scope === 'request'
      ? input.correlation?.requestId
      : input.correlation?.channelId;
    if (requestOptions.cacheRetention === undefined) {
      requestOptions.cacheRetention = retention;
    }
    if (requestOptions.sessionId === undefined && sessionId) {
      requestOptions.sessionId = sessionId;
    }

    const observability: LLMPromptCacheObservability = {
      configured: true,
      engaged: true,
      retention,
      scope,
      mechanism,
      ...(candidate.promptCacheStrategy ? { strategy: candidate.promptCacheStrategy } : {}),
      ...(sessionId ? { sessionId } : {}),
    };

    const boundaries = input.boundaries;
    if (
      boundaries
      && (mechanism === 'anthropic_cache_control' || mechanism === 'openrouter_cache_control_passthrough')
    ) {
      if (!verifySystemPromptCacheBoundaries(input.systemPrompt, boundaries)) {
        log.warn('Prompt cache boundaries did not match the serialized system prompt; skipping cache breakpoints', {
          provider: candidate.provider,
          model: String(model.id),
          mechanism,
          staticPrefixChars: boundaries.staticPrefixChars,
          sessionStablePrefixChars: boundaries.sessionStablePrefixChars,
          systemPromptChars: input.systemPrompt.length,
        });
        return observability;
      }
      observability.boundaries = {
        staticPrefixChars: boundaries.staticPrefixChars,
        sessionStablePrefixChars: boundaries.sessionStablePrefixChars,
      };
      const report: PromptCachePayloadReport = { appliedBreakpoints: 0 };
      const transformer = createSystemPromptCacheControlPayloadTransformer({
        mechanism,
        boundaries,
        retention,
        report,
      });
      const existingOnPayload = requestOptions.onPayload;
      requestOptions.onPayload = async (payload, payloadModel) => {
        const transformed = transformer(payload, payloadModel);
        if (report.appliedBreakpoints > 0) {
          observability.appliedBreakpoints = report.appliedBreakpoints;
        }
        const next = transformed ?? payload;
        const chained = await existingOnPayload?.(next, payloadModel);
        return chained ?? (transformed !== undefined ? next : undefined);
      };
    }

    return observability;
  }

  private enforceImportRoutingPolicy(purpose: RoutingPurpose, candidate: RoutingCandidate): void {
    const evaluation = evaluateImportPolicy(this.config, purpose, candidate);
    if (evaluation.allowed) return;

    const reason = evaluation.reason ?? 'policy_rejected';
    log.warn('Sensitive import route rejected by strict policy', {
      reason,
      ...evaluation.audit,
    });

    throw new SensitiveImportRoutePolicyError(evaluation.audit, reason);
  }

  private normalizeModelHint(modelHint: LLMCompletionModelHint | undefined): LLMCompletionModelHint | null {
    if (!modelHint) return null;
    const rawModel = modelHint.model?.trim();
    const provider = modelHint.provider?.trim().toLowerCase();
    const maxTokens = toPositiveInteger(modelHint.maxTokens);
    const contextWindow = toPositiveInteger(modelHint.contextWindow);
    const thinkingEnabled = typeof modelHint.thinkingEnabled === 'boolean'
      ? modelHint.thinkingEnabled
      : undefined;
    const thinkingEffort = toThinkingEffort(modelHint.thinkingEffort);
    const temperature = toFiniteNumber(modelHint.temperature);
    const topP = toUnitInterval(modelHint.topP);
    const topK = toPositiveInteger(modelHint.topK);
    const frequencyPenalty = toFiniteNumber(modelHint.frequencyPenalty);
    const repetitionPenalty = toFiniteNumber(modelHint.repetitionPenalty);
    const pin = modelHint.pin === true ? true : undefined;
    if (
      !rawModel
      && !provider
      && pin === undefined
      && maxTokens === undefined
      && contextWindow === undefined
      && thinkingEnabled === undefined
      && thinkingEffort === undefined
      && temperature === undefined
      && topP === undefined
      && topK === undefined
      && frequencyPenalty === undefined
      && repetitionPenalty === undefined
    ) {
      return null;
    }
    return {
      ...(rawModel ? { model: rawModel } : {}),
      ...(provider ? { provider } : {}),
      ...(pin ? { pin } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(thinkingEnabled !== undefined ? { thinkingEnabled } : {}),
      ...(thinkingEffort !== undefined ? { thinkingEffort } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(topP !== undefined ? { topP } : {}),
      ...(topK !== undefined ? { topK } : {}),
      ...(frequencyPenalty !== undefined ? { frequencyPenalty } : {}),
      ...(repetitionPenalty !== undefined ? { repetitionPenalty } : {}),
    };
  }

  private mergeModelHints(
    contextHint: LLMCompletionModelHint | undefined,
    optionHint: LLMCompletionModelHint | undefined,
  ): LLMCompletionModelHint | undefined {
    const normalizedContext = this.normalizeModelHint(contextHint);
    const normalizedOption = this.normalizeModelHint(optionHint);
    if (!normalizedContext && !normalizedOption) return undefined;
    return {
      ...(normalizedContext ?? {}),
      ...(normalizedOption ?? {}),
    };
  }

  private parseProviderQualifiedHint(value: string): { provider: string; model: string } | null {
    const separatorIndex = value.indexOf(':');
    if (separatorIndex <= 0) return null;
    const provider = value.slice(0, separatorIndex).trim().toLowerCase();
    const model = value.slice(separatorIndex + 1).trim();
    if (!provider || !model || provider.includes('/')) return null;
    return { provider, model };
  }

  private withOpenRouterPreferences(candidate: RoutingCandidate): RoutingCandidate {
    if (candidate.provider !== 'openrouter') return candidate;
    if (candidate.openRouterProviderOrder !== undefined) return candidate;
    const providerOrder = this.config.openRouterProviderOrder?.filter(Boolean) ?? [];
    if (providerOrder.length === 0) return candidate;
    return {
      ...candidate,
      openRouterProviderOrder: [...providerOrder],
    };
  }

  private candidateKey(candidate: RoutingCandidate): string {
    return [
      candidate.provider,
      candidate.model,
      String(candidate.maxTokens),
      String(candidate.contextWindow ?? ''),
      String(candidate.supportsVision ?? ''),
      String(candidate.supportsReasoning ?? ''),
      String(candidate.thinkingEnabled ?? ''),
      candidate.thinkingEffort ?? '',
      String(candidate.temperature ?? ''),
      String(candidate.topP ?? ''),
      String(candidate.topK ?? ''),
      String(candidate.frequencyPenalty ?? ''),
      String(candidate.repetitionPenalty ?? ''),
      candidate.promptCacheStrategy ?? '',
      candidate.promptCacheRetention ?? '',
      candidate.promptCacheScope ?? '',
      candidate.promptCacheEnabled ? 'cache_enabled' : '',
      candidate.requestBaseUrl ?? '',
      candidate.requestApiKeyEnv ?? '',
      candidate.openRouterZdrOnly ? 'zdr' : '',
      candidate.openRouterProviderOrder?.join(',') ?? '',
      candidate.importRouteMode ?? '',
    ].join('::');
  }

  private dedupeCandidates(candidates: RoutingCandidate[]): RoutingCandidate[] {
    const deduped: RoutingCandidate[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      const key = this.candidateKey(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(candidate);
    }
    return deduped;
  }

  private resolveModelHintCandidate(
    modelHint: LLMCompletionModelHint,
    fallbackCandidates: RoutingCandidate[],
  ): RoutingCandidate | null {
    const baseCandidate = fallbackCandidates.at(0);
    if (baseCandidate === undefined) return null;
    const hintedModel = modelHint.model?.trim();
    const qualified = hintedModel ? this.parseProviderQualifiedHint(hintedModel) : null;

    let provider = modelHint.provider ?? qualified?.provider ?? baseCandidate.provider;
    let model = qualified?.model ?? hintedModel ?? baseCandidate.model;
    const registryEntry = this.findRegistryModelEntry(provider, model);
    // The hinted model's own catalog output cap beats the base candidate's:
    // inheriting a roster default above the target model's maximum (e.g. 16384
    // onto claude-3-opus's 4096) is a guaranteed 400 from the provider.
    const registryMaxTokens = toPositiveInteger(registryEntry?.tuning?.maxOutputTokens)
      ?? toPositiveInteger(registryEntry?.capabilities?.maxOutputTokens);
    const registryContextWindow = toPositiveInteger(registryEntry?.tuning?.contextWindow)
      ?? toPositiveInteger(registryEntry?.capabilities?.contextWindow);
    let maxTokens = modelHint.maxTokens ?? registryMaxTokens ?? baseCandidate.maxTokens;
    const contextWindow = modelHint.contextWindow ?? registryContextWindow ?? baseCandidate.contextWindow;
    const thinkingEnabled = modelHint.thinkingEnabled ?? baseCandidate.thinkingEnabled;
    const thinkingEffort = modelHint.thinkingEffort ?? baseCandidate.thinkingEffort;
    const temperature = modelHint.temperature ?? baseCandidate.temperature;
    const topP = modelHint.topP ?? baseCandidate.topP;
    const topK = modelHint.topK ?? baseCandidate.topK;
    const frequencyPenalty = modelHint.frequencyPenalty ?? baseCandidate.frequencyPenalty;
    const repetitionPenalty = modelHint.repetitionPenalty ?? baseCandidate.repetitionPenalty;
    const supportsVision = typeof registryEntry?.capabilities?.supportsVision === 'boolean'
      ? registryEntry.capabilities.supportsVision
      : baseCandidate.supportsVision;
    const supportsReasoning = typeof registryEntry?.capabilities?.supportsReasoning === 'boolean'
      ? registryEntry.capabilities.supportsReasoning
      : baseCandidate.supportsReasoning;

    if (!provider || !model) return null;
    provider = provider.trim().toLowerCase();
    model = model.trim();
    if (!provider || !model) return null;

    if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
      maxTokens = this.config.primaryMaxTokens;
    }
    if (!Number.isFinite(maxTokens) || maxTokens <= 0) return null;

    const hinted: RoutingCandidate = {
      provider,
      model,
      maxTokens: Math.floor(maxTokens),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(supportsVision !== undefined ? { supportsVision } : {}),
      ...(supportsReasoning !== undefined ? { supportsReasoning } : {}),
      ...(thinkingEnabled !== undefined ? { thinkingEnabled } : {}),
      ...(thinkingEffort !== undefined ? { thinkingEffort } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(topP !== undefined ? { topP } : {}),
      ...(topK !== undefined ? { topK } : {}),
      ...(frequencyPenalty !== undefined ? { frequencyPenalty } : {}),
      ...(repetitionPenalty !== undefined ? { repetitionPenalty } : {}),
    };

    if (baseCandidate.provider === provider) {
      if (baseCandidate.requestBaseUrl) hinted.requestBaseUrl = baseCandidate.requestBaseUrl;
      if (baseCandidate.requestApiKeyEnv) hinted.requestApiKeyEnv = baseCandidate.requestApiKeyEnv;
      if (baseCandidate.promptCacheStrategy) hinted.promptCacheStrategy = baseCandidate.promptCacheStrategy;
      if (baseCandidate.promptCacheRetention) hinted.promptCacheRetention = baseCandidate.promptCacheRetention;
      if (baseCandidate.promptCacheScope) hinted.promptCacheScope = baseCandidate.promptCacheScope;
      if (baseCandidate.openRouterZdrOnly) hinted.openRouterZdrOnly = true;
      if (baseCandidate.importRouteMode) hinted.importRouteMode = baseCandidate.importRouteMode;
    }

    // The registry-wide promptCaching policy is model-agnostic: hinted
    // candidates engage it exactly like roster-resolved candidates.
    return applyGlobalPromptCachePolicy(
      this.withOpenRouterPreferences(hinted),
      resolveGlobalPromptCachePolicy(this.config),
    );
  }

  private findRegistryModelEntry(provider: string, model: string) {
    const registryModels = this.config.modelRegistry?.models ?? [];
    const normalizedProvider = provider.trim().toLowerCase();
    const normalizedModel = normalizeModelIdForProvider(normalizedProvider, model);

    const directMatch = registryModels.find((entry) => (
      entry.identity.provider.trim().toLowerCase() === normalizedProvider
      && normalizeModelIdForProvider(entry.identity.provider, entry.identity.model) === normalizedModel
    ));
    if (directMatch) {
      return directMatch;
    }

    return findRegistryEntryByModelId(this.config, normalizedModel);
  }

  private ensureNonLegacyModelHint(
    modelHint: LLMCompletionModelHint,
    fallbackCandidates: RoutingCandidate[],
  ): void {
    const hintedModel = modelHint.model?.trim();
    if (!hintedModel) return;
    if (modelHint.provider) return;
    if (this.parseProviderQualifiedHint(hintedModel)) return;

    const slotKeys = new Set<string>();
    for (const candidate of fallbackCandidates) {
      if (candidate.slotKey) slotKeys.add(candidate.slotKey);
    }
    for (const entry of this.config.modelRegistry?.models ?? []) {
      slotKeys.add(entry.id);
    }
    if (slotKeys.has(hintedModel)) {
      throw new LegacyModelHintError(hintedModel);
    }
  }

  private resolveCandidates(
    purpose: RoutingPurpose,
    modelHint: LLMCompletionModelHint | undefined,
  ): RoutingCandidate[] {
    const candidates = resolveRoutingCandidates(this.config, purpose);
    const normalizedHint = this.normalizeModelHint(modelHint);
    if (!normalizedHint) return candidates;
    this.ensureNonLegacyModelHint(normalizedHint, candidates);

    const hintedCandidate = this.resolveModelHintCandidate(normalizedHint, candidates);
    if (!hintedCandidate) return candidates;

    log.debug('Applying completion model hint', {
      purpose,
      requestedModel: normalizedHint.model ?? null,
      requestedProvider: normalizedHint.provider ?? null,
      pin: normalizedHint.pin ?? false,
      routedModel: hintedCandidate.model,
      routedProvider: hintedCandidate.provider,
    });

    if (normalizedHint.pin === true) {
      return [hintedCandidate];
    }

    return this.dedupeCandidates([hintedCandidate, ...candidates]);
  }

  private applyPurposeOutputLimits(
    purpose: RoutingPurpose,
    candidate: RoutingCandidate,
  ): RoutingCandidate {
    if (purpose !== 'vision') return candidate;
    const maxTokens = clampVisionCompletionMaxTokens(candidate.maxTokens);
    if (maxTokens === candidate.maxTokens) return candidate;
    return {
      ...candidate,
      maxTokens,
    };
  }

  private buildPiContext(context: LLMContext): PiContext {
    return {
      systemPrompt: mergeSystemContextIntoSystemPrompt(context.systemPrompt, context.messages),
      messages: contextMessagesToPiMessages(context.messages),
      ...(context.tools?.length ? { tools: toPiTools(context.tools) } : {}),
    };
  }

  private resolveRouteKind(candidate: RoutingCandidate): LLMProviderObservability['routeKind'] {
    if (candidate.requestBaseUrl) return 'request_base_url';
    if (this.litellmBaseUrl) return 'configured_litellm_proxy';
    return 'registered_model';
  }

  private toProviderWireMessages(context: PiContext, systemTransport: ReturnType<typeof resolveSystemRoleCapabilityMetadata>): LLMProviderWireMessage[] {
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

  private buildProviderObservability(
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
      promptCaching: promptCachingOverride ?? this.buildPromptCacheObservability(candidate, correlation),
      providerWireMessages: this.toProviderWireMessages(context, systemRole),
    };
  }

  private estimateBudgetInputTokens(context: PiContext): number {
    const budgetMessages = [];
    if (context.systemPrompt) {
      budgetMessages.push({
        role: 'system',
        content: context.systemPrompt,
      });
    }
    for (const message of context.messages) {
      budgetMessages.push({
        role: message.role,
        content: typeof message.content === 'string'
          ? message.content
          : JSON.stringify(message.content),
      });
    }
    return Math.max(1, countMessageTokens(budgetMessages));
  }

  private resolveEstimatedBudgetInputTokens(context: PiContext): number | undefined {
    if (!this.budgetController.requiresPreflightEstimate()) {
      return undefined;
    }
    return this.estimateBudgetInputTokens(context);
  }

  private resolveBudgetService(purpose: RoutingPurpose, correlation: ResolvedCorrelationMetadata | undefined): string {
    if (purpose === 'memory') return 'memory';
    if (correlation?.callType) return correlation.callType;
    if (purpose === 'chat') return 'chat';
    return 'background';
  }

  private resolveBudgetProcess(purpose: RoutingPurpose, correlation: ResolvedCorrelationMetadata | undefined): string {
    return correlation?.originStage ?? correlation?.purpose ?? purpose;
  }

  private resolveModelCallRuntimeClass(
    purpose: RoutingPurpose,
    correlation: ResolvedCorrelationMetadata | undefined,
  ) {
    return resolveRuntimeLaneClassForModelCall({
      purpose,
      callType: correlation?.callType ?? inferCorrelationCallType(purpose, correlation?.channelId),
      ...(correlation?.channelId ? { channelId: correlation.channelId } : {}),
      ...(correlation?.originStage ? { originStage: correlation.originStage } : {}),
    });
  }

  private resolveModelCallResourceKey(candidate: RoutingCandidate): string | null {
    const routeKind = this.resolveRouteKind(candidate);
    if (routeKind === 'request_base_url') {
      return `request_base_url::${normalizeSharedRouteKey(candidate.requestBaseUrl)}`;
    }
    if (routeKind === 'configured_litellm_proxy') {
      return `configured_litellm_proxy::${normalizeSharedRouteKey(this.litellmBaseUrl)}`;
    }

    const provider = candidate.provider.trim().toLowerCase();
    if (provider === 'litellm' || provider === 'local_endpoint') {
      return `registered_model::${provider}`;
    }
    return null;
  }

  private resolveCircuitBreakerKey(
    method: 'llm.stream' | 'llm.complete',
    candidate: RoutingCandidate,
  ): string {
    const routeKey = this.resolveModelCallResourceKey(candidate) ?? 'registered_model';
    return [
      method,
      candidate.provider.trim().toLowerCase(),
      candidate.model.trim().toLowerCase(),
      routeKey,
    ].join('::');
  }

  private logCircuitBreakerTransition(transition: CircuitBreakerTransition): void {
    const payload = {
      method: transition.method,
      circuitKey: transition.key,
      from: transition.from,
      to: transition.to,
      reason: transition.reason,
      failureCount: transition.failureCount,
      failureThreshold: transition.failureThreshold,
      windowMs: transition.windowMs,
      cooldownMs: transition.cooldownMs,
      ...(transition.openUntilMs !== undefined ? {
        openUntil: new Date(transition.openUntilMs).toISOString(),
      } : {}),
      ...(transition.lastError ? { lastError: transition.lastError } : {}),
    };

    if (transition.to === 'open') {
      log.warn('LLM circuit breaker opened', payload);
      return;
    }
    log.info('LLM circuit breaker state changed', payload);
  }

  private async runTransportWithCircuitBreaker<T>(
    method: 'llm.stream' | 'llm.complete',
    candidate: RoutingCandidate,
    operation: () => Promise<T>,
  ): Promise<T> {
    return await this.circuitBreaker.execute({
      key: this.resolveCircuitBreakerKey(method, candidate),
      method,
      operation,
      shouldRecordFailure: isRetryableError,
      onTransition: transition => this.logCircuitBreakerTransition(transition),
    });
  }

  private async runWithModelCallGate<T>(
    purpose: RoutingPurpose,
    candidate: RoutingCandidate,
    correlation: ResolvedCorrelationMetadata | undefined,
    execute: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return await this.modelCallGate.run({
      resourceKey: this.resolveModelCallResourceKey(candidate),
      runtimeClass: this.resolveModelCallRuntimeClass(purpose, correlation),
      signal,
    }, execute);
  }

  private evaluateBudgetPreflight(
    purpose: RoutingPurpose,
    candidate: RoutingCandidate,
    estimatedInputTokens: number,
    correlation: ResolvedCorrelationMetadata | undefined,
  ): void {
    const service = this.resolveBudgetService(purpose, correlation);
    const process = this.resolveBudgetProcess(purpose, correlation);
    const preflight = this.budgetController.evaluatePreflight({
      candidate,
      purpose,
      estimatedInputTokens,
      service,
      process,
      correlation,
    });
    if (preflight.allowed) return;
    if (preflight.blockedEvent) {
      this.onBudgetBlocked?.(preflight.blockedEvent);
      throw markErrorAsNonRetryable(new ModelBudgetExceededError(preflight.blockedEvent));
    }
  }

  private createUsageLogicalCallId(
    callKind: 'chat' | 'completion',
    purpose: RoutingPurpose,
    candidate: RoutingCandidate,
    correlation: ResolvedCorrelationMetadata | undefined,
    attempt: number,
  ): string {
    this.usageCallCounter += 1;
    return [
      'llm',
      process.pid,
      this.usageCallCounter,
      callKind,
      purpose,
      correlation?.requestId ?? 'unknown',
      correlation?.toolCallId ?? 'none',
      candidate.provider,
      candidate.model,
      attempt,
    ].join(':');
  }

  private recordUsage(
    purpose: RoutingPurpose,
    callKind: 'chat' | 'completion',
    candidate: RoutingCandidate,
    inputTokens: number,
    outputTokens: number,
    correlation: ResolvedCorrelationMetadata | undefined,
    usageDetails: LLMUsageDetails | undefined,
    options: {
      startedAtMs: number;
      completedAtMs: number;
      ttftMs?: number;
      attempt: number;
      stopReason?: string;
      providerObservability?: LLMProviderObservability;
      metadata?: Record<string, unknown>;
    },
  ): void {
    const service = this.resolveBudgetService(purpose, correlation);
    const process = this.resolveBudgetProcess(purpose, correlation);
    const budgetRecord = this.budgetController.recordUsage({
      candidate,
      purpose,
      service,
      process,
      inputTokens,
      outputTokens,
      correlation,
    });
    const chargeSnapshot = getRunChargeSnapshot();
    const providerCostUsd = normalizeUsageCost(usageDetails?.cost?.total);
    const estimatedCostUsd = normalizeUsageCost(budgetRecord.estimatedCostUsd) ?? 0;
    const logicalCallId = this.createUsageLogicalCallId(callKind, purpose, candidate, correlation, options.attempt);
    const metadata = {
      ...(options.metadata ?? {}),
      ...(options.providerObservability
        ? {
            routeKind: options.providerObservability.routeKind,
            backendProvider: options.providerObservability.backendProvider,
            backendModel: options.providerObservability.backendModel,
            backendApi: options.providerObservability.backendApi,
            ...(options.providerObservability.backendBaseUrl
              ? { backendBaseUrl: options.providerObservability.backendBaseUrl }
              : {}),
          }
        : {}),
      ...(usageDetails?.raw ? { rawUsage: usageDetails.raw } : {}),
      ...(usageDetails?.cost ? { providerCost: usageDetails.cost } : {}),
    };

    void this.usageRecorder?.recordUsageEvent({
      logicalCallId,
      attempt: options.attempt,
      recordedAtMs: options.completedAtMs,
      startedAtMs: options.startedAtMs,
      completedAtMs: options.completedAtMs,
      durationMs: Math.max(0, options.completedAtMs - options.startedAtMs),
      ...(options.ttftMs !== undefined ? { ttftMs: options.ttftMs } : {}),
      status: 'success',
      callKind,
      callType: correlation?.callType ?? (callKind === 'chat' ? 'chat' : 'background'),
      purpose,
      ...(correlation?.originType ? { originType: correlation.originType } : {}),
      ...(correlation?.originStage ? { originStage: correlation.originStage } : {}),
      service,
      process,
      ...(correlation?.turnId ? { turnId: correlation.turnId } : {}),
      ...(correlation?.requestId ? { requestId: correlation.requestId } : {}),
      ...(correlation?.channelId ? { channelId: correlation.channelId } : {}),
      ...(correlation?.toolName ? { toolName: correlation.toolName } : {}),
      ...(correlation?.toolCallId ? { toolCallId: correlation.toolCallId } : {}),
      ...(chargeSnapshot
        ? {
            chargeLane: chargeSnapshot.lane,
            chargeRunId: chargeSnapshot.lineage.runId,
            chargeRootRunId: chargeSnapshot.lineage.rootRunId,
            ...(chargeSnapshot.lineage.parentRunId ? { chargeParentRunId: chargeSnapshot.lineage.parentRunId } : {}),
          }
        : {}),
      provider: candidate.provider,
      model: normalizeModelIdForProvider(candidate.provider, candidate.model),
      ...(candidate.slotKey ? { slotKey: candidate.slotKey } : {}),
      requestedProvider: candidate.provider,
      requestedModel: candidate.model,
      inputTokens: usageDetails?.input ?? inputTokens,
      outputTokens: usageDetails?.output ?? outputTokens,
      cacheReadTokens: usageDetails?.cacheRead ?? 0,
      cacheWriteTokens: usageDetails?.cacheWrite ?? 0,
      ...(usageDetails?.totalTokens !== undefined ? { totalTokens: usageDetails.totalTokens } : {}),
      ...(providerCostUsd !== undefined ? { providerCostUsd } : {}),
      estimatedCostUsd,
      costSource: providerCostUsd !== undefined ? 'provider' : (estimatedCostUsd > 0 ? 'estimate' : 'none'),
      ...(usageDetails?.cost?.currency ? { currency: usageDetails.cost.currency } : {}),
      ...(options.stopReason ? { stopReason: options.stopReason } : {}),
      metadata,
    }).catch((error) => {
      log.warn('Failed to persist model usage event', {
        error: error instanceof Error ? error.message : String(error),
        provider: candidate.provider,
        model: candidate.model,
        purpose,
        ...correlation,
      });
    });
  }

  async stream(context: LLMContext, callbacks?: StreamCallbacks): Promise<LLMResponse> {
    const piContext = this.buildPiContext(context);
    const estimatedInputTokens = this.resolveEstimatedBudgetInputTokens(piContext);
    const correlation = this.resolveCorrelation(context.correlation, undefined, 'chat');
    const modelHint = this.mergeModelHints(context.modelHint, undefined);
    const startedAtMs = Date.now();
    let firstTokenAtMs: number | undefined;

    try {
      const { result: finalResponse, candidate, attempts } = await this.runWithFallback(
        'chat',
        async (candidateTarget) => {
          const transport = this.transport;
          if (transport) {
            const transportContext = this.buildTransportContext(context, candidateTarget, correlation);
            return await this.runTransportWithCircuitBreaker(
              'llm.stream',
              candidateTarget,
              async () => await transport.stream(transportContext, callbacks),
            );
          }
          const { model, apiKey } = this.getModelAndKey(candidateTarget);
          const requestOptions = this.buildRequestOptions(candidateTarget, apiKey, { correlation });
          const promptCaching = this.applyModelAgnosticPromptCache({
            candidate: candidateTarget,
            model,
            systemPrompt: piContext.systemPrompt ?? '',
            boundaries: context.promptCacheBoundaries,
            correlation,
            requestOptions,
          });
          const providerObservability = this.buildProviderObservability(
            candidateTarget,
            model,
            piContext,
            correlation,
            promptCaching ?? undefined,
          );

          return withRetry(async () => {
            const eventStream = streamSimple(
              model,
              piContext,
              requestOptions,
            );

            let content = '';
            let reasoning = '';
            const toolCalls: ToolCall[] = [];
            let response: LLMResponse | null = null;
            let emittedData = false;
            let emittedTextLength = 0;
            let sawTextDelta = false;

            try {
              for await (const event of eventStream) {
                switch (event.type) {
                  case 'text_delta':
                    if (firstTokenAtMs === undefined) firstTokenAtMs = Date.now();
                    sawTextDelta = true;
                    content += event.delta;
                    assertNoProviderResponsePrefixArtifact(content, candidateTarget);
                    if (isPotentialProviderResponsePrefixArtifact(content)) {
                      break;
                    }
                    {
                      const unEmitted = content.slice(emittedTextLength);
                      emittedTextLength = content.length;
                      if (unEmitted) {
                        emittedData = true;
                        callbacks?.onText?.(unEmitted);
                      }
                    }
                    break;

                  case 'thinking_delta':
                    if (firstTokenAtMs === undefined) firstTokenAtMs = Date.now();
                    emittedData = true;
                    reasoning += event.delta;
                    break;

                  case 'toolcall_end':
                    if (firstTokenAtMs === undefined) firstTokenAtMs = Date.now();
                    emittedData = true;
                    toolCalls.push({
                      id: event.toolCall.id,
                      name: event.toolCall.name,
                      input: event.toolCall.arguments,
                    });
                    callbacks?.onToolCall?.(event.toolCall.name, event.toolCall.arguments);
                    break;

                  case 'done': {
                    if (firstTokenAtMs === undefined) firstTokenAtMs = Date.now();
                    const contentBlocks = event.message.content as unknown[];
                    const finalTextContent = extractTextContent(contentBlocks);
                    // If text_delta events didn't fire, extract text from content blocks
                    if (!content || (isPotentialProviderResponsePrefixArtifact(content) && finalTextContent)) {
                      content = finalTextContent;
                    }
                    // Extract reasoning from content blocks if thinking_delta didn't fire
                    if (!reasoning) {
                      reasoning = extractReasoningContent(contentBlocks);
                    }
                    const finalToolCalls = extractToolCallsFromContentBlocks(contentBlocks);
                    // Normalize away stringified content block arrays from streaming
                    content = normalizeContent(content);
                    assertNoProviderResponsePrefixArtifact(content, candidateTarget);
                    if (sawTextDelta && content.length > emittedTextLength) {
                      const unEmitted = content.slice(emittedTextLength);
                      emittedTextLength = content.length;
                      if (unEmitted) {
                        emittedData = true;
                        callbacks?.onText?.(unEmitted);
                      }
                    }
                    const usageDetails = normalizeLLMUsageDetails(
                      event.message.usage,
                      event.message.usage.input,
                      event.message.usage.output,
                    );
                    response = {
                      content,
                      ...(reasoning ? { reasoning } : {}),
                      providerObservability,
                      toolCalls: finalToolCalls.length > 0 ? finalToolCalls : toolCalls,
                      model: event.message.model,
                      inputTokens: usageDetails.input,
                      outputTokens: usageDetails.output,
                      usageDetails,
                      stopReason: event.reason,
                    };
                    break;
                  }

                  case 'error': {
                    const error = new Error(event.error.errorMessage ?? 'LLM stream error');
                    if (emittedData) {
                      markErrorAsNonRetryable(error);
                    }
                    throw error;
                  }
                }
              }
            } catch (error) {
              const err = error instanceof Error ? error : new Error(String(error));
              if (emittedData) {
                markErrorAsNonRetryable(err);
              }
              throw err;
            }

            if (response) {
              assertUsableProviderResponse(response, candidateTarget);
              return response;
            }

            log.warn('Stream completed without done event', { model: String(model.id), hasContent: !!content });
            const incompleteResponse = {
              content,
              ...(reasoning ? { reasoning } : {}),
              providerObservability,
              toolCalls,
              model: String(model.id),
              inputTokens: 0,
              outputTokens: 0,
              usageDetails: normalizeLLMUsageDetails(undefined, 0, 0),
              stopReason: 'unknown',
            };
            assertUsableProviderResponse(incompleteResponse, candidateTarget);
            return incompleteResponse;
          }, llmRetryConfig(this.config), {
            circuitBreaker: {
              breaker: this.circuitBreaker,
              key: this.resolveCircuitBreakerKey('llm.stream', candidateTarget),
              method: 'llm.stream',
              onTransition: transition => this.logCircuitBreakerTransition(transition),
            },
            onRetry: ({ attempt, maxRetries, delayMs, error }) => {
              log.warn('LLM stream failed, retrying', {
                model: String(model.id),
                provider: candidateTarget.provider,
                attempt,
                maxRetries,
                delayMs,
                error: error.message,
                ...correlation,
                purpose: 'chat',
              });
            },
          });
        },
        {
          modelHint,
          correlation,
          estimatedInputTokens,
        },
      );

      log.info('LLM stream completed', {
        model: candidate.model,
        provider: candidate.provider,
        routeKind: finalResponse.providerObservability?.routeKind ?? 'unknown',
        backendProvider: finalResponse.providerObservability?.backendProvider,
        backendModel: finalResponse.providerObservability?.backendModel,
        backendApi: finalResponse.providerObservability?.backendApi,
        attempts,
        ...correlation,
        purpose: 'chat',
      });

      this.recordUsage(
        'chat',
        'chat',
        candidate,
        finalResponse.inputTokens,
        finalResponse.outputTokens,
        correlation,
        finalResponse.usageDetails,
        {
          startedAtMs,
          completedAtMs: Date.now(),
          ...(firstTokenAtMs !== undefined ? { ttftMs: Math.max(0, firstTokenAtMs - startedAtMs) } : {}),
          attempt: attempts,
          stopReason: finalResponse.stopReason,
          providerObservability: finalResponse.providerObservability,
          metadata: {
            fallbackAttempts: attempts,
            toolCallCount: finalResponse.toolCalls.length,
          },
        },
      );

      callbacks?.onDone?.(finalResponse);
      return finalResponse;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      callbacks?.onError?.(err);
      throw err;
    }
  }

  async complete(
    context: LLMContext,
    purpose: CompletionPurpose,
    options: LLMCompletionOptions = {},
  ): Promise<LLMResponse> {
    const routingPurpose = this.toRoutingPurpose(purpose);
    const piContext = this.buildPiContext(context);
    const estimatedInputTokens = this.resolveEstimatedBudgetInputTokens(piContext);
    const correlation = this.resolveCorrelation(context.correlation, options.correlation, purpose);
    const modelHint = this.mergeModelHints(context.modelHint, options.modelHint);
    const startedAtMs = Date.now();

    const { result: response, candidate, attempts } = await this.runWithFallback(
      routingPurpose,
      async (candidateTarget) => {
        const transport = this.transport;
        if (transport) {
          const transportContext = this.buildTransportContext(context, candidateTarget, correlation);
          const executeTransport = async () => await transport.complete(transportContext, purpose);
          const response = options.disableRetry
            ? await executeTransport()
            : await this.runTransportWithCircuitBreaker(
                'llm.complete',
                candidateTarget,
                executeTransport,
              );
          assertUsableProviderResponse(response, candidateTarget);
          return response;
        }
        const { model, apiKey } = this.getModelAndKey(candidateTarget);
        const requestOptions = this.buildRequestOptions(candidateTarget, apiKey, {
          signal: options.signal,
          correlation,
        });
        const promptCaching = this.applyModelAgnosticPromptCache({
          candidate: candidateTarget,
          model,
          systemPrompt: piContext.systemPrompt ?? '',
          boundaries: context.promptCacheBoundaries,
          correlation,
          requestOptions,
        });
        const providerObservability = this.buildProviderObservability(
          candidateTarget,
          model,
          piContext,
          correlation,
          promptCaching ?? undefined,
        );

        const request = async () => {
          try {
            return await completeSimple(
              model,
              piContext,
              requestOptions,
            );
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            if (isAbortError(err) || options.signal?.aborted) {
              markErrorAsNonRetryable(err);
            }
            throw err;
          }
        };

        if (options.disableRetry) {
          const response = await request();
          assertUsableProviderResponse(response, candidateTarget);
          return {
            response,
            providerObservability,
          };
        }

        const response = await withRetry(request, llmRetryConfig(this.config), {
          circuitBreaker: {
            breaker: this.circuitBreaker,
            key: this.resolveCircuitBreakerKey('llm.complete', candidateTarget),
            method: 'llm.complete',
            onTransition: transition => this.logCircuitBreakerTransition(transition),
          },
          onRetry: ({ attempt, maxRetries, delayMs, error }) => {
            log.warn('LLM complete failed, retrying', {
              model: String(model.id),
              provider: candidateTarget.provider,
              attempt,
              maxRetries,
              delayMs,
              error: error.message,
              ...correlation,
              purpose,
              routingPurpose,
            });
          },
        });
        assertUsableProviderResponse(response, candidateTarget);
        return { response, providerObservability };
      },
        {
          modelHint,
          correlation,
          estimatedInputTokens,
          signal: options.signal,
        },
      );

    const completionResponse = (
      'response' in response
        ? response.response
        : response
    ) as {
      content: unknown;
      usage?: unknown;
      reasoning?: string;
      toolCalls?: ToolCall[];
      model: string;
      inputTokens?: number;
      outputTokens?: number;
      stopReason?: string;
      providerObservability?: LLMProviderObservability;
    };
    const providerObservability = (
      ('providerObservability' in response && response.providerObservability)
        ? response.providerObservability
        : completionResponse.providerObservability
    );

    log.info('LLM complete finished', {
      model: candidate.model,
      provider: candidate.provider,
      routeKind: providerObservability?.routeKind ?? 'unknown',
      backendProvider: providerObservability?.backendProvider,
      backendModel: providerObservability?.backendModel,
      backendApi: providerObservability?.backendApi,
      attempts,
      requestedModelHint: modelHint?.model,
      ...correlation,
      purpose,
      routingPurpose,
    });

    const responseContent = completionResponse.content as unknown;
    const contentBlocks = Array.isArray(responseContent) ? responseContent : undefined;
    const content = typeof responseContent === 'string'
      ? responseContent
      : extractTextContent(contentBlocks);
    const reasoning = typeof completionResponse.reasoning === 'string'
      ? completionResponse.reasoning
      : extractReasoningContent(contentBlocks);
    const usageDetails = normalizeLLMUsageDetails(
      completionResponse.usage,
      completionResponse.inputTokens ?? 0,
      completionResponse.outputTokens ?? 0,
    );
    const inputTokens = usageDetails.input;
    const outputTokens = usageDetails.output;

    this.recordUsage(
      routingPurpose,
      'completion',
      candidate,
      inputTokens,
      outputTokens,
      correlation,
      usageDetails,
      {
        startedAtMs,
        completedAtMs: Date.now(),
        attempt: attempts,
        stopReason: completionResponse.stopReason ?? 'unknown',
        providerObservability,
        metadata: {
          completionPurpose: purpose,
          routingPurpose,
          fallbackAttempts: attempts,
        },
      },
    );

    return {
      content: normalizeContent(content),
      ...(reasoning ? { reasoning } : {}),
      ...(
        providerObservability
          ? { providerObservability }
          : {}
      ),
      toolCalls: Array.isArray(completionResponse.toolCalls) ? completionResponse.toolCalls : [],
      model: completionResponse.model,
      inputTokens,
      outputTokens,
      usageDetails,
      stopReason: completionResponse.stopReason ?? 'unknown',
    };
  }

  private resolveCorrelation(
    contextCorrelation: CorrelationMetadata | undefined,
    optionCorrelation: Partial<CorrelationMetadata> | undefined,
    purpose: CompletionPurpose | 'chat',
  ): ResolvedCorrelationMetadata {
    return resolveCorrelationMetadata(contextCorrelation, optionCorrelation, purpose);
  }

  private toRoutingPurpose(purpose: CompletionPurpose): RoutingPurpose {
    if (purpose === 'reasoning') {
      return 'reasoning';
    }
    if (purpose === 'import_processing') {
      return 'import_processing';
    }
    if (purpose === 'memory') {
      return 'memory';
    }
    if (purpose === 'context') {
      return 'context';
    }
    if (purpose === 'extraction') {
      return 'extraction';
    }
    if (purpose === 'summary') {
      return 'summary';
    }
    if (purpose === 'vision') {
      return 'vision';
    }
    return 'background';
  }

  private toEligibilityPurpose(purpose: RoutingPurpose): string {
    if (purpose === 'chat') return 'chat';
    if (purpose === 'reasoning') return 'reasoning';
    if (purpose === 'import_processing') return 'import_processing';
    if (purpose === 'memory') return 'memory';
    return 'background';
  }

  private async runWithFallback<T>(
    purpose: RoutingPurpose,
    execute: (candidate: RoutingCandidate, attempt: number) => Promise<T>,
    options: {
      modelHint?: LLMCompletionModelHint;
      correlation?: ResolvedCorrelationMetadata;
      estimatedInputTokens?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<{ result: T; candidate: RoutingCandidate; attempts: number }> {
    if (this.eligibilityGate) {
      const decision = this.eligibilityGate.evaluate({
        kind: 'llm.purpose',
        purpose: this.toEligibilityPurpose(purpose),
      });
      this.onEligibilityDecision?.(decision);
      if (!decision.allowed) {
        log.warn('LLM purpose denied by eligibility gate', {
          purpose,
          reasonCode: decision.reasonCode,
          tier: decision.tier,
          requiredTokens: decision.requiredTokens,
          missingTokens: decision.missingTokens,
          minimumTier: decision.minimumTier,
          ...options.correlation,
        });
        throw new EligibilityDeniedError(decision);
      }
      log.debug('LLM purpose allowed by eligibility gate', {
        purpose,
        tier: decision.tier,
        reasonCode: decision.reasonCode,
        ...options.correlation,
      });
    }

    const candidates = this.resolveCandidates(purpose, options.modelHint);
    return this.fallbackRunner.run(purpose, candidates, async (candidate, attempt) => {
      const effectiveCandidate = this.applyPurposeOutputLimits(purpose, candidate);
      this.evaluateBudgetPreflight(
        purpose,
        effectiveCandidate,
        options.estimatedInputTokens ?? 0,
        options.correlation,
      );
      this.enforceImportRoutingPolicy(purpose, effectiveCandidate);
      return await this.runWithModelCallGate(
        purpose,
        effectiveCandidate,
        options.correlation,
        () => execute(effectiveCandidate, attempt),
        options.signal,
      );
    }, options.correlation);
  }
}

function isAbortError(error: Error): boolean {
  return error.name === 'AbortError' || /aborted|abort|cancelled|canceled/i.test(error.message);
}


function normalizeUsageCount(value: unknown): number {
  const numeric = toFiniteNumber(value);
  return numeric !== undefined && numeric > 0 ? Math.floor(numeric) : 0;
}

function normalizeUsageCost(value: unknown): number | undefined {
  const numeric = toFiniteNumber(value);
  return numeric !== undefined && numeric >= 0 ? numeric : undefined;
}

function normalizeUsageCountFromRecord(record: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const count = normalizeUsageCount(record[key]);
    if (count > 0) return count;
  }
  return 0;
}

function optionalRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function normalizeLLMUsageCostDetails(value: unknown): LLMUsageCostDetails | undefined {
  const totalFromNumericCost = normalizeUsageCost(value);
  if (totalFromNumericCost !== undefined) {
    return { total: totalFromNumericCost };
  }

  if (!isRecord(value)) return undefined;
  const input = normalizeUsageCost(value.input);
  const output = normalizeUsageCost(value.output);
  const cacheRead = normalizeUsageCost(value.cacheRead);
  const cacheWrite = normalizeUsageCost(value.cacheWrite);
  const total = normalizeUsageCost(value.total);
  const currency = typeof value.currency === 'string' && value.currency.trim().length > 0
    ? value.currency.trim().toUpperCase()
    : undefined;
  if (
    input === undefined
    && output === undefined
    && cacheRead === undefined
    && cacheWrite === undefined
    && total === undefined
    && currency === undefined
  ) {
    return undefined;
  }
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(total !== undefined ? { total } : {}),
    ...(currency ? { currency } : {}),
  };
}

function normalizeLLMUsageDetails(
  value: unknown,
  fallbackInputTokens: number,
  fallbackOutputTokens: number,
): LLMUsageDetails {
  const record = isRecord(value) ? value : {};
  const promptTokenDetails = optionalRecord(record.prompt_tokens_details);
  const input = normalizeUsageCountFromRecord(record, 'input', 'prompt_tokens')
    || normalizeUsageCount(fallbackInputTokens);
  const output = normalizeUsageCountFromRecord(record, 'output', 'completion_tokens')
    || normalizeUsageCount(fallbackOutputTokens);
  const cacheRead = normalizeUsageCountFromRecord(record, 'cacheRead')
    || normalizeUsageCount(promptTokenDetails.cached_tokens);
  const cacheWrite = normalizeUsageCountFromRecord(record, 'cacheWrite')
    || normalizeUsageCount(promptTokenDetails.cache_write_tokens);
  const totalTokens = normalizeUsageCountFromRecord(record, 'totalTokens', 'total_tokens')
    || input + output + cacheRead + cacheWrite;
  const cost = normalizeLLMUsageCostDetails(record.cost);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    ...(cost ? { cost } : {}),
    ...(isRecord(value) ? { raw: { ...value } } : {}),
  };
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}

function toPositiveInteger(value: unknown): number | undefined {
  const numeric = toFiniteNumber(value);
  if (numeric === undefined || numeric <= 0) return undefined;
  return Math.floor(numeric);
}

function toUnitInterval(value: unknown): number | undefined {
  const numeric = toFiniteNumber(value);
  if (numeric === undefined || numeric < 0 || numeric > 1) return undefined;
  return numeric;
}

function toThinkingEffort(value: unknown): ThinkingLevel | undefined {
  switch (value) {
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return value;
    default:
      return undefined;
  }
}

function normalizeSharedRouteKey(value: string | null | undefined): string {
  const normalized = value?.trim();
  if (!normalized) {
    return 'shared';
  }

  try {
    const parsed = new URL(normalized);
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return `${parsed.origin}${pathname}`.toLowerCase();
  } catch {
    return normalized.toLowerCase();
  }
}

function extractToolCallsFromContentBlocks(blocks?: unknown[]): ToolCall[] {
  if (!Array.isArray(blocks) || blocks.length === 0) return [];
  return blocks.flatMap((block) => {
    if (!block || typeof block !== 'object') return [];
    const candidate = block as {
      type?: unknown;
      id?: unknown;
      name?: unknown;
      arguments?: unknown;
    };
    if (candidate.type !== 'toolCall') return [];
    if (typeof candidate.id !== 'string' || typeof candidate.name !== 'string') return [];
    return [{
      id: candidate.id,
      name: candidate.name,
      input: candidate.arguments && typeof candidate.arguments === 'object'
        ? candidate.arguments as Record<string, unknown>
        : {},
    }];
  });
}

function assertUsableProviderResponse(
  response: {
    content?: unknown;
    toolCalls?: unknown;
  },
  candidate: RoutingCandidate,
): void {
  const contentBlocks = Array.isArray(response.content) ? response.content : undefined;
  const content = typeof response.content === 'string'
    ? response.content
    : extractTextContent(contentBlocks);
  const normalizedContent = normalizeContent(content);
  assertNoProviderResponsePrefixArtifact(normalizedContent, candidate);
  const directToolCalls = Array.isArray(response.toolCalls) ? response.toolCalls : [];
  const blockToolCalls = extractToolCallsFromContentBlocks(contentBlocks);

  if (normalizedContent.trim().length > 0 || directToolCalls.length > 0 || blockToolCalls.length > 0) {
    return;
  }

  throw new Error(`LLM response from ${candidate.provider}/${candidate.model} contained no text or tool calls`);
}

function detectProviderResponsePrefixArtifact(content: string): string | null {
  const normalized = content.trimStart();
  if (!normalized) return null;
  const specialToken = PROVIDER_RESPONSE_PREFIX_ARTIFACTS.find((artifact) => normalized.startsWith(artifact));
  if (specialToken) return specialToken;
  const responseHeader = normalized.match(PROVIDER_RESPONSE_HEADER_ARTIFACT_PATTERN)?.[0]?.trim();
  return responseHeader || null;
}

function isPotentialProviderResponsePrefixArtifact(content: string): boolean {
  const normalized = content.trimStart();
  if (!normalized) return true;
  if (detectProviderResponsePrefixArtifact(content)) return true;
  if (PROVIDER_RESPONSE_PREFIX_ARTIFACTS.some((artifact) => artifact.startsWith(normalized))) return true;
  return isPotentialProviderResponseHeaderArtifact(normalized);
}

function assertNoProviderResponsePrefixArtifact(content: string, candidate: RoutingCandidate): void {
  const artifact = detectProviderResponsePrefixArtifact(content);
  if (!artifact) return;
  throw new Error(
    `LLM response from ${candidate.provider}/${candidate.model} began with provider template artifact ${artifact}`,
  );
}

function isPotentialProviderResponseHeaderArtifact(normalizedContent: string): boolean {
  if (!normalizedContent.startsWith('#')) return false;
  if (/\r?\n/u.test(normalizedContent)) return false;
  return normalizedContent.length <= PROVIDER_RESPONSE_HEADER_POTENTIAL_MAX_CHARS;
}

function normalizeProxyModelId(provider: string, modelId: string): string {
  const normalizedProvider = provider.trim().toLowerCase();
  const normalizedModelId = modelId.trim();
  if (!normalizedModelId) return normalizedModelId;
  if (normalizedProvider !== 'openrouter') return normalizedModelId;
  if (normalizedModelId.startsWith('openrouter/')) return normalizedModelId;
  return normalizedModelId.includes('/')
    ? `openrouter/${normalizedModelId}`
    : normalizedModelId;
}

// ── Content normalization ──
// pi-ai + LiteLLM sometimes delivers content block arrays as stringified text via streaming,
// e.g. [{'type': 'text', 'text': 'actual response'}]. This strips the wrapping to prevent
// compounding on subsequent turns (stored malformatted content gets re-wrapped by the LLM).
const SQ_PREFIX = "[{'type': 'text', 'text': '";
const DQ_PREFIX = '[{"type": "text", "text": "';

function extractQuotedText(s: string, startIndex: number, quoteChar: string): string | null {
  let result = '';
  for (let i = startIndex; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      const next = s[i + 1];
      if (next === '\\') { result += '\\'; i++; }
      else if (next === quoteChar) { result += quoteChar; i++; }
      else if (next === 'n') { result += '\n'; i++; }
      else if (next === 't') { result += '\t'; i++; }
      else { result += s[i]; }
    } else if (s[i] === quoteChar) {
      // Found closing quote — return extracted text (ignore trailing garbage)
      return result;
    } else {
      result += s[i];
    }
  }
  return null; // No closing quote found
}

export function normalizeContent(content: string): string {
  let result = content;
  for (let i = 0; i < 3; i++) {
    const t = result.trim();
    if (t.startsWith(SQ_PREFIX)) {
      const extracted = extractQuotedText(t, SQ_PREFIX.length, "'");
      if (extracted !== null) { result = extracted; continue; }
    }
    if (t.startsWith(DQ_PREFIX)) {
      const extracted = extractQuotedText(t, DQ_PREFIX.length, '"');
      if (extracted !== null) { result = extracted; continue; }
    }
    break;
  }
  return result;
}

export function inferCallType(
  purpose: CompletionPurpose | 'chat',
  channelId?: string,
) {
  return inferCorrelationCallType(purpose, channelId);
}
