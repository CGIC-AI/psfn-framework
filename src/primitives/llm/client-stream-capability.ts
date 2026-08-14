import type {
  AssistantMessage as PiAssistantMessage,
  Context as PiContext,
  Model,
} from '@earendil-works/pi-ai';
import type {
  LLMProviderObservability,
  LLMResponse,
  LLMUsageDetails,
  StreamCallbacks,
  ToolCall,
} from '../../shared/contracts/runtime.js';
import type { ResolvedCorrelationMetadata } from './correlation.js';
import type { RoutingCandidate } from './routing.js';
import type { LLMRequestOptions } from './client-request-capability.js';
import type { ProviderRuntime } from './provider-runtime.js';
import {
  extractReasoningContent,
  extractTextContent,
} from './conversion.js';
import {
  assertNoProviderResponsePrefixArtifact,
  assertUsableProviderResponse,
  createProviderResponseTerminatorFilter,
  extractToolCallsFromContentBlocks,
  isPotentialProviderResponsePrefixArtifact,
  normalizeContent,
  normalizeLLMUsageDetails,
  resolveEmptyToolArgumentUsageMetadata,
  stripProviderResponseTerminatorArtifact,
} from './client-response-helpers.js';
import { countMessageTokens } from './tokens.js';
import { monotonicEpochNowMs } from '../../shared/telemetry/turn-performance.js';
import { markErrorAsNonRetryable } from './retry.js';
import { logEmptyToolArgumentProvenance } from './empty-tool-argument-retry.js';
import { createComponentLogger } from '../../shared/logger.js';
import {
  selectExplicitToolContractCall,
} from './explicit-tool-request.js';

const log = createComponentLogger('LLMClient');

interface StreamUsageRecordOptions {
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
  providerObservability: LLMProviderObservability;
  metadata: Record<string, unknown>;
}

export interface StreamUsageRecord {
  inputTokens: number;
  outputTokens: number;
  usageDetails: LLMUsageDetails | undefined;
  options: StreamUsageRecordOptions;
}

export interface RunLLMStreamAttemptInput {
  runtime: ProviderRuntime;
  model: Model<any>;
  context: PiContext;
  requestOptions: LLMRequestOptions;
  candidate: RoutingCandidate;
  callbacks?: StreamCallbacks;
  accountingInputTokens: number;
  transportSignal: AbortSignal;
  attemptIndex: number;
  usageAttempt: number;
  logicalCallId: string;
  requestedProvider: string;
  requestedModel: string;
  providerObservability: LLMProviderObservability;
  correlation: ResolvedCorrelationMetadata | undefined;
  deferMissingRequiredToolCall?: boolean;
  reserveCost: () => Promise<void>;
  recordUsage: (record: StreamUsageRecord) => Promise<void>;
  throwIfAborted: () => void;
}

function hasSubstantiveToolCallIdentity(
  partial: PiAssistantMessage,
  contentIndex: number,
): boolean {
  const block = partial.content.at(contentIndex);
  return block?.type === 'toolCall'
    && block.id.trim().length > 0
    && block.name.trim().length > 0;
}

