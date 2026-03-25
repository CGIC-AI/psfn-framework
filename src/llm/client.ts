import {
  streamSimple,
  completeSimple,
  getEnvApiKey,
  type Context as PiContext,
  type Model,
  type SimpleStreamOptions,
  type ThinkingLevel,
} from '@mariozechner/pi-ai';
import type {
  CompletionPurpose,
  CorrelationMetadata,
  LLMContext,
  LLMModelHint,
  LLMResponse,
  ModelBudgetBlockedEvent,
  StreamCallbacks,
  SubstrateConfig,
  ToolCall,
} from '../types.js';
import { createModel } from './models.js';
import { withRetry, markErrorAsNonRetryable } from './retry.js';
import { llmRetryConfig } from './retry-config.js';
import {
  extractReasoningContent,
  extractTextContent,
  toPiTools,
} from './conversion.js';
import { contextMessagesToPiMessages } from './message-conversion.js';
import { createComponentLogger } from '../logger.js';
import { FallbackRunner } from './fallback.js';
import type { ImportPolicyAuditRecord, RoutingCandidate, RoutingPurpose } from './routing.js';
import { evaluateImportPolicy, resolveRoutingCandidates } from './routing.js';
import { resolveRegisteredModel } from './models.js';
import {
  EligibilityDeniedError,
  type EligibilityDecision,
  type EligibilityGate,
} from '../capabilities/eligibility.js';
import {
  type ResolvedCorrelationMetadata,
  inferCallType as inferCorrelationCallType,
  resolveCorrelationMetadata,
} from './correlation.js';
import { ModelBudgetController, ModelBudgetExceededError } from './model-budget.js';
import {
  resolveConfiguredLiteLLMApiKeyEnv,
  resolveConfiguredLiteLLMBaseUrl,
} from '../config/providers-config.js';

