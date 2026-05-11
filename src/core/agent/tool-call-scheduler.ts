import { validateToolArguments } from '@mariozechner/pi-ai';
import type { AgentMessage, AgentTool } from '@mariozechner/pi-agent-core';
import type { ToolResultMessage } from '@mariozechner/pi-ai';
import { isInternalWhisperMessage, isSystemNoteMessage } from './messages.js';
import type { ToolConcurrencyMeta, WirableTool } from './tool-wiring-validator.js';

export interface ToolCallSchedulerOptions {
  maxParallelToolCalls: number;
  onTelemetry?: (eventName: string, payload: Record<string, unknown>) => void;
}

interface ToolCallDescriptor {
  toolCall: any;
  tool: AgentTool<any> | undefined;
  metadata: ToolConcurrencyMeta;
  metadataIssue?: 'missing' | 'invalid';
}

interface ToolExecutionContext {
  signal?: AbortSignal;
  stream: { push: (event: any) => void };
}

export interface ToolExecutionResult {
  toolResults: ToolResultMessage[];
  steeringMessages?: AgentMessage[];
  haltRemaining?: boolean;
  haltReasonText?: string;
}

type QueuedMessageSkipReason =
  | 'queued_user_message'
  | 'queued_system_message'
  | 'queued_internal_note'
  | 'queued_message';

interface QueuedMessageAttribution {
  telemetryReason: QueuedMessageSkipReason;
  resultText: string;
}

export async function executeToolCallsWithScheduler(
  tools: AgentTool<any>[] | undefined,
  assistantMessage: any,
  getSteeringMessages: (() => Promise<AgentMessage[]>) | undefined,
  context: ToolExecutionContext,
  options: ToolCallSchedulerOptions,
): Promise<ToolExecutionResult> {
  const toolCalls = assistantMessage.content.filter((content: any) => content.type === 'toolCall');
  const descriptors = toolCalls.map((toolCall: any): ToolCallDescriptor => {
    const tool = tools?.find((entry) => entry.name === toolCall.name);
    const resolved = resolveToolConcurrencyMetadata(tool);
    return {
      toolCall,
      tool,
      metadata: resolved.metadata,
      metadataIssue: resolved.issue,
    };
  });

  const results: ToolResultMessage[] = [];
  let steeringMessages: AgentMessage[] | undefined;

  for (let index = 0; index < descriptors.length;) {
    const batch = collectCompatibleBatch(descriptors, index);
    const remainingCount = descriptors.length - (index + batch.length);
    const parallelLimit = resolveBatchParallelLimit(batch, options.maxParallelToolCalls);
    const mode = batch.length > 1 && parallelLimit > 1 ? 'parallel' : 'sequential';

    if (remainingCount > 0) {
      options.onTelemetry?.('agent.tools.scheduler.queued', {
        queuedCount: remainingCount,
        activeBatchSize: batch.length,
        activeTools: batch.map((entry) => entry.toolCall.name),
      });
    }
    options.onTelemetry?.(
      mode === 'parallel' ? 'agent.tools.scheduler.parallel' : 'agent.tools.scheduler.serialized',
      {
        batchSize: batch.length,
        parallelLimit,
        toolNames: batch.map((entry) => entry.toolCall.name),
      },
    );

    options.onTelemetry?.('agent.tools.scheduler.batch', {
      mode,
      batchSize: batch.length,
      parallelLimit,
      queuedRemaining: remainingCount,
      toolNames: batch.map((entry) => entry.toolCall.name),
      classes: batch.map((entry) => entry.metadata.class),
      missingMetadataCount: batch.filter((entry) => entry.metadataIssue === 'missing').length,
      invalidMetadataCount: batch.filter((entry) => entry.metadataIssue === 'invalid').length,
    });

    const batchResults = mode === 'parallel'
      ? await executeParallelBatch(batch, parallelLimit, context, options)
      : await executeSequentialBatch(batch, context, getSteeringMessages, options);

    results.push(...batchResults.toolResults);
    steeringMessages = batchResults.steeringMessages;
    index += batch.length;

    if (batchResults.haltRemaining) {
      const remainingDescriptors = descriptors.slice(index);
      if (remainingDescriptors.length > 0) {
        const resultText = batchResults.haltReasonText
          ?? 'Skipped because an earlier sequential tool call failed. Read the tool result and retry only the needed follow-up call.';
        options.onTelemetry?.('agent.tools.scheduler.skipped', {
          reason: 'prior_tool_error',
          skippedCount: remainingDescriptors.length,
          skippedTools: remainingDescriptors.map((entry: ToolCallDescriptor) => entry.toolCall.name),
        });
        for (const descriptor of remainingDescriptors) {
          results.push(skipToolCall(descriptor.toolCall, context.stream, resultText));
        }
      }
      break;
    }

    if (steeringMessages && steeringMessages.length > 0) {
      const remainingDescriptors = descriptors.slice(index);
      const attribution = resolveQueuedMessageAttribution(steeringMessages);
      options.onTelemetry?.('agent.tools.scheduler.skipped', {
        reason: attribution.telemetryReason,
        skippedCount: remainingDescriptors.length,
        skippedTools: remainingDescriptors.map((entry: ToolCallDescriptor) => entry.toolCall.name),
      });
      for (const descriptor of remainingDescriptors) {
        results.push(skipToolCall(descriptor.toolCall, context.stream, attribution.resultText));
      }
      break;
    }
  }

  return {
    toolResults: results,
    steeringMessages,
  };
}

