// ── pi-agent-core Stream Adapter ──
// Bridges our model-routing configuration into pi-agent-core's StreamFn interface.
// Core always uses an injected transport port so provider credentials remain outside
// the core runtime boundary.

import { randomUUID } from 'node:crypto';
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
  StopReason,
  ThinkingLevel,
} from '@earendil-works/pi-ai';
import type { StreamFn } from '../../boundary/pi-agent/index.js';
import type {
  CorrelationMetadata,
  LLMCapturedProviderWirePayload,
  LLMContext,
  LLMResponse,
  LLMStreamFirstOutputObservation,
  MessageModelOverride,
  ModelPurpose,
  StreamCallbacks,
  ToolCall,
  ToolSchema,
} from '../../shared/contracts/runtime.js';
import type { CoreSubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { createOpenAICompatibleEndpointModel, resolveRegisteredModel } from '../../primitives/llm/models.js';
import { resolveRoutingCandidates, type RoutingCandidate, type RoutingPurpose } from '../../primitives/llm/routing.js';
import {
  buildStreamTransportModelHint,
  resolveCompanionStreamRoute,
  resolveCompanionTransportSlotKey,
} from './stream-model-selection.js';
import {
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_RETRIES,
  isRetryableError,
} from '../../primitives/llm/retry.js';
import { llmRetryConfig } from '../../primitives/llm/retry-config.js';
import { createComponentLogger } from '../../shared/logger.js';
import { sleep } from '../../shared/utils/timing.js';
import { getRequestContext } from '../../primitives/llm/request-context.js';
import { toCorrelationLogFields } from '../../primitives/llm/correlation.js';
import {
  FallbackRunner,
  NonRecoverableFallbackError,
} from '../../primitives/llm/fallback.js';
import {
  findRegistryEntryByModelId,
  findRegistryEntryByProviderModel,
  normalizeModelIdForProvider,
} from '../../primitives/llm/model-budget.js';
import { repairStringifiedJsonArrayToolArguments } from './tool-argument-repair.js';
import { isRecord } from '../../shared/utils/types.js';
import type { LLMProviderStreamOptions } from './contracts.js';
import type { ProviderRuntime } from '../../primitives/llm/provider-runtime.js';
import { resolveExplicitToolRequestSequence } from '../../shared/tools/explicit-tool-request.js';
import {
  MAX_EMPTY_TOOL_ARGS_COMPLETION_RETRIES,
} from '../../primitives/llm/empty-tool-argument-retry.js';
import {
  extractToolCallsFromContentBlocks,
  findCorruptEmptyToolCalls,
} from '../../primitives/llm/client-response-helpers.js';
import {
  assertExplicitToolContractSatisfied,
  isMissingRequiredToolCallError,
  resolveExplicitToolContract,
} from '../../primitives/llm/explicit-tool-request.js';

const log = createComponentLogger('StreamAdapter');
const FULL_KNOB_PASSTHROUGH_PROVIDERS = new Set(['openrouter', 'local_endpoint']);

class SemanticToolRetrySignal extends Error {
  constructor(
    readonly reason: 'missing_required_call' | 'corrupt_empty_arguments',
    readonly toolNames: readonly string[],
  ) {
    super(`Retry required for ${reason}: ${toolNames.join(', ')}`);
    this.name = 'SemanticToolRetrySignal';
  }
}

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
  /**
   * mmo9.6.1 + mmo9.5.1: `options.signal` aborts the in-flight provider request
   * mid-generation. The scheduled agent loop forwards the run's AbortController
   * signal into the streamFn options; this adapter threads it to the transport
   * as `options.signal` so `SubstrateAgent.abort()`/`cancelTurn()` tears down the
   * upstream stream rather than only halting local iteration. The transport
   * composes it with the model-call gate's preempt signal (mmo9.5.1) so the
   * upstream stream is torn down when either source fires.
   */
  stream(
    context: LLMContext,
    callbacks?: StreamCallbacks,
    options?: LLMProviderStreamOptions,
  ): Promise<LLMResponse>;
}

