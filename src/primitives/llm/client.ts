import type { Context as PiContext } from '@mariozechner/pi-ai';
import { randomUUID } from 'node:crypto';
import type { ProviderRuntime } from './provider-runtime.js';
import { PiProviderRuntime } from './provider-runtime.js';
import type {
  CompletionPurpose,
  CorrelationMetadata,
  LLMContext,
  LLMUsageDetails,
  LLMProviderObservability,
  LLMResponse,
  LLMWorkSpec,
  ModelBudgetBlockedEvent,
  StreamCallbacks,
  ToolCall,
} from '../../shared/contracts/runtime.js';
import type { LLMCompletionModelHint } from './model-hint-routing.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { withRetry, markErrorAsNonRetryable, isRetryableError } from './retry.js';
import { llmRetryConfig } from './retry-config.js';
import {
  extractReasoningContent,
  extractTextContent,
} from './conversion.js';
import { createComponentLogger } from '../../shared/logger.js';
import { abortError } from '../../shared/utils/errors.js';
import { FallbackRunner, NonRecoverableFallbackError } from './fallback.js';
import type { ImportPolicyAuditRecord, RoutingCandidate, RoutingPurpose } from './routing.js';
import {
  evaluateImportPolicy,
  toCompletionRoutingPurpose,
} from './routing.js';
import { applyModelAgnosticPromptCache } from './client-prompt-cache.js';
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
  resolveConfiguredLiteLLMApiKeyReference,
  resolveConfiguredLiteLLMBaseUrl,
} from '../../system/config/providers-config.js';
import type { LLMProviderPort, LLMProviderStreamOptions } from '../../core/agent/contracts.js';
import {
  FOREGROUND_CHAT_RUNTIME_CLASS,
  resolveRuntimeLaneClassForModelCall,
} from '../../core/agent/worker-lanes.js';
import { ModelCallGate, ModelCallPreemptedError, type ModelCallGateCapacity } from './model-call-gate.js';
import { clampVisionCompletionMaxTokens } from './vision-limits.js';
import type {
  IcpConversationCostAccountingPort,
  IcpConversationCostBreakerEvent,
  ModelUsageBudgetQueryPort,
  ModelUsageRecorder,
} from '../../shared/telemetry/model-usage.js';
import { resolveModelUsageChargeLane } from '../../shared/telemetry/model-usage-attribution.js';
import { reconcileModelUsageAccounting } from '../../shared/telemetry/model-usage-accounting.js';
import { getRunChargeSnapshot } from '../../shared/telemetry/run-charge.js';
import {
  type CircuitBreakerTransition,
  SlidingWindowCircuitBreaker,
} from '../../shared/resilience/circuit-breaker.js';
import { classifyLLMError } from './error-classify.js';
import {
  assertUsableProviderResponse,
  extractCompletionToolCalls,
  normalizeContent,
  normalizeLLMUsageDetails,
  normalizeSharedRouteKey,
  stripProviderResponseTerminatorArtifact,
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
  type IcpConversationChargePolicyResolver,
} from './icp-conversation-cost-breaker.js';
import { LLMRequestCapability } from './client-request-capability.js';
import {
  runLLMStreamAttempt,
  type StreamUsageRecord,
} from './client-stream-capability.js';

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

export type { LLMCompletionModelHint } from './model-hint-routing.js';

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
  /**
   * an52.3: server-injected authenticated companion identity for per-companion
   * eligibility (gateway RPC layer only). Never sourced from caller params or
   * correlation — correlation.companionId is agent-controlled and stripped for
   * companion_private telemetry.
   */
  eligibilityCompanionId?: string;
}