async function executeSequentialBatch(
  descriptors: ToolCallDescriptor[],
  context: ToolExecutionContext,
  getSteeringMessages: (() => Promise<AgentMessage[]>) | undefined,
  options: ToolCallSchedulerOptions,
): Promise<ToolExecutionResult> {
  const results: ToolResultMessage[] = [];
  for (const descriptor of descriptors) {
    const result = await executeSingleToolCall(descriptor, context, options);
    results.push(result);
    if (result.isError) {
      return {
        toolResults: results,
        haltRemaining: true,
        haltReasonText: 'Skipped because an earlier sequential tool call failed. Read the tool result and retry only the needed follow-up call.',
      };
    }

    if (getSteeringMessages) {
      const steeringMessages = await getSteeringMessages();
      if (steeringMessages.length > 0) {
        return {
          toolResults: results,
          steeringMessages,
        };
      }
    }
  }

  return { toolResults: results };
}

async function executeParallelBatch(
  descriptors: ToolCallDescriptor[],
  parallelLimit: number,
  context: ToolExecutionContext,
  options: ToolCallSchedulerOptions,
): Promise<ToolExecutionResult> {
  const results = await mapBounded(
    descriptors,
    parallelLimit,
    async (descriptor) => executeSingleToolCall(descriptor, context, options),
  );

  return {
    toolResults: results,
  };
}

async function executeSingleToolCall(
  descriptor: ToolCallDescriptor,
  context: ToolExecutionContext,
  options: ToolCallSchedulerOptions,
): Promise<ToolResultMessage> {
  const { toolCall, tool } = descriptor;
  context.stream.push({
    type: 'tool_execution_start',
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    args: toolCall.arguments,
  });

  let result: { content: any[]; details: any };
  let isError = false;
  let cancelled = false;
  try {
    if (!tool) {
      throw new Error(`Tool ${toolCall.name} not found`);
    }
    const validatedArgs = validateToolArguments(tool, toolCall);
    result = await tool.execute(toolCall.id, validatedArgs, context.signal, (partialResult) => {
      context.stream.push({
        type: 'tool_execution_update',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        args: toolCall.arguments,
        partialResult,
      });
    });
  } catch (error) {
    cancelled = context.signal?.aborted === true
      || (error instanceof Error && /abort(ed)?/i.test(error.message));
    result = {
      content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
      details: {},
    };
    isError = true;
  }

  if (cancelled) {
    options.onTelemetry?.('agent.tools.scheduler.cancelled', {
      toolName: toolCall.name,
      toolCallId: toolCall.id,
    });
  }

  context.stream.push({
    type: 'tool_execution_end',
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    result,
    isError,
  });

  const toolResultMessage: ToolResultMessage = {
    role: 'toolResult',
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: result.content,
    details: result.details,
    isError,
    timestamp: Date.now(),
  };
  context.stream.push({ type: 'message_start', message: toolResultMessage });
  context.stream.push({ type: 'message_end', message: toolResultMessage });
  return toolResultMessage;
}

