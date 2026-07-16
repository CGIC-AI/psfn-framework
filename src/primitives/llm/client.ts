import {
  streamSimple,
  completeSimple,
  type AssistantMessage as PiAssistantMessage,
  type Context as PiContext,
  type Model,
  type SimpleStreamOptions,
  type ThinkingLevel,
} from '@mariozechner/pi-ai';
import { randomUUID } from 'node:crypto';
import type {
  CompletionPurpose,
  CorrelationMetadata,
  LLMCallAccountingContext,
  LLMContext,
  LLMUsageDetails,
  LLMPromptCacheObservability,
  LLMProviderObservability,
  LLMModelHint,
  LLMResponse,
  LLMProviderWireMessage,
  LLMWorkSpec,
  ModelBudgetBlockedEvent,
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
import { FallbackRunner, NonRecoverableFallbackError } from './fallback.js';
import type { ImportPolicyAuditRecord, RoutingCandidate, RoutingPurpose } from './routing.js';
import {
  evaluateImportPolicy,
} from './routing.js';
import {
  applyModelAgnosticPromptCache,
  buildPromptCacheObservability,
} from './client-prompt-cache.js';
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
  toCorrelationLogFields,
} from './correlation.js';
import {
  ModelBudgetController,
  ModelBudgetExceededError,
  normalizeModelIdForProvider,
  resolveModelUsageCostRates,
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
import type { LLMProviderPort, LLMProviderStreamOptions } from '../../core/agent/contracts.js';
import { resolveRuntimeLaneClassForModelCall } from '../../core/agent/worker-lanes.js';
import { ModelCallGate, ModelCallPreemptedError, type ModelCallGateCapacity } from './model-call-gate.js';
import { clampVisionCompletionMaxTokens } from './vision-limits.js';
import type {
  IcpConversationCostAccountingPort,
  IcpConversationCostBreakerEvent,
  ModelUsageBudgetQueryPort,
  ModelUsageRecorder,
} from '../../shared/telemetry/model-usage.js';
import { reconcileModelUsageAccounting } from '../../shared/telemetry/model-usage-accounting.js';
import { getRunChargeSnapshot } from '../../shared/telemetry/run-charge.js';
import { monotonicEpochNowMs } from '../../shared/telemetry/turn-performance.js';
import {
  type CircuitBreakerTransition,
  SlidingWindowCircuitBreaker,
} from '../../shared/resilience/circuit-breaker.js';
import { classifyLLMError } from './error-classify.js';
import {
  assertNoProviderResponsePrefixArtifact,
  assertUsableProviderResponse,
  extractCompletionToolCalls,
  extractToolCallsFromContentBlocks,
  isPotentialProviderResponsePrefixArtifact,
  normalizeContent,
  normalizeLLMUsageDetails,
  normalizeProxyModelId,
  normalizeSharedRouteKey,
} from './client-response-helpers.js';
import {
  mergeModelHints,
  resolveCandidates as resolveModelHintCandidates,
} from './model-hint-routing.js';
import {
  logEmptyToolArgumentProvenance,
  retryCompletionOnCorruptEmptyToolArgs,
} from './empty-tool-argument-retry.js';
import { normalizeLLMCallAccountingContext } from './accounting-context.js';
import {
  combineProviderCostEvidenceObservations,
  mergeProviderCostEvidenceConflicts,
  reconcileProviderCostEvidence,
  type ReconciledProviderCostEvidence,
} from '../../shared/telemetry/provider-cost-evidence.js';
import {
  IcpConversationCostBreaker,
  IcpConversationCostBreakerError,
} from './icp-conversation-cost-breaker.js';

export {
  classifyToolArgumentProvenance,
  findCorruptEmptyToolCalls,
  inferCallType,
  normalizeContent,
} from './client-response-helpers.js';
export { LegacyModelHintError } from './model-hint-routing.js';
export type { ToolArgumentProvenance } from './client-response-helpers.js';

const log = createComponentLogger('LLMClient');
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
  /**
   * mmo9.7.1: typed work spec from the autonomous entry (`completeWithWorkSpec`).
   * When present the client validates purpose agreement, reconciles the declared
   * lane byte-identically with the gate resolver (Law 12.4, fail closed), and
   * clamps output tokens to the spec cap. Optional so foreground/tool/gateway
   * callers stay unchanged.
   */
  workSpec?: LLMWorkSpec;
}

export interface LLMClientRuntimeOptions {
  litellmBaseUrl?: string;
  transport?: LLMProviderPort;
  eligibilityGate?: EligibilityGate;
  onEligibilityDecision?: (decision: EligibilityDecision) => void;
  onBudgetBlocked?: (event: ModelBudgetBlockedEvent) => void;
  usageRecorder?: ModelUsageRecorder;
  usageBudgetQuery?: ModelUsageBudgetQueryPort;
  icpConversationCostAccounting?: IcpConversationCostAccountingPort;
  onIcpConversationCostDecision?: (event: IcpConversationCostBreakerEvent) => void;
  providerCostResolver?: () => ReconciledProviderCostEvidence | undefined;
  circuitBreaker?: SlidingWindowCircuitBreaker;
}

const FULL_KNOB_PASSTHROUGH_PROVIDERS = new Set(['openrouter', 'litellm', 'local_endpoint']);