export interface LLMClientRuntimeOptions {
  litellmBaseUrl?: string;
  transport?: LLMProviderPort;
  runtime?: ProviderRuntime;
  eligibilityGate?: EligibilityGate;
  onEligibilityDecision?: (decision: EligibilityDecision) => void;
  onBudgetBlocked?: (event: ModelBudgetBlockedEvent) => void;
  usageRecorder?: ModelUsageRecorder;
  usageBudgetQuery?: ModelUsageBudgetQueryPort;
  icpConversationCostAccounting?: IcpConversationCostAccountingPort;
  onIcpConversationCostDecision?: (event: IcpConversationCostBreakerEvent) => void;
  icpConversationChargePolicyResolver?: IcpConversationChargePolicyResolver;
  providerCostResolver?: () => ReconciledProviderCostEvidence | undefined;
  circuitBreaker?: SlidingWindowCircuitBreaker;
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
  private requestCapability: LLMRequestCapability;
  private fallbackRunner: FallbackRunner;
  private budgetController: ModelBudgetController;
  private transport?: LLMProviderPort;
  private runtime: ProviderRuntime;
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
    this.transport = runtimeOptions.transport;
    this.runtime = runtimeOptions.runtime ?? new PiProviderRuntime();
    this.requestCapability = new LLMRequestCapability(
      config,
      this.litellmBaseUrl,
      resolveConfiguredLiteLLMApiKeyReference(config),
      this.runtime,
    );
    this.fallbackRunner = new FallbackRunner();
    this.budgetController = new ModelBudgetController(config, runtimeOptions.usageBudgetQuery);
    this.eligibilityGate = runtimeOptions.eligibilityGate;
    this.onEligibilityDecision = runtimeOptions.onEligibilityDecision;
    this.onBudgetBlocked = runtimeOptions.onBudgetBlocked;
    this.usageRecorder = runtimeOptions.usageRecorder;
    this.icpConversationCostBreaker = new IcpConversationCostBreaker(
      config,
      runtimeOptions.icpConversationCostAccounting,
      runtimeOptions.onIcpConversationCostDecision,
      runtimeOptions.icpConversationChargePolicyResolver,
    );
    this.providerCostResolver = runtimeOptions.providerCostResolver;
    this.modelCallGate = new ModelCallGate();
    this.circuitBreaker = runtimeOptions.circuitBreaker ?? new SlidingWindowCircuitBreaker({
      failureThreshold: LLM_CIRCUIT_BREAKER_FAILURE_THRESHOLD,
      windowMs: LLM_CIRCUIT_BREAKER_WINDOW_MS,
      cooldownMs: LLM_CIRCUIT_BREAKER_COOLDOWN_MS,
    });
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
   * mmo9.7.3: fail closed for autonomous spend. An autonomous call is a declared
   * `LLMWorkSpec` call (the sanctioned `completeWithWorkSpec` entry every
   * non-chat model call in src/core and src/faculties routes through) whose
   * gate-resolved lane is non-interactive (anything other than foreground chat).
   * Such spend MUST be accountable, so a missing `usageRecorder` is a hard,
   * non-retryable error rather than silently unattributed spend. Interactive
   * (foreground_chat) work and legacy non-work-spec calls keep their prior
   * behavior. This runs BEFORE any provider I/O so an unaccountable autonomous
   * call never spends.
   */
  private assertAutonomousCallAccountable(
    purpose: RoutingPurpose,
    correlation: ResolvedCorrelationMetadata | undefined,
    hasWorkSpec: boolean,
  ): void {
    if (this.usageRecorder || !hasWorkSpec) return;
    const runtimeLaneClass = this.resolveModelCallRuntimeClass(purpose, correlation);
    if (runtimeLaneClass === FOREGROUND_CHAT_RUNTIME_CLASS) return;
    throw markErrorAsNonRetryable(new Error(
      `Autonomous model call (runtime lane "${runtimeLaneClass}", purpose "${purpose}") has no `
      + 'usageRecorder configured: refusing to run unaccounted autonomous spend',
    ));
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
    const routeKind = this.requestCapability.resolveRouteKind(candidate);
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
    const routeKind = this.requestCapability.resolveRouteKind(candidate);
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
        ...toCorrelationLogFields(correlation),
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
    // mmo9.7.3: attribute the SINGLE gate-resolved runtime lane class for this
    // call (no second lane resolver). This is the per-lane spend dimension and is
    // always available, even for autonomous calls with no run-charge snapshot.
    const runtimeLaneClass = this.resolveModelCallRuntimeClass(purpose, correlation);
    const chargeSnapshot = getRunChargeSnapshot();
    const chargeLane = resolveModelUsageChargeLane({
      ...(chargeSnapshot?.lane
        ? { explicitChargeLane: chargeSnapshot.lane }
        : (correlation?.chargeLane ? { explicitChargeLane: correlation.chargeLane } : {})),
      callType: correlation?.callType ?? (callKind === 'chat' ? 'chat' : 'background'),
      runtimeLaneClass,
      ...(correlation?.sessionId ? { sessionId: correlation.sessionId } : {}),
      ...(correlation?.channelId ? { channelId: correlation.channelId } : {}),
    });
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
        runtimeLaneClass,
        ...(chargeLane ? { chargeLane } : {}),
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
    const piContext = this.requestCapability.buildPiContext(context);
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
    this.assertAutonomousCallAccountable(streamRoutingPurpose, correlation, Boolean(streamWorkSpec));
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
            const transportContext = this.requestCapability.buildTransportContext(
              context,
              candidateTarget,
              correlation,
              {
                logicalCallId,
                attempt: physicalAttempt,
                retryOwner: 'caller',
              },
            );
            const response = await this.runTransportWithCircuitBreaker(
              'llm.stream',
              candidateTarget,
              async () => await transport.stream(transportContext, callbacks, { signal: transportSignal }),
            );
            throwIfTransportAborted(transportSignal);
            return response;
          }
          const { model, apiKey } = this.requestCapability.getModelAndKey(candidateTarget);
          const requestOptions = this.requestCapability.buildRequestOptions(candidateTarget, apiKey, {
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
          const providerObservability = this.requestCapability.buildProviderObservability(
            candidateTarget,
            model,
            piContext,
            correlation,
            promptCaching ?? undefined,
          );
          this.requestCapability.attachWirePayloadCapture(
            requestOptions,
            providerObservability,
            model,
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
            return runLLMStreamAttempt({
              runtime: this.runtime,
              model,
              context: piContext,
              requestOptions,
              candidate: candidateTarget,
              callbacks,
              accountingInputTokens,
              transportSignal,
              attemptIndex,
              usageAttempt,
              logicalCallId,
              requestedProvider: requestedProvider ?? candidateTarget.provider,
              requestedModel: requestedModel ?? candidateTarget.model,
              providerObservability,
              correlation,
              reserveCost: async () => await this.reserveIcpConversationCost(
                streamRoutingPurpose,
                candidateTarget,
                accountingInputTokens,
                correlation,
                logicalCallId,
                usageAttempt,
                promptCaching?.engaged === true,
              ),
              recordUsage: async (record: StreamUsageRecord) => await this.recordUsage(
                streamRoutingPurpose,
                'chat',
                candidateTarget,
                record.inputTokens,
                record.outputTokens,
                correlation,
                record.usageDetails,
                record.options,
              ),
              throwIfAborted: () => throwIfTransportAborted(transportSignal),
            });
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
          signal: options?.signal,
          ...(options?.eligibilityCompanionId
            ? { eligibilityCompanionId: options.eligibilityCompanionId }
            : {}),
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
    const piContext = this.requestCapability.buildPiContext(context);
    const correlation = this.resolveCorrelation(context.correlation, options.correlation, purpose);
    if (options.workSpec) {
      this.validateWorkSpecForCall(purpose, routingPurpose, options.workSpec, correlation);
    }
    this.assertAutonomousCallAccountable(routingPurpose, correlation, Boolean(options.workSpec));
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
          const transportContext = this.requestCapability.buildTransportContext(
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
          throwIfTransportAborted(transportSignal);
          assertUsableProviderResponse(response, candidateTarget);
          return response;
        }
        const { model, apiKey } = this.requestCapability.getModelAndKey(candidateTarget);
        const requestOptions = this.requestCapability.buildRequestOptions(candidateTarget, apiKey, {
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
        const providerObservability = this.requestCapability.buildProviderObservability(
          candidateTarget,
          model,
          piContext,
          correlation,
          promptCaching ?? undefined,
        );
        this.requestCapability.attachWirePayloadCapture(
          requestOptions,
          providerObservability,
          model,
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
          let response: Awaited<ReturnType<ProviderRuntime['complete']>>;
          try {
            response = await this.runtime.complete(
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
          // i24ax: do NOT discard a resolved-under-abort provider result. The
          // provider already produced (and billed) tokens, so the usage event
          // must be recorded and the ICP reservation settled BEFORE we surface
          // the abort — otherwise the spend is lost to the budget SUM and the
          // pre-taken reservation strands pending forever (no sweeper).
          const cancelledAfterCompletion = transportSignal.aborted;
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
              metadata: {
                completionPurpose: purpose,
                routingPurpose,
                emptyArgsRetries,
                ...(cancelledAfterCompletion ? { cancelledAfterCompletion: true } : {}),
              },
            },
          );
          // i24ax: usage now durably recorded and the reservation settled; surface
          // the cancellation to the caller exactly as the pre-fix code did.
          throwIfTransportAborted(transportSignal);
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
          response: Awaited<ReturnType<ProviderRuntime['complete']>>;
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
          ...(options.eligibilityCompanionId
            ? { eligibilityCompanionId: options.eligibilityCompanionId }
            : {}),
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
    const visibleContent = stripProviderResponseTerminatorArtifact(
      normalizeContent(content),
      candidate,
    );

    return {
      content: visibleContent,
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
    // 23pp: single shared mapping — the agent-side gateway client resolves
    // per-companion model selection against the same lane this router serves.
    return toCompletionRoutingPurpose(purpose);
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
      eligibilityCompanionId?: string;
    } = {},
  ): Promise<{ result: T; candidate: RoutingCandidate; attempts: number }> {
    if (this.eligibilityGate) {
      // an52.3: gate the purpose against the *authenticated* companion's tier,
      // keyed on the server-injected eligibilityCompanionId — never on
      // correlation.companionId, which is agent-controlled, omittable, and
      // stripped for companion_private telemetry. A multi-companion gateway
      // pairs this with a strict access provider that throws when the identity
      // is absent (fail closed); embedded clients use companion-less gates.
      const decision = this.eligibilityGate.evaluate({
        kind: 'llm.purpose',
        purpose: this.toEligibilityPurpose(purpose),
      }, undefined, options.eligibilityCompanionId);
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
      throwIfFallbackAborted(options.signal);
      try {
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
        const result = await this.runWithModelCallGate(
          purpose,
          effectiveCandidate,
          options.correlation,
          preemptSignal => execute(effectiveCandidate, attempt, preemptSignal),
          options.signal,
          options.preemptionProtected,
        );
        throwIfFallbackAborted(options.signal);
        return result;
      } catch (error) {
        throwIfFallbackAborted(options.signal);
        throw error;
      }
    }, options.correlation);
  }
}

function isAbortError(error: Error): boolean {
  return error.name === 'AbortError' || /aborted|abort|cancelled|canceled/i.test(error.message);
}

function throwIfTransportAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw markErrorAsNonRetryable(
    abortError(signal.reason, 'LLM provider request aborted'),
  );
}

function throwIfFallbackAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw new NonRecoverableFallbackError(
    abortError(signal.reason, 'LLM request aborted before fallback'),
  );
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