/** Owns the pi-ai streaming decode state machine and its usage/error settlement order. */
export async function runLLMStreamAttempt(
  input: RunLLMStreamAttemptInput,
): Promise<LLMResponse> {
  const attemptStartedAtMs = Date.now();
  await input.reserveCost();
  let attemptFirstTokenAtMs: number | undefined;
  const markFirstOutput = (kind: 'text' | 'thinking' | 'tool'): void => {
    if (attemptFirstTokenAtMs !== undefined) return;
    const timestampMs = Date.now();
    attemptFirstTokenAtMs = timestampMs;
    input.callbacks?.onFirstOutput?.({
      kind,
      monotonicAtMs: monotonicEpochNowMs(),
      timestampMs,
    });
  };
  const usageOptions = (
    inputOptions: Omit<StreamUsageRecordOptions, 'startedAtMs' | 'completedAtMs'
      | 'attempt' | 'logicalCallId' | 'requestedProvider' | 'requestedModel'
      | 'providerObservability'>,
  ): StreamUsageRecordOptions => ({
    startedAtMs: attemptStartedAtMs,
    completedAtMs: Date.now(),
    ...(attemptFirstTokenAtMs !== undefined
      ? { ttftMs: Math.max(0, attemptFirstTokenAtMs - attemptStartedAtMs) }
      : {}),
    attempt: input.usageAttempt,
    logicalCallId: input.logicalCallId,
    requestedProvider: input.requestedProvider,
    requestedModel: input.requestedModel,
    providerObservability: input.providerObservability,
    ...inputOptions,
  });

  const eventStream = input.runtime.stream(
    input.model,
    input.context,
    input.requestOptions,
  );

  let content = '';
  let reasoning = '';
  const toolCalls: ToolCall[] = [];
  let response: LLMResponse | null = null;
  let emittedData = false;
  let processedTextLength = 0;
  let sawTextDelta = false;
  let providerCompleted = false;
  let rawUsageEvidence: unknown;
  const responseTerminatorFilter = createProviderResponseTerminatorFilter(input.candidate);
  // Total raw tool-argument-fragment bytes observed across the whole stream.
  // This preserves provider_emitted_empty vs stream_parse_dropped provenance.
  let toolArgumentFragmentBytes = 0;

  try {
    for await (const event of eventStream) {
      switch (event.type) {
        case 'text_delta':
          if (event.delta.length > 0) markFirstOutput('text');
          sawTextDelta = true;
          content += event.delta;
          assertNoProviderResponsePrefixArtifact(content, input.candidate);
          if (isPotentialProviderResponsePrefixArtifact(content)) {
            break;
          }
          {
            const unprocessed = content.slice(processedTextLength);
            processedTextLength = content.length;
            const visibleDelta = responseTerminatorFilter.push(unprocessed);
            if (visibleDelta) {
              emittedData = true;
              input.callbacks?.onText?.(visibleDelta);
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
          input.callbacks?.onToolCall?.(event.toolCall.name, event.toolCall.arguments);
          break;

        case 'done': {
          providerCompleted = true;
          rawUsageEvidence = event.message.usage;
          const contentBlocks = event.message.content as unknown[];
          const finalTextContent = extractTextContent(contentBlocks);
          if (!content || (isPotentialProviderResponsePrefixArtifact(content) && finalTextContent)) {
            content = finalTextContent;
          }
          if (!reasoning) {
            reasoning = extractReasoningContent(contentBlocks);
          }
          const finalToolCalls = extractToolCallsFromContentBlocks(contentBlocks);
          content = normalizeContent(content);
          assertNoProviderResponsePrefixArtifact(content, input.candidate);
          if (sawTextDelta && content.length > processedTextLength) {
            const unprocessed = content.slice(processedTextLength);
            processedTextLength = content.length;
            const visibleDelta = responseTerminatorFilter.push(unprocessed);
            if (visibleDelta) {
              emittedData = true;
              input.callbacks?.onText?.(visibleDelta);
            }
          }
          if (sawTextDelta) {
            const visibleTail = responseTerminatorFilter.finish();
            if (visibleTail) {
              emittedData = true;
              input.callbacks?.onText?.(visibleTail);
            }
          }
          content = stripProviderResponseTerminatorArtifact(content, input.candidate);
          const usageDetails = normalizeLLMUsageDetails(
            event.message.usage,
            event.message.usage.input,
            event.message.usage.output,
          );
          response = {
            content,
            ...(reasoning ? { reasoning } : {}),
            providerObservability: input.providerObservability,
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
    const withheldText = responseTerminatorFilter.flush();
    if (withheldText) {
      emittedData = true;
      input.callbacks?.onText?.(withheldText);
    }
    const err = error instanceof Error ? error : new Error(String(error));
    if (emittedData) {
      markErrorAsNonRetryable(err);
    }
    const partialOutput = `${content}${reasoning}`;
    const partialUsage = emittedData && !providerCompleted
      ? normalizeLLMUsageDetails(
          undefined,
          input.accountingInputTokens,
          Math.max(1, countMessageTokens([{ role: 'assistant', content: partialOutput }])),
        )
      : undefined;
    await input.recordUsage({
      inputTokens: partialUsage?.input ?? 0,
      outputTokens: partialUsage?.output ?? 0,
      usageDetails: partialUsage,
      options: usageOptions({
        status: 'failure',
        settlement: providerCompleted ? 'complete' : emittedData ? 'partial' : 'unknown',
        error: err,
        metadata: {
          emptyToolArgsAttempt: input.attemptIndex,
          emptyArgsRetries: input.attemptIndex,
          partialOutputChars: partialOutput.length,
          ...(providerCompleted ? { malformedRawUsage: rawUsageEvidence } : {}),
        },
      }),
    });
    throw err;
  }

  const cancelledAfterCompletion = input.transportSignal.aborted;
  if (response) {
    try {
      assertUsableProviderResponse(response, input.candidate);
      response.toolCalls = selectExplicitToolContractCall({
        choice: input.requestOptions.toolChoice,
        ...(input.requestOptions.requiredToolName
          ? { requiredToolName: input.requestOptions.requiredToolName }
          : {}),
        toolCalls: response.toolCalls,
        ...(input.deferMissingRequiredToolCall ? { deferMissingRequiredCall: true } : {}),
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      markErrorAsNonRetryable(err);
      await input.recordUsage({
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        usageDetails: response.usageDetails,
        options: usageOptions({
          status: 'failure',
          settlement: 'complete',
          error: err,
          metadata: {
            emptyToolArgsAttempt: input.attemptIndex,
            emptyArgsRetries: input.attemptIndex,
          },
        }),
      });
      throw err;
    }
    logEmptyToolArgumentProvenance(
      response.toolCalls,
      toolArgumentFragmentBytes,
      input.candidate,
      input.correlation,
      input.attemptIndex,
    );
    await input.recordUsage({
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      usageDetails: response.usageDetails,
      options: usageOptions({
        status: 'success',
        settlement: 'complete',
        stopReason: response.stopReason,
        metadata: {
          emptyToolArgsAttempt: input.attemptIndex,
          emptyArgsRetries: input.attemptIndex,
          toolCallCount: response.toolCalls.length,
          ...resolveEmptyToolArgumentUsageMetadata(
            response.toolCalls,
            toolArgumentFragmentBytes,
          ),
          ...(cancelledAfterCompletion ? { cancelledAfterCompletion: true } : {}),
        },
      }),
    });
    input.throwIfAborted();
    return response;
  }

  const visibleTail = responseTerminatorFilter.finish();
  if (visibleTail) {
    input.callbacks?.onText?.(visibleTail);
  }
  content = stripProviderResponseTerminatorArtifact(content, input.candidate);
  log.warn('Stream completed without done event', {
    model: String(input.model.id),
    hasContent: !!content,
  });
  const incompleteUsage = normalizeLLMUsageDetails(
    undefined,
    input.accountingInputTokens,
    Math.max(1, countMessageTokens([{ role: 'assistant', content: `${content}${reasoning}` }])),
  );
  const incompleteResponse: LLMResponse = {
    content,
    ...(reasoning ? { reasoning } : {}),
    providerObservability: input.providerObservability,
    toolCalls,
    model: String(input.model.id),
    inputTokens: incompleteUsage.input,
    outputTokens: incompleteUsage.output,
    usageDetails: incompleteUsage,
    stopReason: 'unknown',
  };
  assertUsableProviderResponse(incompleteResponse, input.candidate);
  incompleteResponse.toolCalls = selectExplicitToolContractCall({
    choice: input.requestOptions.toolChoice,
    ...(input.requestOptions.requiredToolName
      ? { requiredToolName: input.requestOptions.requiredToolName }
      : {}),
    toolCalls: incompleteResponse.toolCalls,
  });
  await input.recordUsage({
    inputTokens: incompleteUsage.input,
    outputTokens: incompleteUsage.output,
    usageDetails: incompleteUsage,
    options: usageOptions({
      status: 'success',
      settlement: 'partial',
      stopReason: 'unknown',
      metadata: {
        emptyToolArgsAttempt: input.attemptIndex,
        emptyArgsRetries: input.attemptIndex,
        partialOutputChars: content.length + reasoning.length,
        ...resolveEmptyToolArgumentUsageMetadata(
          incompleteResponse.toolCalls,
          toolArgumentFragmentBytes,
        ),
        ...(cancelledAfterCompletion ? { cancelledAfterCompletion: true } : {}),
      },
    }),
  });
  input.throwIfAborted();
  return incompleteResponse;
}
