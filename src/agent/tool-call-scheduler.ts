import { validateToolArguments } from '@mariozechner/pi-ai';
import type { AgentMessage, AgentTool } from '@mariozechner/pi-agent-core';
import type { ToolResultMessage } from '@mariozechner/pi-ai';
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
      ? await executeParallelBatch(batch, parallelLimit, context)
      : await executeSequentialBatch(batch, context, getSteeringMessages);

    results.push(...batchResults.toolResults);
    steeringMessages = batchResults.steeringMessages;
    index += batch.length;

    if (steeringMessages && steeringMessages.length > 0) {
      const remainingDescriptors = descriptors.slice(index);
      options.onTelemetry?.('agent.tools.scheduler.skipped', {
        reason: 'queued_user_message',
        skippedCount: remainingDescriptors.length,
        skippedTools: remainingDescriptors.map((entry) => entry.toolCall.name),
      });
      for (const descriptor of remainingDescriptors) {
        results.push(skipToolCall(descriptor.toolCall, context.stream));
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
): Promise<ToolExecutionResult> {
  const results: ToolResultMessage[] = [];
  for (const descriptor of descriptors) {
    const result = await executeSingleToolCall(descriptor, context);
    results.push(result);

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
): Promise<ToolExecutionResult> {
  const results = await mapBounded(
    descriptors,
    parallelLimit,
    async (descriptor) => executeSingleToolCall(descriptor, context),
  );

  return {
    toolResults: results,
  };
}

async function executeSingleToolCall(
  descriptor: ToolCallDescriptor,
  context: ToolExecutionContext,
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
    result = {
      content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
      details: {},
    };
    isError = true;
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

function skipToolCall(toolCall: any, stream: { push: (event: any) => void }): ToolResultMessage {
  const result = {
    content: [{ type: 'text', text: 'Skipped due to queued user message.' }],
    details: {},
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

function collectCompatibleBatch(descriptors: ToolCallDescriptor[], startIndex: number): ToolCallDescriptor[] {
  const first = descriptors[startIndex];
  if (!first) return [];
  if (first.metadata.class === 'exclusive') {
    return [first];
  }

  const batch: ToolCallDescriptor[] = [first];
  for (let index = startIndex + 1; index < descriptors.length; index += 1) {
    const candidate = descriptors[index];
    if (!candidate || !canRunConcurrently(first, candidate)) {
      break;
    }
    batch.push(candidate);
  }
  return batch;
}

function canRunConcurrently(a: ToolCallDescriptor, b: ToolCallDescriptor): boolean {
  return a.metadata.class === 'spawn_shard' && b.metadata.class === 'spawn_shard';
}

function resolveBatchParallelLimit(batch: ToolCallDescriptor[], maxParallelToolCalls: number): number {
  const boundedGlobal = Number.isFinite(maxParallelToolCalls)
    ? Math.max(1, Math.floor(maxParallelToolCalls))
    : 1;
  const boundedByMetadata = batch.reduce((current, descriptor) => {
    const candidate = descriptor.metadata.maxParallel;
    if (!candidate || !Number.isFinite(candidate) || candidate < 1) {
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
      metadata: { class: 'exclusive', exclusivityKey: 'tool' },
      issue: 'missing',
    };
  }

  const concurrency = (tool as WirableTool).wiringMeta?.concurrency;
  if (!concurrency) {
    return {
      metadata: { class: 'exclusive', exclusivityKey: `tool:${tool.name}` },
      issue: 'missing',
    };
  }
  if (
    concurrency.class !== 'exclusive'
    && concurrency.class !== 'read_only'
    && concurrency.class !== 'spawn_shard'
  ) {
    return {
      metadata: { class: 'exclusive', exclusivityKey: `tool:${tool.name}` },
      issue: 'invalid',
    };
  }

  if (
    concurrency.class === 'exclusive'
    && (!concurrency.exclusivityKey || concurrency.exclusivityKey.trim().length === 0)
  ) {
    return {
      metadata: { class: 'exclusive', exclusivityKey: `tool:${tool.name}` },
      issue: 'invalid',
    };
  }

  if (
    concurrency.maxParallel !== undefined
    && (!Number.isFinite(concurrency.maxParallel) || concurrency.maxParallel < 1)
  ) {
    return {
      metadata: { class: 'exclusive', exclusivityKey: `tool:${tool.name}` },
      issue: 'invalid',
    };
  }

  return {
    metadata: { ...concurrency },
  };
}