function skipToolCall(
  toolCall: any,
  stream: { push: (event: any) => void },
  reasonText: string,
): ToolResultMessage {
  const result = {
    content: [{ type: 'text' as const, text: reasonText }],
    details: {} as Record<string, unknown>,
  };
  stream.push({
    type: 'tool_execution_start',
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    args: toolCall.arguments,
  });
  stream.push({
    type: 'tool_execution_end',
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    result,
    isError: true,
  });

  const toolResultMessage: ToolResultMessage = {
    role: 'toolResult',
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: result.content,
    details: {},
    isError: true,
    timestamp: Date.now(),
  };
  stream.push({ type: 'message_start', message: toolResultMessage });
  stream.push({ type: 'message_end', message: toolResultMessage });
  return toolResultMessage;
}

function resolveQueuedMessageAttribution(messages: readonly AgentMessage[]): QueuedMessageAttribution {
  if (messages.some(message => (message as { role?: string }).role === 'user')) {
    return {
      telemetryReason: 'queued_user_message',
      resultText: 'Skipped due to queued user message.',
    };
  }
  if (messages.some(isSystemNoteMessage)) {
    return {
      telemetryReason: 'queued_system_message',
      resultText: 'Skipped due to queued system message.',
    };
  }
  if (messages.some(isInternalWhisperMessage)) {
    return {
      telemetryReason: 'queued_internal_note',
      resultText: 'Skipped due to queued internal note.',
    };
  }
  return {
    telemetryReason: 'queued_message',
    resultText: 'Skipped due to queued message.',
  };
}

function collectCompatibleBatch(descriptors: ToolCallDescriptor[], startIndex: number): ToolCallDescriptor[] {
  const first = descriptors[startIndex];
  if (first.metadata.class === 'exclusive') {
    return [first];
  }

  const batch: ToolCallDescriptor[] = [first];
  for (let index = startIndex + 1; index < descriptors.length; index += 1) {
    const candidate = descriptors[index];
    if (
      batch.some((entry) => !canRunConcurrently(entry, candidate))
    ) {
      break;
    }
    batch.push(candidate);
  }
  return batch;
}

function canRunConcurrently(a: ToolCallDescriptor, b: ToolCallDescriptor): boolean {
  if (a.metadataIssue || b.metadataIssue) {
    return false;
  }
  if (a.metadata.class !== b.metadata.class) {
    return false;
  }
  if (a.metadata.class !== 'spawn_subagent') {
    return false;
  }
  if (
    a.metadata.exclusivityKeyPolicy !== 'none'
    || b.metadata.exclusivityKeyPolicy !== 'none'
    || a.metadata.exclusivityKey !== undefined
    || b.metadata.exclusivityKey !== undefined
  ) {
    return false;
  }
  return true;
}

function resolveBatchParallelLimit(batch: ToolCallDescriptor[], maxParallelToolCalls: number): number {
  const boundedGlobal = Number.isFinite(maxParallelToolCalls)
    ? Math.max(1, Math.floor(maxParallelToolCalls))
    : 1;
  const boundedByMetadata = batch.reduce((current, descriptor) => {
    const candidate = descriptor.metadata.maxParallel;
    if (!candidate || !Number.isInteger(candidate) || candidate < 1) {
      return current;
    }
    return Math.min(current, Math.floor(candidate));
  }, boundedGlobal);
  return Math.max(1, Math.min(boundedGlobal, boundedByMetadata));
}

async function mapBounded<TInput, TOutput>(
  items: readonly TInput[],
  concurrencyLimit: number,
  mapper: (item: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  const limit = Math.max(1, Math.floor(concurrencyLimit));
  const results: TOutput[] = new Array(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const currentIndex = nextIndex;
      if (currentIndex >= items.length) {
        return;
      }
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex] as TInput, currentIndex);
    }
  });

  await Promise.all(workers);
  return results;
}