const log = createComponentLogger('LLMClient');

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
  eligibilityGate?: EligibilityGate;
  onEligibilityDecision?: (decision: EligibilityDecision) => void;
  onBudgetBlocked?: (event: ModelBudgetBlockedEvent) => void;
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
  private litellmApiKeyEnv: string;
  private fallbackRunner: FallbackRunner;
  private budgetController: ModelBudgetController;
  private eligibilityGate?: EligibilityGate;
  private onEligibilityDecision?: (decision: EligibilityDecision) => void;
  private onBudgetBlocked?: (event: ModelBudgetBlockedEvent) => void;

  constructor(
    config: SubstrateConfig,
    litellmBaseUrlOrOptions?: string | LLMClientRuntimeOptions,
  ) {
    const runtimeOptions = typeof litellmBaseUrlOrOptions === 'string'
      ? { litellmBaseUrl: litellmBaseUrlOrOptions }
      : (litellmBaseUrlOrOptions ?? {});
    this.config = config;
    this.litellmBaseUrl = runtimeOptions.litellmBaseUrl ?? resolveConfiguredLiteLLMBaseUrl(config);
    this.litellmApiKeyEnv = resolveConfiguredLiteLLMApiKeyEnv(config);
    this.fallbackRunner = new FallbackRunner();
    this.budgetController = new ModelBudgetController(config);
    this.eligibilityGate = runtimeOptions.eligibilityGate;
    this.onEligibilityDecision = runtimeOptions.onEligibilityDecision;
    this.onBudgetBlocked = runtimeOptions.onBudgetBlocked;
  }

  private getModelAndKey(candidate: RoutingCandidate): { model: Model<any>; apiKey: string | undefined } {
    const modelId = candidate.model;

    if (candidate.requestBaseUrl) {
      const apiKey = candidate.requestApiKeyEnv
        ? process.env[candidate.requestApiKeyEnv] ?? undefined
        : undefined;
      return {
        model: createModel(candidate.requestBaseUrl, modelId, candidate.maxTokens, candidate.contextWindow),
        apiKey,
      };
    }

    if (this.litellmBaseUrl) {
      return {
        model: createModel(this.litellmBaseUrl, modelId, candidate.maxTokens, candidate.contextWindow),
        apiKey: process.env[this.litellmApiKeyEnv] ?? undefined,
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
      apiKey: getEnvApiKey(candidate.provider) ?? undefined,
    };
  }

  private buildRequestOptions(
    candidate: RoutingCandidate,
    apiKey: string | undefined,
    extra: { signal?: AbortSignal } = {},
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
    if (
      !rawModel
      && !provider
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
      String(candidate.thinkingEnabled ?? ''),
      candidate.thinkingEffort ?? '',
      String(candidate.temperature ?? ''),
      String(candidate.topP ?? ''),
      String(candidate.topK ?? ''),
      String(candidate.frequencyPenalty ?? ''),
      String(candidate.repetitionPenalty ?? ''),
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
    let maxTokens = modelHint.maxTokens ?? baseCandidate.maxTokens;
    const contextWindow = modelHint.contextWindow ?? baseCandidate.contextWindow;
    const thinkingEnabled = modelHint.thinkingEnabled ?? baseCandidate.thinkingEnabled;
    const thinkingEffort = modelHint.thinkingEffort ?? baseCandidate.thinkingEffort;
    const temperature = modelHint.temperature ?? baseCandidate.temperature;
    const topP = modelHint.topP ?? baseCandidate.topP;
    const topK = modelHint.topK ?? baseCandidate.topK;
    const frequencyPenalty = modelHint.frequencyPenalty ?? baseCandidate.frequencyPenalty;
    const repetitionPenalty = modelHint.repetitionPenalty ?? baseCandidate.repetitionPenalty;

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
      if (baseCandidate.openRouterZdrOnly) hinted.openRouterZdrOnly = true;
      if (baseCandidate.importRouteMode) hinted.importRouteMode = baseCandidate.importRouteMode;
    }

    return this.withOpenRouterPreferences(hinted);
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
      routedModel: hintedCandidate.model,
      routedProvider: hintedCandidate.provider,
    });

    return this.dedupeCandidates([hintedCandidate, ...candidates]);
  }

  private buildPiContext(context: LLMContext): PiContext {
    return {
      systemPrompt: context.systemPrompt,
      messages: contextMessagesToPiMessages(context.messages),
      ...(context.tools?.length ? { tools: toPiTools(context.tools) } : {}),
    };
  }

  private estimateContextInputTokens(context: PiContext): number {
    const collectChars = (value: unknown): number => {
      if (typeof value === 'string') return value.length;
      if (Array.isArray(value)) return value.reduce((sum, entry) => sum + collectChars(entry), 0);
      if (value && typeof value === 'object') {
        return Object.values(value).reduce((sum, entry) => sum + collectChars(entry), 0);
      }
      return 0;
    };
    const charCount = collectChars(context.systemPrompt) + collectChars(context.messages);
    return Math.max(1, Math.ceil(charCount / 4));
  }

  private resolveBudgetService(purpose: RoutingPurpose, correlation: ResolvedCorrelationMetadata | undefined): string {
    if (correlation?.callType) return correlation.callType;
    if (purpose === 'chat') return 'chat';
    return 'background';
  }

  private resolveBudgetProcess(purpose: RoutingPurpose, correlation: ResolvedCorrelationMetadata | undefined): string {
    return correlation?.originStage ?? correlation?.purpose ?? purpose;
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

  private recordUsage(
    purpose: RoutingPurpose,
    candidate: RoutingCandidate,
    inputTokens: number,
    outputTokens: number,
    correlation: ResolvedCorrelationMetadata | undefined,
  ): void {
    this.budgetController.recordUsage({
      candidate,
      purpose,
      service: this.resolveBudgetService(purpose, correlation),
      process: this.resolveBudgetProcess(purpose, correlation),
      inputTokens,
      outputTokens,
      correlation,
    });
  }

  async stream(context: LLMContext, callbacks?: StreamCallbacks): Promise<LLMResponse> {
    const piContext = this.buildPiContext(context);
    const estimatedInputTokens = this.estimateContextInputTokens(piContext);
    const correlation = this.resolveCorrelation(context.correlation, undefined, 'chat');
    const modelHint = this.mergeModelHints(context.modelHint, undefined);

    try {
      const { result: finalResponse, candidate, attempts } = await this.runWithFallback(
        'chat',
        async (candidateTarget) => {
          const { model, apiKey } = this.getModelAndKey(candidateTarget);
          const requestOptions = this.buildRequestOptions(candidateTarget, apiKey);

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

            try {
              for await (const event of eventStream) {
                switch (event.type) {
                  case 'text_delta':
                    emittedData = true;
                    content += event.delta;
                    callbacks?.onText?.(event.delta);
                    break;

                  case 'thinking_delta':
                    emittedData = true;
                    reasoning += event.delta;
                    break;

                  case 'toolcall_end':
                    emittedData = true;
                    toolCalls.push({
                      id: event.toolCall.id,
                      name: event.toolCall.name,
                      input: event.toolCall.arguments,
                    });
                    callbacks?.onToolCall?.(event.toolCall.name, event.toolCall.arguments);
                    break;

                  case 'done': {
                    // If text_delta events didn't fire, extract text from content blocks
                    if (!content) {
                      content = extractTextContent(event.message.content as unknown[]);
                    }
                    // Extract reasoning from content blocks if thinking_delta didn't fire
                    if (!reasoning) {
                      reasoning = extractReasoningContent(event.message.content as unknown[]);
                    }
                    // Normalize away stringified content block arrays from streaming
                    content = normalizeContent(content);
                    response = {
                      content,
                      ...(reasoning ? { reasoning } : {}),
                      toolCalls,
                      model: event.message.model,
                      inputTokens: event.message.usage.input,
                      outputTokens: event.message.usage.output,
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
              return response;
            }

            log.warn('Stream completed without done event', { model: String(model.id), hasContent: !!content });
            return {
              content,
              ...(reasoning ? { reasoning } : {}),
              toolCalls,
              model: String(model.id),
              inputTokens: 0,
              outputTokens: 0,
              stopReason: 'unknown',
            };
          }, llmRetryConfig(this.config), {
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
        attempts,
        ...correlation,
        purpose: 'chat',
      });

      this.recordUsage(
        'chat',
        candidate,
        finalResponse.inputTokens,
        finalResponse.outputTokens,
        correlation,
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
    const estimatedInputTokens = this.estimateContextInputTokens(piContext);
    const correlation = this.resolveCorrelation(context.correlation, options.correlation, purpose);
    const modelHint = this.mergeModelHints(context.modelHint, options.modelHint);

    const { result: response, candidate, attempts } = await this.runWithFallback(
      routingPurpose,
      async (candidateTarget) => {
        const { model, apiKey } = this.getModelAndKey(candidateTarget);
        const requestOptions = this.buildRequestOptions(candidateTarget, apiKey, {
          signal: options.signal,
        });

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
          return request();
        }

        return withRetry(request, llmRetryConfig(this.config), {
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
      },
      {
        modelHint,
        correlation,
        estimatedInputTokens,
      },
    );

    log.info('LLM complete finished', {
      model: candidate.model,
      provider: candidate.provider,
      attempts,
      requestedModelHint: modelHint?.model,
      ...correlation,
      purpose,
      routingPurpose,
    });

    const content = extractTextContent(response.content as unknown[]);
    const reasoning = extractReasoningContent(response.content as unknown[]);
    const inputTokens = response.usage.input;
    const outputTokens = response.usage.output;

    this.recordUsage(
      routingPurpose,
      candidate,
      inputTokens,
      outputTokens,
      correlation,
    );

    return {
      content: normalizeContent(content),
      ...(reasoning ? { reasoning } : {}),
      toolCalls: [],
      model: response.model,
      inputTokens,
      outputTokens,
      stopReason: response.stopReason,
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
      this.evaluateBudgetPreflight(
        purpose,
        candidate,
        options.estimatedInputTokens ?? 0,
        options.correlation,
      );
      this.enforceImportRoutingPolicy(purpose, candidate);
      return execute(candidate, attempt);
    }, options.correlation);
  }
}

function isAbortError(error: Error): boolean {
  return error.name === 'AbortError' || /aborted|abort|cancelled|canceled/i.test(error.message);
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
