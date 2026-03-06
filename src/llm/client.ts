import {
  streamSimple,
  completeSimple,
  getEnvApiKey,
  type Context as PiContext,
  type Model,
  type SimpleStreamOptions,
} from '@mariozechner/pi-ai';
import type {
  CompletionPurpose,
  CorrelationMetadata,
  LLMContext,
  LLMResponse,
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

const log = createComponentLogger('LLMClient');

interface LLMRequestOptions extends SimpleStreamOptions {
  zdr?: boolean;
  provider?: { order: string[] };
}

export interface LLMCompletionModelHint {
  model?: string;
  provider?: string;
  maxTokens?: number;
}

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
  private fallbackRunner: FallbackRunner;
  private eligibilityGate?: EligibilityGate;
  private onEligibilityDecision?: (decision: EligibilityDecision) => void;

  constructor(
    config: SubstrateConfig,
    litellmBaseUrlOrOptions?: string | LLMClientRuntimeOptions,
  ) {
    const runtimeOptions = typeof litellmBaseUrlOrOptions === 'string'
      ? { litellmBaseUrl: litellmBaseUrlOrOptions }
      : (litellmBaseUrlOrOptions ?? {});
    this.config = config;
    this.litellmBaseUrl = runtimeOptions.litellmBaseUrl ?? process.env.LITELLM_BASE_URL ?? null;
    this.fallbackRunner = new FallbackRunner();
    this.eligibilityGate = runtimeOptions.eligibilityGate;
    this.onEligibilityDecision = runtimeOptions.onEligibilityDecision;
  }

  private getModelAndKey(candidate: RoutingCandidate): { model: Model<any>; apiKey: string | undefined } {
    const modelId = candidate.model;

    if (candidate.requestBaseUrl) {
      const apiKey = candidate.requestApiKeyEnv
        ? process.env[candidate.requestApiKeyEnv] ?? undefined
        : undefined;
      return {
        model: createModel(candidate.requestBaseUrl, modelId, candidate.maxTokens),
        apiKey,
      };
    }

    if (this.litellmBaseUrl) {
      return {
        model: createModel(this.litellmBaseUrl, modelId, candidate.maxTokens),
        apiKey: process.env.LITELLM_API_KEY ?? undefined,
      };
    }
    const model = resolveRegisteredModel(candidate.provider, modelId);
    if (!model) {
      throw new Error(`Unknown model "${modelId}" for provider "${candidate.provider}". Set LITELLM_BASE_URL or update the canonical model config in models.json`);
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
    const maxTokens = modelHint.maxTokens;
    if (!rawModel && (!Number.isFinite(maxTokens) || maxTokens === undefined || maxTokens <= 0)) {
      return null;
    }
    return {
      ...(rawModel ? { model: rawModel } : {}),
      ...(provider ? { provider } : {}),
      ...(Number.isFinite(maxTokens) && maxTokens !== undefined && maxTokens > 0
        ? { maxTokens: Math.floor(maxTokens) }
        : {}),
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
    const baseCandidate = fallbackCandidates[0];
    const hintedModel = modelHint.model?.trim();
    const qualified = hintedModel ? this.parseProviderQualifiedHint(hintedModel) : null;
    const catalog = this.config.modelCatalog ?? {};
    const fromSlot = hintedModel ? catalog[hintedModel] : undefined;
    const fromModelId = hintedModel
      ? Object.values(catalog).find(entry => entry.model === hintedModel)
      : undefined;
    const catalogMatch = fromSlot ?? fromModelId;

    let provider = modelHint.provider ?? qualified?.provider ?? catalogMatch?.provider ?? baseCandidate.provider;
    let model = qualified?.model ?? (catalogMatch?.model ?? hintedModel ?? baseCandidate.model);
    let maxTokens = modelHint.maxTokens
      ?? catalogMatch?.overrides?.maxTokens
      ?? catalogMatch?.defaults?.maxTokens
      ?? baseCandidate.maxTokens;
    const contextWindow = catalogMatch?.overrides?.contextWindow
      ?? catalogMatch?.defaults?.contextWindow
      ?? baseCandidate.contextWindow;

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
    };

    if (baseCandidate.provider === provider) {
      if (baseCandidate.requestBaseUrl) hinted.requestBaseUrl = baseCandidate.requestBaseUrl;
      if (baseCandidate.requestApiKeyEnv) hinted.requestApiKeyEnv = baseCandidate.requestApiKeyEnv;
      if (baseCandidate.openRouterZdrOnly) hinted.openRouterZdrOnly = true;
      if (baseCandidate.importRouteMode) hinted.importRouteMode = baseCandidate.importRouteMode;
    }

    return this.withOpenRouterPreferences(hinted);
  }

  private resolveCandidates(
    purpose: RoutingPurpose,
    modelHint: LLMCompletionModelHint | undefined,
  ): RoutingCandidate[] {
    const candidates = resolveRoutingCandidates(this.config, purpose);
    const normalizedHint = this.normalizeModelHint(modelHint);
    if (!normalizedHint) return candidates;

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

  async stream(context: LLMContext, callbacks?: StreamCallbacks): Promise<LLMResponse> {
    const piContext = this.buildPiContext(context);
    const correlation = this.resolveCorrelation(context.correlation, undefined, 'chat');

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
                purpose: 'chat',
                attempt,
                maxRetries,
                delayMs,
                error: error.message,
                ...correlation,
              });
            },
          });
        },
        { correlation },
      );

      log.info('LLM stream completed', {
        purpose: 'chat',
        model: candidate.model,
        provider: candidate.provider,
        attempts,
        ...correlation,
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
              purpose,
              routingPurpose,
              attempt,
              maxRetries,
              delayMs,
              error: error.message,
              ...correlation,
            });
          },
        });
      },
      { modelHint: options.modelHint, correlation },
    );

    log.info('LLM complete finished', {
      purpose,
      routingPurpose,
      model: candidate.model,
      provider: candidate.provider,
      attempts,
      requestedModelHint: options.modelHint?.model,
      ...correlation,
    });

    const content = extractTextContent(response.content as unknown[]);
    const reasoning = extractReasoningContent(response.content as unknown[]);

    return {
      content: normalizeContent(content),
      ...(reasoning ? { reasoning } : {}),
      toolCalls: [],
      model: response.model,
      inputTokens: response.usage.input,
      outputTokens: response.usage.output,
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
    if (purpose === 'context') {
      return 'context';
    }
    if (purpose === 'background') {
      return 'background';
    }
    return 'background';
  }

  private async runWithFallback<T>(
    purpose: RoutingPurpose,
    execute: (candidate: RoutingCandidate, attempt: number) => Promise<T>,
    options: { modelHint?: LLMCompletionModelHint; correlation?: ResolvedCorrelationMetadata } = {},
  ): Promise<{ result: T; candidate: RoutingCandidate; attempts: number }> {
    if (this.eligibilityGate) {
      const decision = this.eligibilityGate.evaluate({
        kind: 'llm.purpose',
        purpose,
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
      this.enforceImportRoutingPolicy(purpose, candidate);
      return execute(candidate, attempt);
    }, options.correlation);
  }
}

function isAbortError(error: Error): boolean {
  return error.name === 'AbortError' || /aborted|abort|cancelled|canceled/i.test(error.message);
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
