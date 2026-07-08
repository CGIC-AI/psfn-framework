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
  ToolSchema,
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
  evaluateImportPolicy,
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
import { classifyLLMError } from './error-classify.js';
import {
  assertNoProviderResponsePrefixArtifact,
  assertUsableProviderResponse,
  classifyToolArgumentProvenance,
  extractCompletionToolCalls,
  extractToolCallsFromContentBlocks,
  findCorruptEmptyToolCalls,
  isPotentialProviderResponsePrefixArtifact,
  normalizeContent,
  normalizeLLMUsageDetails,
  normalizeProxyModelId,
  normalizeSharedRouteKey,
  normalizeUsageCost,
  toDiagnosticCorrelationFields,
} from './client-response-helpers.js';
import {
  mergeModelHints,
  resolveCandidates as resolveModelHintCandidates,
} from './model-hint-routing.js';

export {
  classifyToolArgumentProvenance,
  findCorruptEmptyToolCalls,
  inferCallType,
  normalizeContent,
} from './client-response-helpers.js';
export { LegacyModelHintError } from './model-hint-routing.js';
export type { ToolArgumentProvenance } from './client-response-helpers.js';

const log = createComponentLogger('LLMClient');
// mihm: bound on how many times a single completion is re-run when its tool call
// arrives with corrupt-empty arguments against a required-property schema. After this
// many retries the (still corrupt) response is returned as-is so downstream validation
// surfaces it — fail closed, never fabricate/drop/default.
const MAX_EMPTY_TOOL_ARGS_COMPLETION_RETRIES = 2;
const LLM_CIRCUIT_BREAKER_WINDOW_MS = 60_000;
const LLM_CIRCUIT_BREAKER_COOLDOWN_MS = 30_000;
const LLM_CIRCUIT_BREAKER_FAILURE_THRESHOLD = 3;

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

  private resolveCandidates(
    purpose: RoutingPurpose,
    modelHint: LLMCompletionModelHint | undefined,
  ): RoutingCandidate[] {
    return resolveModelHintCandidates(this.config, purpose, modelHint);
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

  /**
   * gu8m diagnostics: when a streamed response contains tool calls with empty
   * arguments, emit a structured, provenance-classified warning so incidents are
   * attributable from logs alone (no live debugger required). Distinguishes:
   *  - provider_emitted_empty: the model called the tool with no arguments at all
   *    (no argument fragments arrived anywhere in the stream).
   *  - stream_parse_dropped: argument fragments DID arrive but a tool call still
   *    ended empty — the accumulator lost them (the pre-patch failure mode). This
   *    should not fire once the pi-ai index-routing patch is applied; keeping the
   *    classifier lets us confirm the fix holds and catch any regression.
   */
  private logEmptyToolArgumentProvenance(
    toolCalls: readonly ToolCall[],
    argumentFragmentBytes: number,
    candidate: RoutingCandidate,
    correlation: ResolvedCorrelationMetadata | undefined,
    attempt: number,
  ): void {
    for (const toolCall of toolCalls) {
      const provenance = classifyToolArgumentProvenance({
        args: toolCall.input,
        argumentFragmentBytes,
      });
      // Non-empty args are a genuine schema rejection if they fail downstream — not an
      // emptiness/loss incident — so the gateway does not warn on them here.
      if (provenance === 'validation_rejected') continue;
      log.warn('Tool call arrived with empty arguments', {
        provenance,
        toolName: toolCall.name,
        toolCallId: toolCall.id,
        argumentFragmentBytes,
        // 0 = first completion attempt; ≥1 = mihm empty-args completion retry.
        attempt,
        provider: candidate.provider,
        model: candidate.model,
        ...(correlation ? toDiagnosticCorrelationFields(correlation) : {}),
      });
    }
  }

  /**
   * mihm fail-closed backstop. Some OpenRouter GLM upstreams intermittently emit a
   * tool call whose streamed arguments are a literal empty object — the provider-side
   * tool-template parser dropped them (nothing client-side can recover). Dispatching
   * such a call fails AJV validation for required-property tools (or, worse, silently
   * runs an optional-action tool's default). Because the flake is a per-request routing
   * lottery, re-running the same completion usually lands a clean upstream. This wraps a
   * single completion attempt and retries the WHOLE attempt (bounded) whenever the result
   * carries a corrupt-empty tool call, then FAILS CLOSED by returning the last response
   * as-is so downstream validation surfaces the error — never fabricating args, never
   * dropping the call, never defaulting the action.
   */
  private async retryCompletionOnCorruptEmptyToolArgs<T>(input: {
    attempt: (attemptIndex: number) => Promise<T>;
    extractToolCalls: (result: T) => readonly ToolCall[];
    tools: readonly ToolSchema[] | undefined;
    candidate: RoutingCandidate;
    correlation: ResolvedCorrelationMetadata | undefined;
    purpose: string;
    onRetriesResolved: (retries: number) => void;
  }): Promise<T> {
    let result = await input.attempt(0);
    let retries = 0;
    for (;;) {
      const corrupt = findCorruptEmptyToolCalls(input.extractToolCalls(result), input.tools);
      if (corrupt.length === 0) break;
      if (retries >= MAX_EMPTY_TOOL_ARGS_COMPLETION_RETRIES) break;
      retries += 1;
      log.warn('Retrying completion: tool call arguments empty against a required-property schema', {
        toolNames: corrupt.map((call) => call.name),
        attempt: retries,
        maxRetries: MAX_EMPTY_TOOL_ARGS_COMPLETION_RETRIES,
        provider: input.candidate.provider,
        model: input.candidate.model,
        purpose: input.purpose,
        ...(input.correlation ? toDiagnosticCorrelationFields(input.correlation) : {}),
      });
      result = await input.attempt(retries);
    }

    if (retries > 0) {
      const stillCorrupt = findCorruptEmptyToolCalls(input.extractToolCalls(result), input.tools);
      log.warn('Empty-args completion retry resolved', {
        outcome: stillCorrupt.length > 0 ? 'exhausted_returned_corrupt' : 'recovered',
        retries,
        maxRetries: MAX_EMPTY_TOOL_ARGS_COMPLETION_RETRIES,
        ...(stillCorrupt.length > 0 ? { corruptToolNames: stillCorrupt.map((call) => call.name) } : {}),
        provider: input.candidate.provider,
        model: input.candidate.model,
        purpose: input.purpose,
        ...(input.correlation ? toDiagnosticCorrelationFields(input.correlation) : {}),
      });
    }

    input.onRetriesResolved(retries);
    return result;
  }

  async stream(context: LLMContext, callbacks?: StreamCallbacks): Promise<LLMResponse> {
    const piContext = this.buildPiContext(context);
    const estimatedInputTokens = this.resolveEstimatedBudgetInputTokens(piContext);
    const correlation = this.resolveCorrelation(context.correlation, undefined, 'chat');
    const modelHint = mergeModelHints(context.modelHint, undefined);
    const startedAtMs = Date.now();
    let firstTokenAtMs: number | undefined;
    // mihm: retries spent re-running the winning completion because it carried a
    // corrupt-empty tool call. Recorded into model-usage metadata_json so incidents
    // are queryable. Stays 0 unless the empty-args backstop engaged.
    let emptyArgsRetries = 0;

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

          return this.retryCompletionOnCorruptEmptyToolArgs<LLMResponse>({
            tools: context.tools,
            candidate: candidateTarget,
            correlation,
            purpose: 'chat',
            extractToolCalls: (result) => result.toolCalls,
            onRetriesResolved: (retries) => { emptyArgsRetries = retries; },
            attempt: (attemptIndex) => withRetry(async () => {
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
            // gu8m: total raw tool-argument-fragment bytes observed across the whole
            // stream. Lets us classify empty final tool arguments as provider_emitted_empty
            // (no fragments ever arrived) vs stream_parse_dropped (fragments arrived but the
            // accumulator lost them) — response-level, since the pre-patch bug orphaned
            // fragments onto a *different* content block than the named call.
            let toolArgumentFragmentBytes = 0;

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

                  case 'toolcall_delta': {
                    const fragment = (event as { delta?: unknown }).delta;
                    if (typeof fragment === 'string') {
                      toolArgumentFragmentBytes += fragment.length;
                    }
                    break;
                  }

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
              this.logEmptyToolArgumentProvenance(
                response.toolCalls,
                toolArgumentFragmentBytes,
                candidateTarget,
                correlation,
                attemptIndex,
              );
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
            shouldRetry: ({ error }) => shouldRetryWithinCandidate(error),
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
          }),
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
            emptyArgsRetries,
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
    const modelHint = mergeModelHints(context.modelHint, options.modelHint);
    const startedAtMs = Date.now();
    // mihm: see stream(). disableRetry callers opt out of all retries, so the
    // empty-args backstop only engages on the retrying path; stays 0 otherwise.
    let emptyArgsRetries = 0;

    const { result: response, candidate, attempts } = await this.runWithFallback(
      routingPurpose,
      async (candidateTarget) => {
        const transport = this.transport;
        if (transport) {
          const transportContext = this.buildTransportContext(context, candidateTarget, correlation);
          const executeTransport = async () => await transport.complete(transportContext, purpose, {
            ...(options.signal ? { signal: options.signal } : {}),
          });
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

        return this.retryCompletionOnCorruptEmptyToolArgs<{
          response: Awaited<ReturnType<typeof completeSimple>>;
          providerObservability: LLMProviderObservability;
        }>({
          tools: context.tools,
          candidate: candidateTarget,
          correlation,
          purpose,
          extractToolCalls: (result) => extractCompletionToolCalls(result.response),
          onRetriesResolved: (retries) => { emptyArgsRetries = retries; },
          attempt: (attemptIndex) => withRetry(async () => {
            const attemptResponse = await request();
            assertUsableProviderResponse(attemptResponse, candidateTarget);
            this.logEmptyToolArgumentProvenance(
              extractCompletionToolCalls(attemptResponse),
              // Non-streaming: there is no fragment channel, so an empty payload is
              // always a provider-emitted empty (never an accumulator drop).
              0,
              candidateTarget,
              correlation,
              attemptIndex,
            );
            return { response: attemptResponse, providerObservability };
          }, llmRetryConfig(this.config), {
            circuitBreaker: {
              breaker: this.circuitBreaker,
              key: this.resolveCircuitBreakerKey('llm.complete', candidateTarget),
              method: 'llm.complete',
              onTransition: transition => this.logCircuitBreakerTransition(transition),
            },
            shouldRetry: ({ error }) => shouldRetryWithinCandidate(error),
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
          }),
        });
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
          emptyArgsRetries,
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

function shouldRetryWithinCandidate(error: Error): boolean {
  return classifyLLMError(error).category !== 'connection_unavailable';
}