export interface SubstrateStreamRuntimeOptions {
  onTerminalFailure?: (event: StreamTerminalFailureEvent) => void | Promise<void>;
  onProviderFirstOutput?: (event: ProviderFirstOutputEvent) => void | Promise<void>;
  onProviderPayloadCaptured?: (event: ProviderPayloadCapturedEvent) => void | Promise<void>;
  transport: SubstrateStreamTransport;
}

export type ProviderFirstOutputEvent = LLMStreamFirstOutputObservation
  & Partial<CorrelationMetadata>
  & {
    provider: string;
    model: string;
  };

/**
 * The true provider wire body captured as-sent for one provider call
 * (bead hgw3-80f6). Surfaced from the LLMResponse so the turn snapshot can carry
 * the raw-wire view instead of the pre-call reconstructions.
 */
export type ProviderPayloadCapturedEvent = {
  payload: LLMCapturedProviderWirePayload;
}
  & Partial<CorrelationMetadata>
  & {
    provider: string;
    model: string;
  };

/**
 * Create a StreamFn for pi-agent-core's Agent.
 *
 * The model is passed in by the Agent — use `resolveModel()` to create it
 * from SubstrateConfig and set it via `agent.state.model = model`.
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
  const fallbackRunner = new FallbackRunner();

  const wrappedStreamFn: StreamFn = async (model, context, options) => {
    const requestContext = getRequestContext();
    const correlationFields = toCorrelationLogFields(requestContext);
    const purpose = resolveStreamBudgetPurpose(requestContext);
    const processName = requestContext?.originStage ?? requestContext?.purpose ?? 'agent.stream.prompt';
    const service = requestContext?.callType ?? 'chat';
    const callerMaxTokens = resolveCallerMaxTokens(options?.maxTokens);
    const candidates = resolveStreamCandidates(
      config,
      purpose,
      model,
      callerMaxTokens,
    );
    const logicalCallId = `llm:${randomUUID()}:chat:${purpose}`;
    let physicalAttempt = 0;

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
          model,
          context,
          options: options ? { ...options } : undefined,
          purpose,
          service,
          processName,
          requestContext,
          correlationFields,
          logicalCallId,
          onProviderFirstOutput: runtimeOptions.onProviderFirstOutput,
          onProviderPayloadCaptured: runtimeOptions.onProviderPayloadCaptured,
          nextPhysicalAttempt: () => {
            physicalAttempt += 1;
            return physicalAttempt;
          },
        });
      },
      requestContext,
    );

    const streamWithHook: AsyncGenerator<AssistantMessageEvent, void, unknown> = (async function* streamWithTerminalFailureHook() {
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
    })();
    // The generator above yields the full AssistantMessageEvent protocol and
    // is consumed by the repo's scheduled loop as an AsyncIterable with
    // terminal-event resolution (resolveStreamResult tolerates a stream with
    // no `result()` method). pi-agent-core, however, declares StreamFn's
    // result as the AssistantMessageEventStream CLASS, whose private fields
    // no generator can structurally satisfy — so this single documented
    // conversion bridges the declared type at the boundary without erasing
    // the event type. Do not hand this streamFn to a consumer that calls the
    // class-only surface (push/end/result) on it.
    return streamWithHook as unknown as AssistantMessageEventStream;
  };
  return wrappedStreamFn;
}

interface ExecuteStreamCandidateParams {
  candidate: RoutingCandidate;
  attempt: number;
  config: CoreSubstrateConfig;
  transport: SubstrateStreamTransport;
  model: Model<any>;
  context: unknown;
  options: SimpleStreamOptions | undefined;
  purpose: RoutingPurpose;
  service: string;
  processName: string;
  requestContext: Partial<CorrelationMetadata> | undefined;
  correlationFields: ReturnType<typeof toCorrelationLogFields>;
  logicalCallId: string;
  onProviderFirstOutput?: (event: ProviderFirstOutputEvent) => void | Promise<void>;
  onProviderPayloadCaptured?: (event: ProviderPayloadCapturedEvent) => void | Promise<void>;
  nextPhysicalAttempt: () => number;
}

function executeStreamCandidate(params: ExecuteStreamCandidateParams): AsyncGenerator<AssistantMessageEvent, void, unknown> {
  const { candidate } = params;
  // mmo9.6.1: the scheduled agent loop forwards the run's AbortController signal
  // as options.signal; extract it here so it can be threaded to the provider
  // transport (it must not leak into the serialized model-hint requestOptions).
  const streamSignal = extractAbortSignal(params.options);
  const requestOptions = buildStreamRequestOptions(
    candidate,
    params.options,
    undefined,
  );
  const retryConfig = llmRetryConfig(params.config);
  const maxRetries = Number.isFinite(retryConfig.maxRetries)
    ? Math.max(0, Math.floor(retryConfig.maxRetries!))
    : DEFAULT_MAX_RETRIES;
  const baseDelayMs = Number.isFinite(retryConfig.baseDelayMs)
    ? Math.max(0, Math.floor(retryConfig.baseDelayMs!))
    : DEFAULT_BASE_DELAY_MS;
  const holdEventsUntilTerminal = hasExplicitToolExecutionRequest(params.context);
  const normalizedTools = normalizeTransportTools((params.context as { tools?: unknown }).tools);
  const explicitToolContract = holdEventsUntilTerminal
    ? resolveExplicitToolContract({
        context: {
          ...(params.context as LLMContext),
          ...(normalizedTools ? { tools: normalizedTools } : {}),
        },
        originStage: 'agent.turn.prompt',
        modelApi: String((params.model as { api?: unknown }).api ?? ''),
      })
    : undefined;

  return (async function* executeWithRetry() {
    let transportRetryAttempt = 0;
    let missingRequiredCallRetries = 0;
    let corruptEmptyArgumentRetries = 0;
    for (;;) {
      let committed = false;
      const bufferedEvents: AssistantMessageEvent[] = [];

      try {
        const stream = createTransportEventStream({
          candidate,
          ...(resolveCompanionTransportSlotKey(params.config, params.purpose, candidate)
            ? { transportSlotKey: candidate.slotKey }
            : {}),
          model: params.model,
          context: params.context,
          requestContext: params.requestContext,
          requestOptions,
          transport: params.transport,
          accounting: {
            logicalCallId: params.logicalCallId,
            attempt: params.nextPhysicalAttempt(),
            retryOwner: 'caller',
          },
          onProviderFirstOutput: params.onProviderFirstOutput,
          ...(streamSignal ? { signal: streamSignal } : {}),
          onProviderPayloadCaptured: params.onProviderPayloadCaptured,
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
            const terminalToolCalls = extractToolCallsFromContentBlocks(event.message.content);
            try {
              assertExplicitToolContractSatisfied({
                choice: explicitToolContract?.choice,
                ...(explicitToolContract?.requiredToolName
                  ? { requiredToolName: explicitToolContract.requiredToolName }
                  : {}),
                toolCalls: terminalToolCalls,
              });
            } catch (error) {
              if (
                isMissingRequiredToolCallError(error)
                && missingRequiredCallRetries < 1
                && explicitToolContract?.requiredToolName
              ) {
                missingRequiredCallRetries += 1;
                throw new SemanticToolRetrySignal(
                  'missing_required_call',
                  [explicitToolContract.requiredToolName],
                );
              }
              throw error;
            }
            const corruptEmptyCalls = findCorruptEmptyToolCalls(
              terminalToolCalls,
              normalizedTools,
            );
            if (
              corruptEmptyCalls.length > 0
              && corruptEmptyArgumentRetries < MAX_EMPTY_TOOL_ARGS_COMPLETION_RETRIES
            ) {
              corruptEmptyArgumentRetries += 1;
              throw new SemanticToolRetrySignal(
                'corrupt_empty_arguments',
                corruptEmptyCalls.map(call => call.name),
              );
            }
            if (!committed) {
              committed = true;
              for (const bufferedEvent of bufferedEvents) {
                yield bufferedEvent;
              }
            }

            yield event;
            return;
          }

          if (!committed) {
            bufferedEvents.push(event);
            if (!holdEventsUntilTerminal && shouldCommitBufferedEvent(event)) {
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

        if (error instanceof SemanticToolRetrySignal) {
          log.warn('LLM semantic tool response failed, retrying at caller boundary', {
            model: String(params.model.id),
            provider: candidate.provider,
            reason: error.reason,
            toolNames: error.toolNames,
            missingRequiredCallRetries,
            corruptEmptyArgumentRetries,
            purpose: params.purpose,
            ...params.correlationFields,
          });
          continue;
        }

        if (isMissingRequiredToolCallError(err)) {
          throw err;
        }

        const canRetry = transportRetryAttempt < maxRetries
          && isRetryableError(err, retryConfig.retryableErrors);
        if (!canRetry) {
          throw err;
        }

        const delayMs = baseDelayMs * (2 ** transportRetryAttempt);
        transportRetryAttempt += 1;
        log.warn('LLM stream failed, retrying', {
          model: String(params.model.id),
          provider: candidate.provider,
          attempt: transportRetryAttempt,
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

function hasExplicitToolExecutionRequest(context: unknown): boolean {
  if (!isRecord(context) || !Array.isArray(context.messages) || !Array.isArray(context.tools)) {
    return false;
  }
  const activeToolNames = context.tools
    .filter(isRecord)
    .map(tool => tool.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
  const latestUserMessage = [...context.messages]
    .reverse()
    .find(message => isRecord(message) && message.role === 'user');
  if (!isRecord(latestUserMessage)) return false;
  const content = latestUserMessage.content;
  const requestText = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .filter(isRecord)
          .filter(block => block.type === 'text' && typeof block.text === 'string')
          .map(block => block.text as string)
          .join('\n')
      : '';
  return resolveExplicitToolRequestSequence(requestText, activeToolNames).length > 0;
}

interface TransportEventStreamParams {
  candidate: RoutingCandidate;
  transportSlotKey?: string;
  model: Model<any>;
  context: unknown;
  requestContext: Partial<CorrelationMetadata> | undefined;
  requestOptions: Record<string, unknown>;
  transport: SubstrateStreamTransport;
  accounting: NonNullable<LLMContext['accounting']>;
  onProviderFirstOutput?: (event: ProviderFirstOutputEvent) => void | Promise<void>;
  /** mmo9.6.1: run-scoped abort signal threaded to the provider transport. */
  signal?: AbortSignal;
  onProviderPayloadCaptured?: (event: ProviderPayloadCapturedEvent) => void | Promise<void>;
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

    let reportedProviderFirstOutput = false;
    const runTransport = (async () => {
      try {
        const transportContext = buildTransportContext(
          params.candidate,
          params.context,
          params.requestContext,
          params.requestOptions,
          params.accounting,
          params.transportSlotKey,
        );
        const transportCallbacks: StreamCallbacks = {
          onText: (delta) => {
            enqueueTextDelta(queue, state, delta);
          },
          onFirstOutput: (observation) => {
            if (!params.onProviderFirstOutput || reportedProviderFirstOutput) return;
            reportedProviderFirstOutput = true;
            void Promise.resolve(params.onProviderFirstOutput({
              ...observation,
              ...(params.requestContext ?? {}),
              provider: params.candidate.provider,
              model: params.candidate.model,
            })).catch(error => log.warn('Provider first-output observer failed', {
              error: error instanceof Error ? error.message : String(error),
              provider: params.candidate.provider,
              model: params.candidate.model,
            }));
          },
        };
        // mmo9.6.1 + mmo9.5.1: forward the caller/barge-in run signal as
        // `options.signal`; the transport composes it with the model-call gate's
        // preempt signal. Only pass the options bag when a signal is present so
        // the no-cancellation call path stays byte-identical for transports/tests
        // that assert exact stream() arity.
        const response = params.signal
          ? await params.transport.stream(transportContext, transportCallbacks, { signal: params.signal })
          : await params.transport.stream(transportContext, transportCallbacks);

        const capturedWirePayload = response.providerObservability?.capturedWirePayload;
        if (capturedWirePayload && params.onProviderPayloadCaptured) {
          void Promise.resolve(params.onProviderPayloadCaptured({
            payload: capturedWirePayload,
            ...(params.requestContext ?? {}),
            provider: params.candidate.provider,
            model: params.candidate.model,
          })).catch(error => log.warn('Provider wire-payload capture observer failed', {
            error: error instanceof Error ? error.message : String(error),
            provider: params.candidate.provider,
            model: params.candidate.model,
          }));
        }

        applyTerminalResponse(state, response);
        enqueueThinkingEvents(queue, state, response.reasoning);
        enqueueMissingTextEvents(queue, state, response.content);
        enqueueToolCallEvents(queue, state, response.toolCalls, resolveContextTools(params.context));
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

/**
 * mmo9.6.1: pull a run-scoped AbortSignal out of the streamFn options bag. The
 * pi-agent-core scheduled loop passes the run's AbortController signal as
 * `options.signal`; everything else in the bag is model-hint/config data.
 */
function extractAbortSignal(options: SimpleStreamOptions | undefined): AbortSignal | undefined {
  const candidate = options?.signal;
  return candidate instanceof AbortSignal ? candidate : undefined;
}

function buildTransportContext(
  candidate: RoutingCandidate,
  context: unknown,
  requestContext: Partial<CorrelationMetadata> | undefined,
  requestOptions: Record<string, unknown>,
  accounting: NonNullable<LLMContext['accounting']>,
  transportSlotKey: string | undefined,
): LLMContext {
  const llmContext = context as LLMContext;
  const tools = normalizeTransportTools((context as { tools?: unknown }).tools);
  return {
    systemPrompt: llmContext.systemPrompt,
    messages: llmContext.messages,
    ...(tools ? { tools } : {}),
    ...(llmContext.promptCacheBoundaries
      ? { promptCacheBoundaries: llmContext.promptCacheBoundaries }
      : {}),
    modelHint: buildStreamTransportModelHint(candidate, requestOptions, transportSlotKey),
    accounting,
    ...(requestContext ? { correlation: requestContext as CorrelationMetadata } : {}),
  };
}

interface StreamToolCandidate {
  name?: unknown;
  description?: unknown;
  inputSchema?: unknown;
  parameters?: unknown;
}

function normalizeTransportTools(tools: unknown): ToolSchema[] | undefined {
  if (tools === undefined) return undefined;
  if (!Array.isArray(tools)) {
    throw new Error('Invalid stream context tools: tools must be an array');
  }
  if (tools.length === 0) return undefined;
  return tools.map(normalizeTransportTool);
}

function normalizeTransportTool(tool: unknown): ToolSchema {
  if (!isRecord(tool)) {
    throw new Error('Invalid stream tool schema: tool must be an object');
  }
  const candidate = tool as StreamToolCandidate;
  if (typeof candidate.name !== 'string' || candidate.name.trim().length === 0) {
    throw new Error('Invalid stream tool schema: tool.name must be a non-empty string');
  }
  if (typeof candidate.description !== 'string' || candidate.description.trim().length === 0) {
    throw new Error(`Invalid stream tool schema for ${candidate.name}: tool.description must be a non-empty string`);
  }
  const inputSchema = candidate.inputSchema ?? candidate.parameters;
  if (!isRecord(inputSchema)) {
    throw new Error(`Invalid stream tool schema for ${candidate.name}: inputSchema or parameters must be an object`);
  }
  return {
    name: candidate.name,
    description: candidate.description,
    inputSchema,
  };
}

function resolveContextTools(context: unknown): readonly unknown[] | undefined {
  const tools = (context as { tools?: unknown }).tools;
  return Array.isArray(tools) ? tools : undefined;
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
  toolSchemas?: readonly unknown[],
): void {
  for (const toolCall of toolCalls) {
    const repairedInput = repairStringifiedJsonArrayToolArguments({
      toolName: toolCall.name,
      args: toolCall.input,
      tools: toolSchemas,
    });
    const contentIndex = state.partial.content.length;
    state.partial.content.push({
      type: 'toolCall',
      id: toolCall.id,
      name: toolCall.name,
      arguments: repairedInput,
    });
    queue.push({
      type: 'toolcall_end',
      contentIndex,
      partial: cloneAssistantMessage(state.partial),
      toolCall: {
        type: 'toolCall',
        id: toolCall.id,
        name: toolCall.name,
        arguments: repairedInput,
      },
    } as AssistantMessageEvent);
  }
}

function applyTerminalResponse(
  state: TransportMessageState,
  response: LLMResponse,
): void {
  state.partial.model = response.model;
  state.partial.stopReason = normalizeStopReason(response.stopReason);
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
  const usageDetails = response.usageDetails;
  const input = toUsageCount(usageDetails?.input ?? response.inputTokens);
  const output = toUsageCount(usageDetails?.output ?? response.outputTokens);
  const cacheRead = toUsageCount(usageDetails?.cacheRead);
  const cacheWrite = toUsageCount(usageDetails?.cacheWrite);
  const totalTokens = toUsageCount(usageDetails?.totalTokens)
    || input + output + cacheRead + cacheWrite;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost: {
      input: toUsageCost(usageDetails?.cost?.input),
      output: toUsageCost(usageDetails?.cost?.output),
      cacheRead: toUsageCost(usageDetails?.cost?.cacheRead),
      cacheWrite: toUsageCost(usageDetails?.cost?.cacheWrite),
      total: toUsageCost(usageDetails?.cost?.total),
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

function resolveStreamReasoningLevel(candidate: RoutingCandidate): ThinkingLevel | undefined {
  if (candidate.thinkingEnabled === false) return undefined;
  if (candidate.thinkingEffort) return candidate.thinkingEffort;
  if (candidate.thinkingEnabled === true) return 'medium';
  return undefined;
}

function supportsFullKnobPassthrough(candidate: RoutingCandidate): boolean {
  return FULL_KNOB_PASSTHROUGH_PROVIDERS.has(candidate.provider)
    || !!candidate.requestBaseUrl;
}

function buildStreamRequestOptions(
  candidate: RoutingCandidate,
  options: SimpleStreamOptions | undefined,
  apiKey: string | undefined,
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

  if (supportsFullKnobPassthrough(candidate)) {
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
): RoutingCandidate[] {
  const currentCandidate = buildCurrentCandidate(
    config,
    purpose,
    model,
    callerMaxTokens,
  );
  const {
    candidates: routingCandidates,
    selectedSlotKey,
  } = resolveCompanionStreamRoute(config, purpose);
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

  if (selectedSlotKey) {
    return adjustedRoutingCandidates;
  }

  let matchedIndex = adjustedRoutingCandidates.findIndex(candidate => candidatesEquivalent(candidate, currentCandidate));
  if (matchedIndex < 0 && currentCandidate.slotKey === undefined) {
    matchedIndex = findUniquePurposeMatchIndex(
      config,
      purpose,
      currentCandidate,
      adjustedRoutingCandidates,
    );
  }
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
  purpose: RoutingPurpose,
  model: Model<any>,
  callerMaxTokens: number | undefined,
): RoutingCandidate {
  const modelProvider = resolveModelProvider(model);
  const effectiveProvider = (modelProvider ?? config.primaryProvider).trim().toLowerCase();
  const rawModelId = String(model.id);
  const normalizedModelId = normalizeModelIdForProvider(effectiveProvider, rawModelId);
  const resolvedMaxTokens = callerMaxTokens ?? resolveStreamMaxTokens(model, undefined, config.primaryMaxTokens);
  const matchedRegistryEntry = findRegistryEntryByProviderModel(config, effectiveProvider, normalizedModelId)
    ?? findRegistryEntryByModelId(config, normalizedModelId);
  const registryEntry = matchedRegistryEntry
    && matchedRegistryEntry.enabled !== false
    && matchedRegistryEntry.purposes.some(tag => tag.purpose === purpose)
    ? matchedRegistryEntry
    : undefined;

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

function candidatesShareIdentity(left: RoutingCandidate, right: RoutingCandidate): boolean {
  const leftProvider = left.provider.trim().toLowerCase();
  const rightProvider = right.provider.trim().toLowerCase();
  return leftProvider === rightProvider
    && normalizeModelIdForProvider(leftProvider, left.model)
      === normalizeModelIdForProvider(rightProvider, right.model);
}

function findUniquePurposeMatchIndex(
  config: CoreSubstrateConfig,
  purpose: RoutingPurpose,
  currentCandidate: RoutingCandidate,
  routingCandidates: RoutingCandidate[],
): number {
  const matchingEntries = config.modelRegistry?.models.filter((entry) => {
    if (entry.enabled === false) return false;
    if (!entry.purposes.some((tag) => tag.purpose === purpose)) return false;
    return candidatesShareIdentity(
      {
        provider: entry.identity.provider,
        model: entry.identity.model,
        maxTokens: currentCandidate.maxTokens,
      },
      currentCandidate,
    );
  }) ?? [];
  if (matchingEntries.length !== 1) return -1;

  const slotKey = matchingEntries[0]!.id;
  return routingCandidates.findIndex(
    candidate => candidate.slotKey === slotKey && candidatesShareIdentity(candidate, currentCandidate),
  );
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

function toUsageCost(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function normalizeStopReason(value: string): StopReason {
  if (value === 'stop' || value === 'length' || value === 'toolUse' || value === 'error' || value === 'aborted') {
    return value;
  }
  return 'stop';
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
 * Routes through a configured OpenAI-compatible provider endpoint when the
 * selected candidate carries a request base URL, otherwise falls back to
 * pi-ai's built-in model registry via resolveRegisteredModel().
 */
export function resolveModel(
  config: CoreSubstrateConfig,
  runtime: ProviderRuntime,
  purpose: ModelPurpose = 'chat',
): Model<any> {
  const selection = resolveModelSelection(config, runtime, purpose);

  if (selection.requestBaseUrl) {
    const model = createOpenAICompatibleEndpointModel({
      baseUrl: selection.requestBaseUrl,
      modelId: selection.model,
      provider: selection.provider,
      routeLabel: selection.provider.replace(/_/g, ' '),
      maxTokens: selection.maxTokens,
      contextWindow: selection.contextWindow,
      reasoning: selection.supportsReasoning ?? selection.thinkingEnabled ?? false,
      supportsVision: selection.supportsVision ?? false,
    });
    return ensurePurposeInputCapabilities(model, purpose, {
      supportsVision: selection.supportsVision,
    });
  }

  // Direct provider mode — use pi-ai's built-in registry.
  // resolveRegisteredModel() handles the string→KnownProvider type boundary safely.
  const model = resolveRegisteredModel(runtime, selection.provider, selection.model);
  if (!model) {
    throw new Error(
      `Unknown model "${selection.model}" for provider "${selection.provider}". ` +
      'Configure an OpenAI-compatible provider in providers.json or update the canonical model config in models.json.',
    );
  }
  return ensurePurposeInputCapabilities(model, purpose, {
    supportsVision: selection.supportsVision,
  });
}

export function resolveModelSelection(
  config: CoreSubstrateConfig,
  _runtime: ProviderRuntime,
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
  _config: CoreSubstrateConfig,
  runtime: ProviderRuntime,
  selection: MessageModelOverride,
): Model<any> {
  const registered = resolveRegisteredModel(runtime, selection.provider, selection.model);
  if (!registered) {
    throw new Error(
      `Unknown model "${selection.model}" for provider "${selection.provider}". ` +
      'Use a known canonical provider model or configure an OpenAI-compatible provider.',
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