function resolveToolConcurrencyMetadata(
  tool: AgentTool<any> | undefined,
): { metadata: ToolConcurrencyMeta; issue?: 'missing' | 'invalid' } {
  if (!tool) {
    return {
      metadata: createFailClosedConcurrencyMetadata('tool'),
      issue: 'missing',
    };
  }

  const concurrency = (tool as WirableTool).wiringMeta?.concurrency as Partial<ToolConcurrencyMeta> | undefined;
  if (!concurrency) {
    return {
      metadata: createFailClosedConcurrencyMetadata(`tool:${tool.name}`),
      issue: 'missing',
    };
  }
  if (
    concurrency.class !== 'exclusive'
    && concurrency.class !== 'read_only'
    && concurrency.class !== 'spawn_subagent'
  ) {
    return {
      metadata: createFailClosedConcurrencyMetadata(`tool:${tool.name}`),
      issue: 'invalid',
    };
  }

  if (
    concurrency.exclusivityKeyPolicy !== 'none'
    && concurrency.exclusivityKeyPolicy !== 'category_tool_name'
    && concurrency.exclusivityKeyPolicy !== 'static_key'
  ) {
    return {
      metadata: createFailClosedConcurrencyMetadata(`tool:${tool.name}`),
      issue: 'invalid',
    };
  }

  if (
    concurrency.class === 'exclusive'
    && (!concurrency.exclusivityKey || concurrency.exclusivityKey.trim().length === 0)
  ) {
    return {
      metadata: createFailClosedConcurrencyMetadata(`tool:${tool.name}`),
      issue: 'invalid',
    };
  }

  if (
    concurrency.class === 'exclusive'
    && concurrency.exclusivityKeyPolicy === 'none'
  ) {
    return {
      metadata: createFailClosedConcurrencyMetadata(`tool:${tool.name}`),
      issue: 'invalid',
    };
  }

  if (
    concurrency.class !== 'exclusive'
    && concurrency.exclusivityKeyPolicy !== 'none'
  ) {
    return {
      metadata: createFailClosedConcurrencyMetadata(`tool:${tool.name}`),
      issue: 'invalid',
    };
  }

  if (
    concurrency.class !== 'exclusive'
    && concurrency.exclusivityKey !== undefined
  ) {
    return {
      metadata: createFailClosedConcurrencyMetadata(`tool:${tool.name}`),
      issue: 'invalid',
    };
  }

  if (
    concurrency.maxParallel !== undefined
    && (!Number.isInteger(concurrency.maxParallel) || concurrency.maxParallel < 1)
  ) {
    return {
      metadata: createFailClosedConcurrencyMetadata(`tool:${tool.name}`),
      issue: 'invalid',
    };
  }

  if (
    concurrency.interruptibility !== 'cooperative'
    && concurrency.interruptibility !== 'non_interruptible'
  ) {
    return {
      metadata: createFailClosedConcurrencyMetadata(`tool:${tool.name}`),
      issue: 'invalid',
    };
  }

  if (
    !concurrency.eligibility
    || typeof concurrency.eligibility.foreground !== 'boolean'
    || typeof concurrency.eligibility.background !== 'boolean'
    || (!concurrency.eligibility.foreground && !concurrency.eligibility.background)
  ) {
    return {
      metadata: createFailClosedConcurrencyMetadata(`tool:${tool.name}`),
      issue: 'invalid',
    };
  }

  return {
    metadata: {
      class: concurrency.class,
      exclusivityKeyPolicy: concurrency.exclusivityKeyPolicy,
      ...(concurrency.exclusivityKey !== undefined ? { exclusivityKey: concurrency.exclusivityKey } : {}),
      ...(concurrency.maxParallel !== undefined ? { maxParallel: concurrency.maxParallel } : {}),
      interruptibility: concurrency.interruptibility,
      eligibility: { ...concurrency.eligibility },
    },
  };
}

function createFailClosedConcurrencyMetadata(exclusivityKey: string): ToolConcurrencyMeta {
  return {
    class: 'exclusive',
    exclusivityKeyPolicy: 'static_key',
    exclusivityKey,
    interruptibility: 'cooperative',
    eligibility: {
      foreground: true,
      background: true,
    },
  };
}