function hasSubstantiveToolCallIdentity(
  partial: PiAssistantMessage,
  contentIndex: number,
): boolean {
  const block = partial.content.at(contentIndex);
  return block?.type === 'toolCall'
    && block.id.trim().length > 0
    && block.name.trim().length > 0;
}

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
  private icpConversationCostBreaker: IcpConversationCostBreaker;
  private providerCostResolver?: () => ReconciledProviderCostEvidence | undefined;
  private circuitBreaker: SlidingWindowCircuitBreaker;

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
    this.budgetController = new ModelBudgetController(config, runtimeOptions.usageBudgetQuery);
    this.transport = runtimeOptions.transport;
    this.eligibilityGate = runtimeOptions.eligibilityGate;
    this.onEligibilityDecision = runtimeOptions.onEligibilityDecision;
    this.onBudgetBlocked = runtimeOptions.onBudgetBlocked;
    this.usageRecorder = runtimeOptions.usageRecorder;
    this.icpConversationCostBreaker = new IcpConversationCostBreaker(
      config,
      runtimeOptions.icpConversationCostAccounting,
      runtimeOptions.onIcpConversationCostDecision,
    );
    this.providerCostResolver = runtimeOptions.providerCostResolver;
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

  private buildTransportContext(
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
      ...(accounting ? { accounting } : {}),
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
      promptCaching: promptCachingOverride ?? buildPromptCacheObservability({
        promptCacheStrategy: candidate.promptCacheStrategy,
        promptCacheRetention: candidate.promptCacheRetention,
        promptCacheScope: candidate.promptCacheScope,
        correlation,
      }),
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

  private resolveEstimatedBudgetInputTokens(
    context: PiContext,
    correlation: ResolvedCorrelationMetadata | undefined,
  ): number | undefined {
    if (
      !this.budgetController.requiresPreflightEstimate()
      && !this.icpConversationCostBreaker.requiresInputEstimate(correlation)
    ) {
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

  /**
   * mmo9.7.1 / Law 12.4: reconcile a declared `LLMWorkSpec` against this call.
   * Fails closed (non-retryable) if the spec's purpose disagrees with the call
   * purpose or its declared lane disagrees with the SINGLE admission lane the
   * gate resolves from the resolved correlation. No second lane resolver: the
   * gate keeps owning lane resolution; the spec.lane is a verified assertion.
   */
  private validateWorkSpecForCall(
    purpose: CompletionPurpose,
    routingPurpose: RoutingPurpose,
    workSpec: LLMWorkSpec,
    correlation: ResolvedCorrelationMetadata | undefined,
  ): void {
    if (workSpec.purpose !== purpose) {
      throw markErrorAsNonRetryable(new Error(
        `LLMWorkSpec.purpose "${workSpec.purpose}" does not match completion purpose "${purpose}"`,
      ));
    }
    const admissionLane = this.resolveModelCallRuntimeClass(routingPurpose, correlation);
    if (workSpec.lane !== admissionLane) {
      throw markErrorAsNonRetryable(new Error(
        `LLMWorkSpec.lane "${workSpec.lane}" does not reconcile with admission lane `
        + `"${admissionLane}" for purpose "${purpose}" (Law 12.4: no second lane resolver)`,
      ));
    }
  }

  /**
   * mmo9.7.1: clamp a candidate's output token budget to the work spec's
   * declared `maxOutputTokens`. Only ever reduces the ceiling (fail closed);
   * absent cap leaves the candidate untouched.
   */
  private applyWorkSpecOutputCap(
    candidate: RoutingCandidate,
    outputTokenCap: number | undefined,
  ): RoutingCandidate {
    if (outputTokenCap === undefined) return candidate;
    const capped = Math.max(1, Math.min(candidate.maxTokens, Math.floor(outputTokenCap)));
    if (capped === candidate.maxTokens) return candidate;
    return { ...candidate, maxTokens: capped };
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
    try {
      return await this.circuitBreaker.execute({
        key: this.resolveCircuitBreakerKey(method, candidate),
        method,
        operation,
        shouldRecordFailure: isRetryableError,
        onTransition: transition => this.logCircuitBreakerTransition(transition),
      });
    } catch (error) {
      if (error instanceof IcpConversationCostBreakerError) {
        throw new NonRecoverableFallbackError(error);
      }
      throw error;
    }
  }

  private async runWithModelCallGate<T>(
    purpose: RoutingPurpose,
    candidate: RoutingCandidate,
    correlation: ResolvedCorrelationMetadata | undefined,
    execute: (preemptSignal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
    preemptionProtected?: boolean,
  ): Promise<T> {
    try {
      return await this.modelCallGate.run({
        resourceKey: this.resolveModelCallResourceKey(candidate),
        runtimeClass: this.resolveModelCallRuntimeClass(purpose, correlation),
        capacity: this.resolveModelCallCapacity(candidate),
        signal,
        // mmo9.7.4: a welfare-escalated autonomous call declares
        // LLMWorkSpec.preemptionProtected; honoring it here (not a second policy)
        // stops the gate aborting the aged background job again.
        ...(preemptionProtected ? { preemptionProtected: true } : {}),
      }, execute);
    } catch (error) {
      // A gate preemption is a deliberate yield to higher-priority work, not a
      // transient provider failure. Stop candidate fallback so the preemption
      // propagates to the caller (a background handler defers the job); wrapping
      // in NonRecoverableFallbackError halts fallback while the runner rethrows
      // the unwrapped ModelCallPreemptedError.
      if (error instanceof ModelCallPreemptedError) {
        throw new NonRecoverableFallbackError(error);
      }
      throw error;
    }
  }

  /**
   * Per-endpoint admission capacity for the gate. Resolved from the provider
   * owner-file entry that owns this candidate's shared/local endpoint. Defaults
   * fail-closed to a single slot with no reservation, preserving the original
   * single-in-flight behavior for any unconfigured endpoint.
   */
  private resolveModelCallCapacity(candidate: RoutingCandidate): ModelCallGateCapacity {
    const routeKind = this.resolveRouteKind(candidate);
    const providerId = routeKind === 'configured_litellm_proxy'
      ? 'litellm'
      : candidate.provider.trim().toLowerCase();
    const entry = this.config.providerRegistry?.providers.find(
      provider => provider.id.trim().toLowerCase() === providerId,
    );
    return {
      capacity: entry?.capacity ?? 1,
      reservedForegroundSlots: entry?.reservedForegroundSlots ?? 0,
    };
  }

  private async evaluateBudgetPreflight(
    purpose: RoutingPurpose,
    candidate: RoutingCandidate,
    estimatedInputTokens: number,
    correlation: ResolvedCorrelationMetadata | undefined,
  ): Promise<void> {
    const service = this.resolveBudgetService(purpose, correlation);
    const process = this.resolveBudgetProcess(purpose, correlation);
    const preflight = await this.budgetController.evaluatePreflight({
      candidate,
      purpose,
      estimatedInputTokens,
      service,
      process,
      correlation,
    });
    if (preflight.allowed) return;
    if (preflight.accountingError) {
      log.error('Canonical model budget accounting query failed', {
        error: preflight.accountingError.message,
        provider: candidate.provider,
        model: candidate.model,
        purpose,
        ...toCorrelationLogFields(correlation, purpose),
      });
    }
    if (preflight.blockedEvent) {
      this.onBudgetBlocked?.(preflight.blockedEvent);
      const error = markErrorAsNonRetryable(new ModelBudgetExceededError(
        preflight.blockedEvent,
        preflight.accountingError,
      ));
      if (
        preflight.blockedEvent.reason === 'accounting_unavailable'
        || preflight.blockedEvent.reason === 'unknown_historical_cost'
      ) {
        throw new NonRecoverableFallbackError(error);
      }
      throw error;
    }
  }

  private async reserveIcpConversationCost(
    purpose: RoutingPurpose,
    candidate: RoutingCandidate,
    estimatedInputTokens: number,
    correlation: ResolvedCorrelationMetadata | undefined,
    logicalCallId: string,
    attempt: number,
    promptCacheEngaged: boolean,
  ): Promise<void> {
    try {
      await this.icpConversationCostBreaker.reservePhysicalAttempt({
        candidate,
        purpose,
        estimatedInputTokens,
        promptCacheEngaged,
        logicalCallId,
        attempt,
        correlation,
      });
    } catch (error) {
      if (error instanceof IcpConversationCostBreakerError) {
        throw new NonRecoverableFallbackError(error);
      }
      throw error;
    }
  }

  private createUsageLogicalCallId(
    callKind: 'chat' | 'completion',
    purpose: RoutingPurpose,
    correlation: ResolvedCorrelationMetadata | undefined,
  ): string {
    const requestCorrelation = correlation?.telemetryVisibility === 'companion_private'
      ? 'companion-private'
      : (correlation?.requestId ?? 'unknown');
    return [
      'llm',
      randomUUID(),
      callKind,
      purpose,
      requestCorrelation,
      correlation?.toolCallId ?? 'none',
    ].join(':');
  }

  private async recordUsage(
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
      logicalCallId: string;
      requestedProvider: string;
      requestedModel: string;
      status: 'success' | 'failure';
      settlement: 'complete' | 'partial' | 'unknown';
      stopReason?: string;
      error?: Error;
      providerObservability?: LLMProviderObservability;
      metadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    const companionPrivate = correlation?.telemetryVisibility === 'companion_private';
    const service = this.resolveBudgetService(purpose, correlation);
    const process = this.resolveBudgetProcess(purpose, correlation);
    const chargeSnapshot = getRunChargeSnapshot();
    const capturedProviderCost = this.providerCostResolver?.();
    const accountingRates = resolveModelUsageCostRates(this.config, candidate, purpose);
    const syntheticRoutedEndpointCost = candidate.requestBaseUrl !== undefined
      && usageDetails?.cost?.total === 0
      && [
        usageDetails.cost.input,
        usageDetails.cost.output,
        usageDetails.cost.cacheRead,
        usageDetails.cost.cacheWrite,
      ].every(value => value === undefined || value === 0)
      && accountingRates !== undefined
      && [
        accountingRates.inputPer1MUsd,
        accountingRates.outputPer1MUsd,
        accountingRates.cacheReadPer1MUsd,
        accountingRates.cacheWritePer1MUsd,
      ].some(value => value !== undefined && value > 0);
    const responseUsageEvidence = usageDetails?.cost && !syntheticRoutedEndpointCost
      ? { responseUsage: usageDetails.cost }
      : {};
    const providerCostReconciliation = mergeProviderCostEvidenceConflicts(
      reconcileProviderCostEvidence({
        ...responseUsageEvidence,
        ...(capturedProviderCost?.providerCostEvidence ?? {}),
      }, {
        input: usageDetails?.input ?? inputTokens,
        output: usageDetails?.output ?? outputTokens,
        cacheRead: usageDetails?.cacheRead ?? 0,
        cacheWrite: usageDetails?.cacheWrite ?? 0,
      }, combineProviderCostEvidenceObservations(
        { providerCostEvidence: responseUsageEvidence },
        {
          providerCostEvidence: capturedProviderCost?.providerCostEvidence ?? {},
          ...(capturedProviderCost?.providerCostEvidenceSummary
            ? { providerCostEvidenceSummary: capturedProviderCost.providerCostEvidenceSummary }
            : {}),
        },
      )),
      capturedProviderCost?.providerCostEvidenceConflict,
      usageDetails?.costEvidenceConflict,
    );
    const providerCost = providerCostReconciliation.providerCost;
    const accounting = reconcileModelUsageAccounting({
      usage: {
        inputTokens: usageDetails?.input ?? inputTokens,
        outputTokens: usageDetails?.output ?? outputTokens,
        cacheReadTokens: usageDetails?.cacheRead ?? 0,
        cacheWriteTokens: usageDetails?.cacheWrite ?? 0,
        ...(usageDetails?.totalTokens !== undefined
          ? { totalTokens: usageDetails.totalTokens }
          : {}),
      },
      ...(providerCost ? { providerCost } : {}),
      ...(accountingRates ? { estimatedRates: accountingRates } : {}),
    });
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
      ...(Object.keys(providerCostReconciliation.providerCostEvidence).length > 0
        ? { providerCostEvidence: providerCostReconciliation.providerCostEvidence }
        : {}),
      ...(providerCostReconciliation.providerCostEvidenceConflict
        ? { providerCostEvidenceConflict: providerCostReconciliation.providerCostEvidenceConflict }
        : {}),
      ...(providerCostReconciliation.providerCostEvidenceSummary
        ? { providerCostEvidenceSummary: providerCostReconciliation.providerCostEvidenceSummary }
        : {}),
      ...(providerCost ? { providerCost } : {}),
      ...(syntheticRoutedEndpointCost ? { syntheticRoutedEndpointCostIgnored: true } : {}),
      ...(correlation?.icpCorrelation
        ? {
            icpCost: {
              purpose: correlation.icpCorrelation.costPurpose,
              originStage: correlation.icpCorrelation.costOriginStage,
              fatigueDecision: correlation.icpCorrelation.fatigueDecision,
            },
          }
        : {}),
    };

    if (!this.usageRecorder) return;
    try {
      await this.usageRecorder.recordUsageEvent({
      logicalCallId: options.logicalCallId,
      attempt: options.attempt,
      recordedAtMs: options.completedAtMs,
      startedAtMs: options.startedAtMs,
      completedAtMs: options.completedAtMs,
      durationMs: Math.max(0, options.completedAtMs - options.startedAtMs),
      ...(options.ttftMs !== undefined ? { ttftMs: options.ttftMs } : {}),
      status: options.status,
      settlement: providerCostReconciliation.providerCostEvidenceConflict && options.settlement === 'complete'
        ? 'partial'
        : options.settlement,
      callKind,
      telemetryVisibility: companionPrivate ? 'companion_private' : 'operator_visible',
      attribution: {
        ...(correlation?.companionId
          ? { companionId: correlation.companionId }
          : (this.config.companionId ? { companionId: this.config.companionId } : {})),
        ...(correlation?.sessionId ? { sessionId: correlation.sessionId } : {}),
        // #49: companion_private work never persists re-identifying linkage.
        ...(!companionPrivate && correlation?.channelId ? { channelId: correlation.channelId } : {}),
        ...(correlation?.channelType ? { channelType: correlation.channelType } : {}),
        callType: correlation?.callType ?? (callKind === 'chat' ? 'chat' : 'background'),
        purpose,
        ...(correlation?.originType ? { originType: correlation.originType } : {}),
        ...(correlation?.originStage ? { originStage: correlation.originStage } : {}),
        service: correlation?.service ?? service,
        process: correlation?.process ?? process,
        ...(!companionPrivate && correlation?.turnId ? { turnId: correlation.turnId } : {}),
        ...(!companionPrivate && correlation?.requestId ? { requestId: correlation.requestId } : {}),
        ...(!companionPrivate && correlation?.toolName ? { toolName: correlation.toolName } : {}),
        ...(!companionPrivate && correlation?.toolCallId ? { toolCallId: correlation.toolCallId } : {}),
        ...(chargeSnapshot?.lane
          ? { chargeLane: chargeSnapshot.lane }
          : (correlation?.chargeLane ? { chargeLane: correlation.chargeLane } : {})),
        ...(chargeSnapshot?.surface
          ? { chargeSurface: chargeSnapshot.surface }
          : (correlation?.chargeSurface ? { chargeSurface: correlation.chargeSurface } : {})),
        ...(chargeSnapshot?.chargeEventId
          ? { chargeEventId: chargeSnapshot.chargeEventId }
          : (correlation?.chargeEventId ? { chargeEventId: correlation.chargeEventId } : {})),
        ...(chargeSnapshot?.lineage.runId
          ? { chargeRunId: chargeSnapshot.lineage.runId }
          : (correlation?.chargeRunId ? { chargeRunId: correlation.chargeRunId } : {})),
        ...(chargeSnapshot?.lineage.rootRunId
          ? { chargeRootRunId: chargeSnapshot.lineage.rootRunId }
          : (correlation?.chargeRootRunId ? { chargeRootRunId: correlation.chargeRootRunId } : {})),
        ...(chargeSnapshot?.lineage.parentRunId
          ? { chargeParentRunId: chargeSnapshot.lineage.parentRunId }
          : (correlation?.chargeParentRunId ? { chargeParentRunId: correlation.chargeParentRunId } : {})),
        ...(correlation?.shardId ? { shardId: correlation.shardId } : {}),
        ...(correlation?.subagentId ? { subagentId: correlation.subagentId } : {}),
        ...(correlation?.conversationId ? { conversationId: correlation.conversationId } : {}),
        ...(correlation?.rootInitiationId ? { rootInitiationId: correlation.rootInitiationId } : {}),
        ...(correlation?.workloadType ? { workloadType: correlation.workloadType } : {}),
        ...(correlation?.workloadId ? { workloadId: correlation.workloadId } : {}),
      },
      provider: candidate.provider,
      model: normalizeModelIdForProvider(candidate.provider, candidate.model),
      ...(candidate.slotKey ? { slotKey: candidate.slotKey } : {}),
      requestedProvider: options.requestedProvider,
      requestedModel: options.requestedModel,
      ...accounting.usage,
      providerCost: accounting.providerCost,
      estimatedCost: accounting.estimatedCost,
      effectiveCost: accounting.effectiveCost,
      ...(accounting.providerCost.total !== undefined
        ? { providerCostUsd: accounting.providerCost.total }
        : {}),
      ...(accounting.estimatedCost.total !== undefined
        ? { estimatedCostUsd: accounting.estimatedCost.total }
        : {}),
      ...(accounting.effectiveCost.total !== undefined
        ? { effectiveCostUsd: accounting.effectiveCost.total }
        : {}),
      costSource: accounting.costSource,
      ...(accounting.effectiveCost.currency ? { currency: accounting.effectiveCost.currency } : {}),
      ...(options.stopReason ? { stopReason: options.stopReason } : {}),
      ...(options.error
        ? { errorCode: options.error.name, errorMessage: options.error.message }
        : {}),
      metadata,
      });
    } catch (error) {
      log.warn('Failed to persist model usage event', {
        error: error instanceof Error ? error.message : String(error),
        provider: candidate.provider,
        model: candidate.model,
        purpose,
        ...correlation,
      });
      throw markErrorAsNonRetryable(new Error(
        `Failed to persist model usage event: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      ));
    }
  }

  async stream(context: LLMContext, callbacks?: StreamCallbacks, options?: LLMProviderStreamOptions): Promise<LLMResponse> {
    const piContext = this.buildPiContext(context);
    // mmo9.7.1 (+ mmo9.8 seam): honor an option-level work spec instead of
    // dropping option-level correlation and hardcoding purpose 'chat'. Absent a
    // spec (the interactive chat turn), streamPurpose/streamRoutingPurpose stay
    // 'chat' so this path is byte-identical to the prior behavior.
    const streamWorkSpec = options?.workSpec;
    const streamPurpose: CompletionPurpose = streamWorkSpec?.purpose ?? 'chat';
    const streamRoutingPurpose: RoutingPurpose = streamPurpose === 'chat'
      ? 'chat'
      : this.toRoutingPurpose(streamPurpose);
    const correlation = this.resolveCorrelation(
      context.correlation,
      streamWorkSpec?.correlation,
      streamPurpose,
    );
    if (streamWorkSpec) {
      this.validateWorkSpecForCall(streamPurpose, streamRoutingPurpose, streamWorkSpec, correlation);
    }
    const estimatedInputTokens = this.resolveEstimatedBudgetInputTokens(piContext, correlation);
    const accountingInputTokens = estimatedInputTokens ?? this.estimateBudgetInputTokens(piContext);
    const modelHint = mergeModelHints(context.modelHint, undefined);
    const externalAccounting = normalizeLLMCallAccountingContext(context.accounting);
    const logicalCallId = externalAccounting?.logicalCallId
      ?? this.createUsageLogicalCallId('chat', streamRoutingPurpose, correlation);
    let physicalAttempt = (externalAccounting?.attempt ?? 1) - 1;
    const streamRetryConfig = externalAccounting?.retryOwner === 'caller'
      ? { ...llmRetryConfig(this.config), maxRetries: 0 }
      : llmRetryConfig(this.config);
    let requestedProvider = modelHint?.provider;
    let requestedModel = modelHint?.model;

    try {
      const { result: finalResponse, candidate, attempts } = await this.runWithFallback(
        streamRoutingPurpose,
        async (candidateTarget, _attempt, preemptSignal) => {
          // mmo9.6.1 + mmo9.5.1: compose the caller/barge-in cancellation signal
          // (threaded in as `options.signal`) with the gate-owned preempt signal
          // so the in-flight streaming provider call is torn down by EITHER a
          // caller cancellation OR a foreground acquire preempting a background
          // stream. Mirrors the `complete` path's composition.
          const transportSignal = composeTransportSignal(options?.signal, preemptSignal);
          const transport = this.transport;
          if (transport) {
            physicalAttempt += 1;
            const transportContext = this.buildTransportContext(
              context,
              candidateTarget,
              correlation,
              {
                logicalCallId,
                attempt: physicalAttempt,
                retryOwner: 'caller',
              },
            );
            return await this.runTransportWithCircuitBreaker(
              'llm.stream',
              candidateTarget,
              async () => await transport.stream(transportContext, callbacks, { signal: transportSignal }),
            );
          }
          const { model, apiKey } = this.getModelAndKey(candidateTarget);
          const requestOptions = this.buildRequestOptions(candidateTarget, apiKey, {
            signal: transportSignal,
            correlation,
          });
          const promptCaching = applyModelAgnosticPromptCache({
            promptCacheEnabled: candidateTarget.promptCacheEnabled,
            promptCacheStrategy: candidateTarget.promptCacheStrategy,
            promptCacheRetention: candidateTarget.promptCacheRetention,
            promptCacheScope: candidateTarget.promptCacheScope,
            provider: candidateTarget.provider,
            modelId: candidateTarget.model,
            resolvedModelId: String(model.id),
            modelApi: typeof (model as { api?: unknown }).api === 'string'
              ? (model as { api: string }).api
              : undefined,
            systemPrompt: piContext.systemPrompt ?? '',
            boundaries: context.promptCacheBoundaries,
            correlation,
            requestOptions,
            onBoundaryMismatch: payload => {
              log.warn('Prompt cache boundaries did not match the serialized system prompt; skipping cache breakpoints', payload);
            },
          });
          const providerObservability = this.buildProviderObservability(
            candidateTarget,
            model,
            piContext,
            correlation,
            promptCaching ?? undefined,
          );

          return retryCompletionOnCorruptEmptyToolArgs<LLMResponse>({
            tools: context.tools,
            candidate: candidateTarget,
            correlation,
            purpose: streamRoutingPurpose,
            ...(externalAccounting?.retryOwner === 'caller' ? { maxRetries: 0 } : {}),
            extractToolCalls: (result) => result.toolCalls,
            onRetriesResolved: () => {},
            attempt: (attemptIndex) => withRetry(async () => {
            physicalAttempt += 1;
            const usageAttempt = physicalAttempt;
            const attemptStartedAtMs = Date.now();
            await this.reserveIcpConversationCost(
              streamRoutingPurpose,
              candidateTarget,
              accountingInputTokens,
              correlation,
              logicalCallId,
              usageAttempt,
              promptCaching?.engaged === true,
            );
            let attemptFirstTokenAtMs: number | undefined;
            const markFirstOutput = (kind: 'text' | 'thinking' | 'tool'): void => {
              if (attemptFirstTokenAtMs !== undefined) return;
              const timestampMs = Date.now();
              attemptFirstTokenAtMs = timestampMs;
              callbacks?.onFirstOutput?.({
                kind,
                monotonicAtMs: monotonicEpochNowMs(),
                timestampMs,
              });
            };
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
            let providerCompleted = false;
            let rawUsageEvidence: unknown;
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
                    if (event.delta.length > 0) markFirstOutput('text');
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
                    if (event.delta.length > 0) markFirstOutput('thinking');
                    emittedData = true;
                    reasoning += event.delta;
                    break;

                  case 'toolcall_start':
                    if (hasSubstantiveToolCallIdentity(event.partial, event.contentIndex)) {
                      markFirstOutput('tool');
                    }
                    break;

                  case 'toolcall_delta': {
                    const fragment = (event as { delta?: unknown }).delta;
                    const hasArgumentBytes = typeof fragment === 'string' && fragment.length > 0;
                    if (
                      hasArgumentBytes
                      || hasSubstantiveToolCallIdentity(event.partial, event.contentIndex)
                    ) {
                      markFirstOutput('tool');
                    }
                    if (hasArgumentBytes) {
                      toolArgumentFragmentBytes += fragment.length;
                    }
                    break;
                  }

                  case 'toolcall_end':
                    markFirstOutput('tool');
                    emittedData = true;
                    toolCalls.push({
                      id: event.toolCall.id,
                      name: event.toolCall.name,
                      input: event.toolCall.arguments,
                    });
                    callbacks?.onToolCall?.(event.toolCall.name, event.toolCall.arguments);
                    break;

                  case 'done': {
                    providerCompleted = true;
                    rawUsageEvidence = event.message.usage;
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
              const partialOutput = `${content}${reasoning}`;
              const partialUsage = emittedData && !providerCompleted
                ? normalizeLLMUsageDetails(
                    undefined,
                    accountingInputTokens,
                    Math.max(1, countMessageTokens([{ role: 'assistant', content: partialOutput }])),
                  )
                : undefined;
              await this.recordUsage(
                streamRoutingPurpose,
                'chat',
                candidateTarget,
                partialUsage?.input ?? 0,
                partialUsage?.output ?? 0,
                correlation,
                partialUsage,
                {
                  startedAtMs: attemptStartedAtMs,
                  completedAtMs: Date.now(),
                  ...(attemptFirstTokenAtMs !== undefined
                    ? { ttftMs: Math.max(0, attemptFirstTokenAtMs - attemptStartedAtMs) }
                    : {}),
                  attempt: usageAttempt,
                  logicalCallId,
                  requestedProvider: requestedProvider ?? candidateTarget.provider,
                  requestedModel: requestedModel ?? candidateTarget.model,
                  status: 'failure',
                  settlement: providerCompleted ? 'complete' : emittedData ? 'partial' : 'unknown',
                  error: err,
                  providerObservability,
                  metadata: {
                    emptyToolArgsAttempt: attemptIndex,
                    emptyArgsRetries: attemptIndex,
                    partialOutputChars: partialOutput.length,
                    ...(providerCompleted ? { malformedRawUsage: rawUsageEvidence } : {}),
                  },
                },
              );
              throw err;
            }

            if (response) {
              try {
                assertUsableProviderResponse(response, candidateTarget);
              } catch (error) {
                const err = error instanceof Error ? error : new Error(String(error));
                await this.recordUsage(
                  streamRoutingPurpose,
                  'chat',
                  candidateTarget,
                  response.inputTokens,
                  response.outputTokens,
                  correlation,
                  response.usageDetails,
                  {
                    startedAtMs: attemptStartedAtMs,
                    completedAtMs: Date.now(),
                    ...(attemptFirstTokenAtMs !== undefined
                      ? { ttftMs: Math.max(0, attemptFirstTokenAtMs - attemptStartedAtMs) }
                      : {}),
                    attempt: usageAttempt,
                    logicalCallId,
                    requestedProvider: requestedProvider ?? candidateTarget.provider,
                    requestedModel: requestedModel ?? candidateTarget.model,
                    status: 'failure',
                    settlement: 'complete',
                    error: err,
                    providerObservability,
                    metadata: {
                      emptyToolArgsAttempt: attemptIndex,
                      emptyArgsRetries: attemptIndex,
                    },
                  },
                );
                throw err;
              }
              logEmptyToolArgumentProvenance(
                response.toolCalls,
                toolArgumentFragmentBytes,
                candidateTarget,
                correlation,
                attemptIndex,
              );
              await this.recordUsage(
                streamRoutingPurpose,
                'chat',
                candidateTarget,
                response.inputTokens,
                response.outputTokens,
                correlation,
                response.usageDetails,
                {
                  startedAtMs: attemptStartedAtMs,
                  completedAtMs: Date.now(),
                  ...(attemptFirstTokenAtMs !== undefined
                    ? { ttftMs: Math.max(0, attemptFirstTokenAtMs - attemptStartedAtMs) }
                    : {}),
                  attempt: usageAttempt,
                  logicalCallId,
                  requestedProvider: requestedProvider ?? candidateTarget.provider,
                  requestedModel: requestedModel ?? candidateTarget.model,
                  status: 'success',
                  settlement: 'complete',
                  stopReason: response.stopReason,
                  providerObservability,
                  metadata: {
                    emptyToolArgsAttempt: attemptIndex,
                    emptyArgsRetries: attemptIndex,
                    toolCallCount: response.toolCalls.length,
                  },
                },
              );
              return response;
            }

            log.warn('Stream completed without done event', { model: String(model.id), hasContent: !!content });
            const incompleteUsage = normalizeLLMUsageDetails(
              undefined,
              accountingInputTokens,
              Math.max(1, countMessageTokens([{ role: 'assistant', content: `${content}${reasoning}` }])),
            );
            const incompleteResponse = {
              content,
              ...(reasoning ? { reasoning } : {}),
              providerObservability,
              toolCalls,
              model: String(model.id),
              inputTokens: incompleteUsage.input,
              outputTokens: incompleteUsage.output,
              usageDetails: incompleteUsage,
              stopReason: 'unknown',
            };
            assertUsableProviderResponse(incompleteResponse, candidateTarget);
            await this.recordUsage(
              streamRoutingPurpose,
              'chat',
              candidateTarget,
              incompleteUsage.input,
              incompleteUsage.output,
              correlation,
              incompleteUsage,
              {
                startedAtMs: attemptStartedAtMs,
                completedAtMs: Date.now(),
                ...(attemptFirstTokenAtMs !== undefined
                  ? { ttftMs: Math.max(0, attemptFirstTokenAtMs - attemptStartedAtMs) }
                  : {}),
                attempt: usageAttempt,
                logicalCallId,
                requestedProvider: requestedProvider ?? candidateTarget.provider,
                requestedModel: requestedModel ?? candidateTarget.model,
                status: 'success',
                settlement: 'partial',
                stopReason: 'unknown',
                providerObservability,
                metadata: {
                  emptyToolArgsAttempt: attemptIndex,
                  emptyArgsRetries: attemptIndex,
                  partialOutputChars: content.length + reasoning.length,
                },
              },
            );
            return incompleteResponse;
          }, streamRetryConfig, {
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
                purpose: streamPurpose,
              });
            },
          }),
          });
        },
        {
          modelHint,
          correlation,
          estimatedInputTokens,
          ...(streamWorkSpec?.maxOutputTokens !== undefined
            ? { outputTokenCap: streamWorkSpec.maxOutputTokens }
            : {}),
          ...(streamWorkSpec?.preemptionProtected
            ? { preemptionProtected: true }
            : {}),
          onCandidateSelected: candidate => {
            requestedProvider ??= candidate.provider;
            requestedModel ??= candidate.model;
          },
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
        purpose: streamPurpose,
      });

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
    const correlation = this.resolveCorrelation(context.correlation, options.correlation, purpose);
    if (options.workSpec) {
      this.validateWorkSpecForCall(purpose, routingPurpose, options.workSpec, correlation);
    }
    const estimatedInputTokens = this.resolveEstimatedBudgetInputTokens(piContext, correlation);
    const modelHint = mergeModelHints(context.modelHint, options.modelHint);
    const externalAccounting = normalizeLLMCallAccountingContext(context.accounting);
    const logicalCallId = externalAccounting?.logicalCallId
      ?? this.createUsageLogicalCallId('completion', routingPurpose, correlation);
    let physicalAttempt = (externalAccounting?.attempt ?? 1) - 1;
    let requestedProvider = modelHint?.provider;
    let requestedModel = modelHint?.model;

    const { result: response, candidate, attempts } = await this.runWithFallback(
      routingPurpose,
      async (candidateTarget, _attempt, preemptSignal) => {
        const transportSignal = composeTransportSignal(options.signal, preemptSignal);
        const transport = this.transport;
        if (transport) {
          physicalAttempt += 1;
          const transportContext = this.buildTransportContext(
            context,
            candidateTarget,
            correlation,
            {
              logicalCallId,
              attempt: physicalAttempt,
              retryOwner: 'caller',
            },
          );
          const executeTransport = async () => await transport.complete(transportContext, purpose, {
            signal: transportSignal,
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
          signal: transportSignal,
          correlation,
        });
        const promptCaching = applyModelAgnosticPromptCache({
          promptCacheEnabled: candidateTarget.promptCacheEnabled,
          promptCacheStrategy: candidateTarget.promptCacheStrategy,
          promptCacheRetention: candidateTarget.promptCacheRetention,
          promptCacheScope: candidateTarget.promptCacheScope,
          provider: candidateTarget.provider,
          modelId: candidateTarget.model,
          resolvedModelId: String(model.id),
          modelApi: typeof (model as { api?: unknown }).api === 'string'
            ? (model as { api: string }).api
            : undefined,
          systemPrompt: piContext.systemPrompt ?? '',
          boundaries: context.promptCacheBoundaries,
          correlation,
          requestOptions,
          onBoundaryMismatch: payload => {
            log.warn('Prompt cache boundaries did not match the serialized system prompt; skipping cache breakpoints', payload);
          },
        });
        const providerObservability = this.buildProviderObservability(
          candidateTarget,
          model,
          piContext,
          correlation,
          promptCaching ?? undefined,
        );

        const request = async (emptyArgsRetries: number) => {
          physicalAttempt += 1;
          const attempt = physicalAttempt;
          const attemptStartedAtMs = Date.now();
          await this.reserveIcpConversationCost(
            routingPurpose,
            candidateTarget,
            estimatedInputTokens ?? 0,
            correlation,
            logicalCallId,
            attempt,
            promptCaching?.engaged === true,
          );
          let response: Awaited<ReturnType<typeof completeSimple>>;
          try {
            response = await completeSimple(
              model,
              piContext,
              requestOptions,
            );
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            await this.recordUsage(
              routingPurpose,
              'completion',
              candidateTarget,
              0,
              0,
              correlation,
              undefined,
              {
                startedAtMs: attemptStartedAtMs,
                completedAtMs: Date.now(),
                attempt,
                logicalCallId,
                requestedProvider: requestedProvider ?? candidateTarget.provider,
                requestedModel: requestedModel ?? candidateTarget.model,
                status: 'failure',
                settlement: 'unknown',
                error: err,
                providerObservability,
                metadata: { completionPurpose: purpose, routingPurpose, emptyArgsRetries },
              },
            );
            if (isAbortError(err) || transportSignal.aborted) {
              markErrorAsNonRetryable(err);
            }
            throw err;
          }
          let usageDetails: LLMUsageDetails;
          try {
            const responseWithLegacyTokenCounts = response as typeof response & {
              inputTokens?: unknown;
              outputTokens?: unknown;
            };
            usageDetails = normalizeLLMUsageDetails(
              response.usage,
              typeof responseWithLegacyTokenCounts.inputTokens === 'number'
                ? responseWithLegacyTokenCounts.inputTokens
                : 0,
              typeof responseWithLegacyTokenCounts.outputTokens === 'number'
                ? responseWithLegacyTokenCounts.outputTokens
                : 0,
            );
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            await this.recordUsage(
              routingPurpose,
              'completion',
              candidateTarget,
              0,
              0,
              correlation,
              undefined,
              {
                startedAtMs: attemptStartedAtMs,
                completedAtMs: Date.now(),
                attempt,
                logicalCallId,
                requestedProvider: requestedProvider ?? candidateTarget.provider,
                requestedModel: requestedModel ?? candidateTarget.model,
                status: 'failure',
                settlement: 'complete',
                error: err,
                providerObservability,
                metadata: {
                  completionPurpose: purpose,
                  routingPurpose,
                  emptyArgsRetries,
                  malformedRawUsage: response.usage,
                },
              },
            );
            throw err;
          }
          try {
            assertUsableProviderResponse(response, candidateTarget);
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            await this.recordUsage(
              routingPurpose,
              'completion',
              candidateTarget,
              usageDetails.input,
              usageDetails.output,
              correlation,
              usageDetails,
              {
                startedAtMs: attemptStartedAtMs,
                completedAtMs: Date.now(),
                attempt,
                logicalCallId,
                requestedProvider: requestedProvider ?? candidateTarget.provider,
                requestedModel: requestedModel ?? candidateTarget.model,
                status: 'failure',
                settlement: 'complete',
                error: err,
                providerObservability,
                metadata: { completionPurpose: purpose, routingPurpose, emptyArgsRetries },
              },
            );
            throw err;
          }
          await this.recordUsage(
            routingPurpose,
            'completion',
            candidateTarget,
            usageDetails.input,
            usageDetails.output,
            correlation,
            usageDetails,
            {
              startedAtMs: attemptStartedAtMs,
              completedAtMs: Date.now(),
              attempt,
              logicalCallId,
              requestedProvider: requestedProvider ?? candidateTarget.provider,
              requestedModel: requestedModel ?? candidateTarget.model,
              status: 'success',
              settlement: 'complete',
              stopReason: response.stopReason,
              providerObservability,
              metadata: { completionPurpose: purpose, routingPurpose, emptyArgsRetries },
            },
          );
          return response;
        };

        if (options.disableRetry) {
          const response = await request(0);
          return {
            response,
            providerObservability,
          };
        }

        return retryCompletionOnCorruptEmptyToolArgs<{
          response: Awaited<ReturnType<typeof completeSimple>>;
          providerObservability: LLMProviderObservability;
        }>({
          tools: context.tools,
          candidate: candidateTarget,
          correlation,
          purpose,
          extractToolCalls: (result) => extractCompletionToolCalls(result.response),
          onRetriesResolved: () => {},
          attempt: (attemptIndex) => withRetry(async () => {
            const attemptResponse = await request(attemptIndex);
            logEmptyToolArgumentProvenance(
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
          ...(options.workSpec?.maxOutputTokens !== undefined
            ? { outputTokenCap: options.workSpec.maxOutputTokens }
            : {}),
          ...(options.workSpec?.preemptionProtected
            ? { preemptionProtected: true }
            : {}),
          onCandidateSelected: candidate => {
            requestedProvider ??= candidate.provider;
            requestedModel ??= candidate.model;
          },
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
    execute: (candidate: RoutingCandidate, attempt: number, preemptSignal: AbortSignal) => Promise<T>,
    options: {
      modelHint?: LLMCompletionModelHint;
      correlation?: ResolvedCorrelationMetadata;
      estimatedInputTokens?: number;
      signal?: AbortSignal;
      outputTokenCap?: number;
      preemptionProtected?: boolean;
      onCandidateSelected?: (candidate: RoutingCandidate) => void;
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
      const effectiveCandidate = this.applyWorkSpecOutputCap(
        this.applyPurposeOutputLimits(purpose, candidate),
        options.outputTokenCap,
      );
      options.onCandidateSelected?.(effectiveCandidate);
      await this.evaluateBudgetPreflight(
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
        preemptSignal => execute(effectiveCandidate, attempt, preemptSignal),
        options.signal,
        options.preemptionProtected,
      );
    }, options.correlation);
  }
}

function isAbortError(error: Error): boolean {
  return error.name === 'AbortError' || /aborted|abort|cancelled|canceled/i.test(error.message);
}

/**
 * Compose the caller signal (if any) with the gate-owned preempt signal into a
 * single transport signal, so a higher-priority acquire preempting this lane
 * aborts the in-flight transport call exactly like a caller abort. Both the
 * streaming and non-streaming paths use this so preemption reaches the provider
 * transport, not just the local promise.
 */
function composeTransportSignal(
  callerSignal: AbortSignal | undefined,
  preemptSignal: AbortSignal,
): AbortSignal {
  if (!callerSignal) return preemptSignal;
  return AbortSignal.any([callerSignal, preemptSignal]);
}

function shouldRetryWithinCandidate(error: Error): boolean {
  return classifyLLMError(error).category !== 'connection_unavailable';
}
