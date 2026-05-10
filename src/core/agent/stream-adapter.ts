// ── pi-agent-core Stream Adapter ──
// Bridges our model-routing configuration into pi-agent-core's StreamFn interface.
// Core always uses an injected transport port so provider credentials remain outside
// the core runtime boundary.

import type { AssistantMessage, AssistantMessageEvent, Model, ThinkingLevel } from '@mariozechner/pi-ai';
import type { StreamFn } from '@mariozechner/pi-agent-core';
import type { LLMContext, LLMResponse, ModelBudgetBlockedEvent, MessageModelOverride, ModelPurpose, CorrelationMetadata, StreamCallbacks, ToolCall } from '../../shared/contracts/runtime.js';
import type { CoreSubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { createModel, resolveRegisteredModel } from '../../primitives/llm/models.js';
import { resolveRoutingCandidates, type RoutingCandidate, type RoutingPurpose } from '../../primitives/llm/routing.js';
import {
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_RETRIES,
  isRetryableError,
} from '../../primitives/llm/retry.js';
import { llmRetryConfig } from '../../primitives/llm/retry-config.js';
import { createComponentLogger } from '../../shared/logger.js';
import { getRequestContext } from '../../primitives/llm/request-context.js';
import { toCorrelationLogFields } from '../../primitives/llm/correlation.js';
import {
  FallbackRunner,
  NonRecoverableFallbackError,
} from '../../primitives/llm/fallback.js';
import {
  findRegistryEntryByModelId,
  findRegistryEntryByProviderModel,
  ModelBudgetController,
  ModelBudgetExceededError,
  normalizeModelIdForProvider,
} from '../../primitives/llm/model-budget.js';
import {
  resolveConfiguredLiteLLMBaseUrl,
} from '../../system/config/providers-config.js';
import { countMessageTokens } from '../../primitives/llm/tokens.js';

const log = createComponentLogger('StreamAdapter');
const FULL_KNOB_PASSTHROUGH_PROVIDERS = new Set(['openrouter', 'litellm', 'local_endpoint']);

export interface StreamTerminalFailureEvent {
  purpose: RoutingPurpose;
  attempts: number;
  candidate?: RoutingCandidate;
  candidates: RoutingCandidate[];
  error: Error;
  correlation?: Partial<CorrelationMetadata>;
  service: string;
  process: string;
}

export interface SubstrateStreamTransport {
  stream(context: LLMContext, callbacks?: StreamCallbacks): Promise<LLMResponse>;
}

export interface SubstrateStreamRuntimeOptions {
  onBudgetBlocked?: (event: ModelBudgetBlockedEvent) => void;
  onTerminalFailure?: (event: StreamTerminalFailureEvent) => void | Promise<void>;
  transport: SubstrateStreamTransport;
}

/**
 * Create a StreamFn for pi-agent-core's Agent.
 *
 * The model is passed in by the Agent — use `resolveModel()` to create it
 * from SubstrateConfig and set it via `agent.setModel()`.
 */
export function createSubstrateStreamFn(
  config: CoreSubstrateConfig,
  runtimeOptions?: SubstrateStreamRuntimeOptions,
): StreamFn {
  if (!runtimeOptions?.transport) {
    throw new Error(
      'Core stream adapter requires an injected transport; direct provider transport is not supported.',
    );
  }
  const litellmBaseUrl = resolveConfiguredLiteLLMBaseUrl(config);
  const budgetController = new ModelBudgetController(config);
  const fallbackRunner = new FallbackRunner();

  const wrappedStreamFn: StreamFn = async (model, context, options) => {
    const requestContext = getRequestContext();
    const correlationFields = toCorrelationLogFields(requestContext);
    const purpose = resolveStreamBudgetPurpose(requestContext);
    const processName = requestContext?.originStage ?? requestContext?.purpose ?? 'agent.stream.prompt';
    const service = requestContext?.callType ?? 'chat';
    const estimatedInputTokens = resolveEstimatedBudgetInputTokens(budgetController, context);
    const callerMaxTokens = resolveCallerMaxTokens(options?.maxTokens);
    const candidates = resolveStreamCandidates(
      config,
      purpose,
      model,
      callerMaxTokens,
      litellmBaseUrl,
    );

    let lastAttemptCandidate: RoutingCandidate | undefined;
    let lastAttempt = 0;

    const fallbackStream = fallbackRunner.runStream(
      purpose,
      candidates,
      (candidateTarget, attempt) => {
        lastAttemptCandidate = candidateTarget;
        lastAttempt = attempt;
        return executeStreamCandidate({
          candidate: candidateTarget,
          attempt,
          config,
          transport: runtimeOptions.transport,
          litellmBaseUrl,
          model,
          context,
          options,
          purpose,
          service,
          processName,
          estimatedInputTokens,
          requestContext,
          budgetController,
          onBudgetBlocked: runtimeOptions.onBudgetBlocked,
          correlationFields,
        });
      },
      requestContext,
    );

    return (async function* streamWithTerminalFailureHook() {
      try {
        yield* fallbackStream;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        if (runtimeOptions.onTerminalFailure) {
          try {
            await runtimeOptions.onTerminalFailure({
              purpose,
              attempts: Math.max(1, lastAttempt),
              candidate: lastAttemptCandidate,
              candidates,
              error: err,
              correlation: requestContext,
              service,
              process: processName,
            });
          } catch (hookError) {
            log.warn('Failed to emit prompt-generation failure hook', {
              error: hookError instanceof Error ? hookError.message : String(hookError),
              purpose,
              attempts: Math.max(1, lastAttempt),
              ...correlationFields,
            });
          }
        }
        throw err;
      }
    })() as any;
  };
  return wrappedStreamFn;
}

interface ExecuteStreamCandidateParams {
  candidate: RoutingCandidate;
  attempt: number;
  config: CoreSubstrateConfig;
  transport: SubstrateStreamTransport;
  litellmBaseUrl: string | null;
  model: Model<any>;
  context: unknown;
  options: Record<string, unknown> | undefined;
  purpose: RoutingPurpose;
  service: string;
  processName: string;
  estimatedInputTokens?: number;
  requestContext: Partial<CorrelationMetadata> | undefined;
  budgetController: ModelBudgetController;
  onBudgetBlocked?: (event: ModelBudgetBlockedEvent) => void;
  correlationFields: ReturnType<typeof toCorrelationLogFields>;
}

function executeStreamCandidate(params: ExecuteStreamCandidateParams): AsyncGenerator<AssistantMessageEvent, void, unknown> {
  const { candidate } = params;
  const preflight = params.budgetController.evaluatePreflight({
    candidate,
    purpose: params.purpose,
    service: params.service,
    process: params.processName,
    estimatedInputTokens: params.estimatedInputTokens ?? 0,
    correlation: params.requestContext,
  });
  if (!preflight.allowed && preflight.blockedEvent) {
    params.onBudgetBlocked?.(preflight.blockedEvent);
    throw new ModelBudgetExceededError(preflight.blockedEvent);
  }

  const requestOptions = buildStreamRequestOptions(
    candidate,
    params.options,
    undefined,
    params.litellmBaseUrl,
  );
  const retryConfig = llmRetryConfig(params.config);
  const maxRetries = Number.isFinite(retryConfig.maxRetries)
    ? Math.max(0, Math.floor(retryConfig.maxRetries!))
    : DEFAULT_MAX_RETRIES;
  const baseDelayMs = Number.isFinite(retryConfig.baseDelayMs)
    ? Math.max(0, Math.floor(retryConfig.baseDelayMs!))
    : DEFAULT_BASE_DELAY_MS;

  return (async function* executeWithRetry() {
    for (let retryAttempt = 0; ; retryAttempt += 1) {
      let committed = false;
      const bufferedEvents: AssistantMessageEvent[] = [];

      try {
        const stream = createTransportEventStream({
          candidate,
          model: params.model,
          context: params.context,
          requestContext: params.requestContext,
          requestOptions,
          transport: params.transport,
        });

        for await (const rawEvent of stream) {
          const event = rawEvent as AssistantMessageEvent;

          if (event.type === 'error') {
            const error = new Error(event.error.errorMessage ?? 'LLM stream error');
            if (committed) {
              throw new NonRecoverableFallbackError(error);
            }
            throw error;
          }

          if (event.type === 'done') {
            assertValidTerminalAssistantMessage(event.message, candidate);
            if (!committed) {
              committed = true;
              for (const bufferedEvent of bufferedEvents) {
                yield bufferedEvent;
              }
            }

            params.budgetController.recordUsage({
              candidate,
              purpose: params.purpose,
              service: params.service,
              process: params.processName,
              inputTokens: toUsageCount(event.message.usage.input),
              outputTokens: toUsageCount(event.message.usage.output),
              correlation: params.requestContext,
            });

            yield event;
            return;
          }

          if (!committed) {
            bufferedEvents.push(event);
            if (shouldCommitBufferedEvent(event)) {
              committed = true;
              for (const bufferedEvent of bufferedEvents) {
                yield bufferedEvent;
              }
            }
            continue;
          }

          yield event;
        }

        const streamError = new Error('LLM stream completed without terminal event');
        if (committed) {
          throw new NonRecoverableFallbackError(streamError);
        }
        throw streamError;
      } catch (error) {
        const explicitNonRecoverable = error instanceof NonRecoverableFallbackError;
        const err = explicitNonRecoverable
          ? error.causeError
          : (error instanceof Error ? error : new Error(String(error)));

        if (committed) {
          throw explicitNonRecoverable ? error : new NonRecoverableFallbackError(err);
        }

        const canRetry = retryAttempt < maxRetries && isRetryableError(err, retryConfig.retryableErrors);
        if (!canRetry) {
          throw err;
        }

        const delayMs = baseDelayMs * (2 ** retryAttempt);
        log.warn('LLM stream failed, retrying', {
          model: String(params.model.id),
          provider: candidate.provider,
          attempt: retryAttempt + 1,
          maxRetries,
          delayMs,
          error: err.message,
          purpose: params.purpose,
          ...params.correlationFields,
        });
        await sleep(delayMs);
      }
    }
  })();
}

interface TransportEventStreamParams {
  candidate: RoutingCandidate;
  model: Model<any>;
  context: unknown;
  requestContext: Partial<CorrelationMetadata> | undefined;
  requestOptions: Record<string, unknown>;
  transport: SubstrateStreamTransport;
}

function createTransportEventStream(
  params: TransportEventStreamParams,
): AsyncGenerator<AssistantMessageEvent, void, unknown> {
  return (async function* transportEventStream() {
    const queue = new AsyncEventQueue<AssistantMessageEvent>();
    const api = typeof (params.model as { api?: unknown }).api === 'string'
      ? (params.model as { api: string }).api
      : 'chat';
    const state = createTransportMessageState({
      api,
      provider: params.candidate.provider,
      model: String(params.model.id),
    });

    yield {
      type: 'start',
      partial: cloneAssistantMessage(state.partial),
    } as AssistantMessageEvent;

    const runTransport = (async () => {
      try {
        const response = await params.transport.stream(
          buildTransportContext(params.candidate, params.context, params.requestContext, params.requestOptions),
          {
            onText: (delta) => {
              enqueueTextDelta(queue, state, delta);
            },
          },
        );

        applyTerminalResponse(state, response);
        enqueueThinkingEvents(queue, state, response.reasoning);
        enqueueMissingTextEvents(queue, state, response.content);
        enqueueToolCallEvents(queue, state, response.toolCalls);
        queue.push({
          type: 'done',
          reason: response.stopReason,
          message: cloneAssistantMessage(state.partial),
        } as AssistantMessageEvent);
        queue.close();
      } catch (error) {
        queue.fail(error instanceof Error ? error : new Error(String(error)));
      }
    })();

    try {
      for (;;) {
        const next = await queue.next();
        if (next === null) {
          break;
        }
        yield next;
      }
      await runTransport;
    } catch (error) {
      await runTransport.catch(() => undefined);
      throw error;
    }
  })();
}

function buildTransportContext(
  candidate: RoutingCandidate,
  context: unknown,
  requestContext: Partial<CorrelationMetadata> | undefined,
  requestOptions: Record<string, unknown>,
): LLMContext {
  const llmContext = context as LLMContext;
  return {
    systemPrompt: llmContext.systemPrompt,
    messages: llmContext.messages,
    ...(llmContext.tools?.length ? { tools: llmContext.tools } : {}),
    modelHint: buildTransportModelHint(candidate, requestOptions),
    ...(requestContext ? { correlation: requestContext as CorrelationMetadata } : {}),
  };
}

function buildTransportModelHint(
  candidate: RoutingCandidate,
  requestOptions: Record<string, unknown>,
): NonNullable<LLMContext['modelHint']> {
  const reasoning = requestOptions.reasoning;
  return {
    model: candidate.model,
    provider: candidate.provider,
    maxTokens: candidate.maxTokens,
    ...(candidate.contextWindow !== undefined ? { contextWindow: candidate.contextWindow } : {}),
    ...(candidate.temperature !== undefined ? { temperature: candidate.temperature } : {}),
    ...(candidate.topP !== undefined ? { topP: candidate.topP } : {}),
    ...(candidate.topK !== undefined ? { topK: candidate.topK } : {}),
    ...(candidate.frequencyPenalty !== undefined ? { frequencyPenalty: candidate.frequencyPenalty } : {}),
    ...(candidate.repetitionPenalty !== undefined ? { repetitionPenalty: candidate.repetitionPenalty } : {}),
    ...(candidate.thinkingEnabled !== undefined ? { thinkingEnabled: candidate.thinkingEnabled } : {}),
    ...(typeof reasoning === 'string' ? { thinkingEffort: reasoning as ThinkingLevel } : {}),
  };
}

type TransportMessageState = {
  partial: AssistantMessage;
  textContentIndex: number | null;
  thinkingContentIndex: number | null;
  textStreamStarted: boolean;
};

function createTransportMessageState(input: {
  api: string;
  provider: string;
  model: string;
}): TransportMessageState {
  return {
    partial: {
      role: 'assistant',
      content: [],
      api: input.api,
      provider: input.provider,
      model: input.model,
      usage: zeroUsage(),
      stopReason: 'stop',
      timestamp: Date.now(),
    } as AssistantMessage,
    textContentIndex: null,
    thinkingContentIndex: null,
    textStreamStarted: false,
  };
}

function enqueueTextDelta(
  queue: AsyncEventQueue<AssistantMessageEvent>,
  state: TransportMessageState,
  delta: string,
): void {
  if (!delta) {
    return;
  }
  const contentIndex = ensureTextContentIndex(state);
  if (state.partial.content[contentIndex]?.type !== 'text') {
    throw new Error('Transport text content index did not resolve to a text block');
  }
  state.partial.content[contentIndex] = {
    type: 'text',
    text: `${state.partial.content[contentIndex].text}${delta}`,
  };
  state.textStreamStarted = true;
  queue.push({
    type: state.partial.content[contentIndex].text.length === delta.length ? 'text_start' : 'text_delta',
    contentIndex,
    ...(state.partial.content[contentIndex].text.length === delta.length ? {} : { delta }),
    partial: cloneAssistantMessage(state.partial),
  } as AssistantMessageEvent);
}

function enqueueMissingTextEvents(
  queue: AsyncEventQueue<AssistantMessageEvent>,
  state: TransportMessageState,
  content: string,
): void {
  if (!content || state.textStreamStarted) {
    return;
  }
  const contentIndex = ensureTextContentIndex(state);
  state.partial.content[contentIndex] = {
    type: 'text',
    text: content,
  };
  state.textStreamStarted = true;
  queue.push({
    type: 'text_start',
    contentIndex,
    partial: cloneAssistantMessage(state.partial),
  } as AssistantMessageEvent);
  queue.push({
    type: 'text_delta',
    contentIndex,
    delta: content,
    partial: cloneAssistantMessage(state.partial),
  } as AssistantMessageEvent);
}

function enqueueThinkingEvents(
  queue: AsyncEventQueue<AssistantMessageEvent>,
  state: TransportMessageState,
  reasoning: string | undefined,
): void {
  if (!reasoning) {
    return;
  }
  const contentIndex = ensureThinkingContentIndex(state);
  state.partial.content[contentIndex] = {
    type: 'thinking',
    thinking: reasoning,
  };
  queue.push({
    type: 'thinking_start',
    contentIndex,
    partial: cloneAssistantMessage(state.partial),
  } as AssistantMessageEvent);
  queue.push({
    type: 'thinking_delta',
    contentIndex,
    delta: reasoning,
    partial: cloneAssistantMessage(state.partial),
  } as AssistantMessageEvent);
  queue.push({
    type: 'thinking_end',
    contentIndex,
    partial: cloneAssistantMessage(state.partial),
  } as AssistantMessageEvent);
}

function enqueueToolCallEvents(
  queue: AsyncEventQueue<AssistantMessageEvent>,
  state: TransportMessageState,
  toolCalls: ToolCall[],
): void {
  for (const toolCall of toolCalls) {
    const contentIndex = state.partial.content.length;
    state.partial.content.push({
      type: 'toolCall',
      id: toolCall.id,
      name: toolCall.name,
      arguments: toolCall.input,
    });
    queue.push({
      type: 'toolcall_end',
      contentIndex,
      partial: cloneAssistantMessage(state.partial),
      toolCall: {
        type: 'toolCall',
        id: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.input,
      },
    } as AssistantMessageEvent);
  }
}

function applyTerminalResponse(
  state: TransportMessageState,
  response: LLMResponse,
): void {
  state.partial.model = response.model;
  state.partial.stopReason = response.stopReason;
  state.partial.timestamp = Date.now();
  state.partial.usage = buildUsage(response);
  if (response.content) {
    const index = ensureTextContentIndex(state);
    state.partial.content[index] = {
      type: 'text',
      text: response.content,
    };
  }
}

function ensureTextContentIndex(state: TransportMessageState): number {
  if (state.textContentIndex !== null) {
    return state.textContentIndex;
  }
  const contentIndex = state.partial.content.length;
  state.partial.content.push({ type: 'text', text: '' });
  state.textContentIndex = contentIndex;
  return contentIndex;
}

function ensureThinkingContentIndex(state: TransportMessageState): number {
  if (state.thinkingContentIndex !== null) {
    return state.thinkingContentIndex;
  }
  const contentIndex = state.partial.content.length;
  state.partial.content.push({ type: 'thinking', thinking: '' });
  state.thinkingContentIndex = contentIndex;
  return contentIndex;
}

function buildUsage(response: LLMResponse): AssistantMessage['usage'] {
  const input = toUsageCount(response.inputTokens);
  const output = toUsageCount(response.outputTokens);
  const totalTokens = input + output;
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function zeroUsage(): AssistantMessage['usage'] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function cloneAssistantMessage(message: AssistantMessage): AssistantMessage {
  return {
    ...message,
    content: message.content.map((entry) => {
      if (entry.type === 'text') {
        return { ...entry };
      }
      if (entry.type === 'thinking') {
        return { ...entry };
      }
      return {
        ...entry,
        arguments: { ...entry.arguments },
      };
    }),
    usage: {
      ...message.usage,
      cost: { ...message.usage.cost },
    },
  };
}

class AsyncEventQueue<T> {
  private items: T[] = [];
  private pending: Array<{
    resolve: (value: T | null) => void;
    reject: (error: Error) => void;
  }> = [];
  private done = false;
  private error: Error | null = null;

  push(item: T): void {
    if (this.done || this.error) {
      return;
    }
    const waiter = this.pending.shift();
    if (waiter) {
      waiter.resolve(item);
      return;
    }
    this.items.push(item);
  }

  close(): void {
    this.done = true;
    while (this.pending.length > 0) {
      const waiter = this.pending.shift();
      waiter?.resolve(null);
    }
  }

  fail(error: Error): void {
    this.error = error;
    while (this.pending.length > 0) {
      const waiter = this.pending.shift();
      waiter?.reject(error);
    }
  }

  async next(): Promise<T | null> {
    if (this.items.length > 0) {
      return this.items.shift()!;
    }
    if (this.error) {
      throw this.error;
    }
    if (this.done) {
      return null;
    }
    return await new Promise<T | null>((resolve, reject) => {
      this.pending.push({ resolve, reject });
    });
  }
}

function resolveCallerMaxTokens(optionsMaxTokens: unknown): number | undefined {
  if (typeof optionsMaxTokens !== 'number' || !Number.isFinite(optionsMaxTokens) || optionsMaxTokens <= 0) {
    return undefined;
  }
  return Math.floor(optionsMaxTokens);
}

function resolveStreamMaxTokens(model: Model<any>, optionsMaxTokens: unknown, fallback: number): number {
  const callerMaxTokens = resolveCallerMaxTokens(optionsMaxTokens);
  if (callerMaxTokens !== undefined) {
    return callerMaxTokens;
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

function resolveEstimatedBudgetInputTokens(
  budgetController: ModelBudgetController,
  context: unknown,
): number | undefined {
  if (!budgetController.requiresPreflightEstimate()) {
    return undefined;
  }
  return estimateContextInputTokens(context);
}

function estimateContextInputTokens(context: unknown): number {
  const llmContext = context as Partial<LLMContext>;
  const budgetMessages: Array<{ role: string; content: string }> = [];

  if (typeof llmContext.systemPrompt === 'string' && llmContext.systemPrompt) {
    budgetMessages.push({
      role: 'system',
      content: llmContext.systemPrompt,
    });
  }

  if (Array.isArray(llmContext.messages)) {
    for (const message of llmContext.messages) {
      budgetMessages.push({
        role: message.role,
        content: typeof message.content === 'string'
          ? message.content
          : JSON.stringify(message.content),
      });
    }
  }

  return Math.max(1, countMessageTokens(budgetMessages));
}

function resolveStreamReasoningLevel(candidate: RoutingCandidate): ThinkingLevel | undefined {
  if (candidate.thinkingEnabled === false) return undefined;
  if (candidate.thinkingEffort) return candidate.thinkingEffort;
  if (candidate.thinkingEnabled === true) return 'medium';
  return undefined;
}

function supportsFullKnobPassthrough(candidate: RoutingCandidate, litellmBaseUrl: string | null): boolean {
  return FULL_KNOB_PASSTHROUGH_PROVIDERS.has(candidate.provider)
    || !!candidate.requestBaseUrl
    || litellmBaseUrl !== null;
}

function buildStreamRequestOptions(
  candidate: RoutingCandidate,
  options: Record<string, unknown> | undefined,
  apiKey: string | undefined,
  litellmBaseUrl: string | null,
): Record<string, unknown> {
  const requestOptions: Record<string, unknown> = {
    ...(options ?? {}),
    apiKey,
    maxTokens: candidate.maxTokens,
  };

  if (candidate.contextWindow !== undefined && requestOptions.contextWindow === undefined) {
    requestOptions.contextWindow = candidate.contextWindow;
  }

  if (candidate.temperature !== undefined && requestOptions.temperature === undefined) {
    requestOptions.temperature = candidate.temperature;
  }

  const reasoning = resolveStreamReasoningLevel(candidate);
  if (reasoning && requestOptions.reasoning === undefined) {
    requestOptions.reasoning = reasoning;
  }

  if (supportsFullKnobPassthrough(candidate, litellmBaseUrl)) {
    if (candidate.topP !== undefined && requestOptions.topP === undefined) {
      requestOptions.topP = candidate.topP;
    }
    if (candidate.topK !== undefined && requestOptions.topK === undefined) {
      requestOptions.topK = candidate.topK;
    }
    if (candidate.frequencyPenalty !== undefined && requestOptions.frequencyPenalty === undefined) {
      requestOptions.frequencyPenalty = candidate.frequencyPenalty;
    }
    if (candidate.repetitionPenalty !== undefined && requestOptions.repetitionPenalty === undefined) {
      requestOptions.repetitionPenalty = candidate.repetitionPenalty;
    }
  }

  if (candidate.provider === 'openrouter') {
    if (candidate.openRouterZdrOnly && requestOptions.zdr === undefined) {
      requestOptions.zdr = true;
    }
    if (candidate.openRouterProviderOrder && candidate.openRouterProviderOrder.length > 0 && requestOptions.provider === undefined) {
      requestOptions.provider = { order: [...candidate.openRouterProviderOrder] };
    }
  }

  return requestOptions;
}

function resolveStreamCandidates(
  config: CoreSubstrateConfig,
  purpose: RoutingPurpose,
  model: Model<any>,
  callerMaxTokens: number | undefined,
  litellmBaseUrl: string | null,
): RoutingCandidate[] {
  const currentCandidate = buildCurrentCandidate(
    config,
    model,
    callerMaxTokens,
    litellmBaseUrl,
  );
  const routingCandidates = resolveRoutingCandidates(config, purpose);
  const adjustedRoutingCandidates = routingCandidates.map(candidate => (
    callerMaxTokens === undefined
      ? candidate
      : {
        ...candidate,
        maxTokens: callerMaxTokens,
      }
  ));

  if (routingCandidates.length === 0) {
    if (purpose !== 'chat') {
      throw new Error(
        `No eligible model configured for purpose '${purpose}'. ` +
        'Add a primary model for this purpose in config.modelRegistry.',
      );
    }
    return [currentCandidate];
  }

  if (purpose !== 'chat') {
    return adjustedRoutingCandidates;
  }

  const matchedIndex = adjustedRoutingCandidates.findIndex(candidate => candidatesEquivalent(candidate, currentCandidate));
  if (matchedIndex < 0) {
    return [currentCandidate];
  }

  const matched = adjustedRoutingCandidates[matchedIndex]!;
  return [
    matched,
    ...adjustedRoutingCandidates.filter((_, index) => index !== matchedIndex),
  ];
}

function buildCurrentCandidate(
  config: CoreSubstrateConfig,
  model: Model<any>,
  callerMaxTokens: number | undefined,
  litellmBaseUrl: string | null,
): RoutingCandidate {
  const modelProvider = resolveModelProvider(model);
  const effectiveProvider = litellmBaseUrl
    ? config.primaryProvider.trim().toLowerCase()
    : (modelProvider ?? config.primaryProvider).trim().toLowerCase();
  const rawModelId = String(model.id);
  const normalizedModelId = litellmBaseUrl
    ? normalizeModelIdForProvider(effectiveProvider, rawModelId)
    : normalizeModelIdForProvider(effectiveProvider, rawModelId);
  const resolvedMaxTokens = callerMaxTokens ?? resolveStreamMaxTokens(model, undefined, config.primaryMaxTokens);
  const registryEntry = findRegistryEntryByProviderModel(config, effectiveProvider, normalizedModelId)
    ?? findRegistryEntryByModelId(config, normalizedModelId);

  return {
    provider: registryEntry?.identity.provider ?? effectiveProvider,
    model: registryEntry?.identity.model ?? normalizedModelId,
    maxTokens: resolvedMaxTokens,
    ...(registryEntry?.capabilities?.contextWindow
      ? { contextWindow: registryEntry.capabilities.contextWindow }
      : (typeof model.contextWindow === 'number' && Number.isFinite(model.contextWindow) && model.contextWindow > 0
        ? { contextWindow: Math.floor(model.contextWindow) }
        : {})),
    ...(registryEntry ? { slotKey: registryEntry.id } : {}),
  };
}

function candidatesEquivalent(left: RoutingCandidate, right: RoutingCandidate): boolean {
  return left.provider === right.provider
    && left.model === right.model
    && (left.slotKey ?? '') === (right.slotKey ?? '');
}

function shouldCommitBufferedEvent(event: AssistantMessageEvent): boolean {
  return event.type !== 'start'
    && event.type !== 'thinking_start';
}

function assertValidTerminalAssistantMessage(
  message: AssistantMessage,
  candidate: RoutingCandidate,
): void {
  const stopReason = message.stopReason;
  if (stopReason === 'error' || stopReason === 'aborted') {
    throw new Error(message.errorMessage ?? `LLM request failed for ${candidate.provider}/${candidate.model}`);
  }

  const hasText = message.content.some((entry) => (
    entry.type === 'text' && entry.text.trim().length > 0
  ));
  const hasToolCalls = message.content.some((entry) => (
    entry.type === 'toolCall' && entry.name.trim().length > 0
  ));

  if (!hasText && !hasToolCalls) {
    throw new Error(
      message.errorMessage
      ?? `LLM response from ${candidate.provider}/${candidate.model} contained no text or tool calls`,
    );
  }
}

function toUsageCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
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
 * Uses LiteLLM proxy if providers.json or env config resolves one, otherwise falls back
 * to pi-ai's built-in model registry via resolveRegisteredModel().
 */
export function resolveModel(
  config: CoreSubstrateConfig,
  purpose: ModelPurpose = 'chat',
): Model<any> {
  const litellmBaseUrl = resolveConfiguredLiteLLMBaseUrl(config);
  const selection = resolveModelSelection(config, purpose);

  if (litellmBaseUrl) {
    const modelId = normalizeLiteLLMModelId(selection.provider, selection.model);
    const model = createModel(litellmBaseUrl, modelId, selection.maxTokens, selection.contextWindow);
    return ensurePurposeInputCapabilities(model, purpose, {
      supportsVision: selection.supportsVision,
    });
  }

  // Direct provider mode — use pi-ai's built-in registry.
  // resolveRegisteredModel() handles the string→KnownProvider type boundary safely.
  const model = resolveRegisteredModel(selection.provider, selection.model);
  if (!model) {
    throw new Error(
      `Unknown model "${selection.model}" for provider "${selection.provider}". ` +
      'Configure LiteLLM in providers.json or update the canonical model config in models.json.',
    );
  }
  return ensurePurposeInputCapabilities(model, purpose, {
    supportsVision: selection.supportsVision,
  });
}

export function resolveModelSelection(
  config: CoreSubstrateConfig,
  purpose: ModelPurpose = 'chat',
): RoutingCandidate {
  const routingPurpose = toRoutingPurpose(purpose);
  const candidates = resolveRoutingCandidates(config, routingPurpose) as RoutingCandidate[];
  if (candidates.length > 0) {
    return candidates[0]!;
  }

  throw new Error(
    `No eligible model configured for purpose '${purpose}'. ` +
    'Add a primary model for this purpose in config.modelRegistry.',
  );
}

export function resolveExplicitModel(
  config: CoreSubstrateConfig,
  selection: MessageModelOverride,
): Model<any> {
  const litellmBaseUrl = resolveConfiguredLiteLLMBaseUrl(config);

  if (litellmBaseUrl) {
    const modelId = normalizeLiteLLMModelId(selection.provider, selection.model);
    const model = createModel(litellmBaseUrl, modelId, selection.maxTokens, selection.contextWindow);
    return ensurePurposeInputCapabilities(model, selection.purpose);
  }

  const registered = resolveRegisteredModel(selection.provider, selection.model);
  if (!registered) {
    throw new Error(
      `Unknown model "${selection.model}" for provider "${selection.provider}". ` +
      'Use a known canonical provider model or configure LiteLLM.',
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
  options: { supportsVision?: boolean } = {},
): Model<any> {
  if (purpose !== 'vision') {
    return model;
  }

  const currentInput: Array<'text' | 'image'> = Array.isArray(model.input)
    ? [...model.input]
    : [];
  const nextInput: Array<'text' | 'image'> = currentInput.includes('text')
    ? [...currentInput]
    : ['text', ...currentInput];

  if (nextInput.includes('image')) {
    return nextInput.length === currentInput.length
      ? model
      : {
        ...model,
        input: nextInput,
      };
  }

  if (options.supportsVision !== true) {
    throw new Error(
      `Model "${String(model.id)}" is not configured for vision input. Configure a vision-capable model for the vision purpose in models.json.`,
    );
  }

  return {
    ...model,
    input: [...nextInput, 'image'],
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
