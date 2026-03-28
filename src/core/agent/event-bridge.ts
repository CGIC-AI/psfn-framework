// ── Event Bridge ──
// Bridges pi-agent-core's AgentEvent stream to our EventBus.
// Persistent subscription — set/clear channel around each prompt call.

import type { Agent, AgentEvent } from '@mariozechner/pi-agent-core';
import type { ToolCall } from '@mariozechner/pi-ai';
import type { EventBus } from '../../shared/event-bus.js';
import type { CorrelationMetadata, ObservabilityCallType } from '../../shared/contracts/runtime.js';
import { createComponentLogger } from '../../shared/logger.js';

const log = createComponentLogger('EventBridge');

export interface EventBridge {
  /** Set the active channel before calling agent.prompt() */
  setChannel(
    channelId: string,
    correlation?: Partial<Pick<
      CorrelationMetadata,
      'turnId' | 'requestId' | 'callType' | 'purpose' | 'originType' | 'originStage'
    >>,
  ): number;
  /** Clear the active channel after prompt completes */
  clearChannel(token?: number): void;
  /** Unsubscribe from Agent events */
  destroy(): void;
}

/**
 * Create a persistent bridge from pi-agent-core Agent events to our EventBus.
 *
 * Maps:
 * - message_update (text_delta) → agent.stream.delta
 * - message_update (thinking_delta) → agent.stream.thinking
 * - message_update (toolcall_start) → agent.toolcall.start
 * - message_update (toolcall_delta) → agent.toolcall.delta
 * - message_update (toolcall_end) → agent.toolcall.end
 * - tool_execution_start → agent.tool.start
 * - tool_execution_end → agent.tool.end
 *
 * Events are only emitted when a channel is active (between setChannel/clearChannel).
 */
export function createEventBridge(agent: Agent, eventBus: EventBus): EventBridge {
  let nextContextToken = 1;
  const contextStack: Array<{
    token: number;
    channelId: string;
    turnId?: string;
    requestId?: string;
    callType?: ObservabilityCallType;
    purpose?: string;
    originType?: ObservabilityCallType;
    originStage?: string;
  }> = [];

  const unsub = agent.subscribe((event: AgentEvent) => {
    const currentContext = contextStack.at(-1);
    if (currentContext === undefined) return;
    const {
      channelId,
      turnId,
      requestId,
      callType,
      purpose,
      originType,
      originStage,
    } = currentContext;
    const shardId = resolveShardId(channelId);
    const withCorrelation = (
      type: 'chat' | 'tool',
      eventPurpose: string,
    ) => ({
      ...(turnId ? { turnId } : {}),
      ...(requestId ? { requestId } : {}),
      callType: type === 'chat' ? (callType ?? 'chat') : 'tool',
      purpose: purpose ?? eventPurpose,
      originType: type === 'chat'
        ? (originType ?? callType ?? 'chat')
        : (originType ?? callType ?? 'tool'),
      originStage: originStage ?? purpose ?? eventPurpose,
    });

    switch (event.type) {
      case 'message_update': {
        const delta = event.assistantMessageEvent;
        if (delta.type === 'text_delta') {
          eventBus.emit('agent.stream.delta', {
            channelId,
            text: delta.delta,
            ...withCorrelation('chat', 'stream_text_delta'),
          }).catch(err => log.warn('EventBus emit failed', { event: 'agent.stream.delta', error: String(err) }));
        } else if (delta.type === 'thinking_delta') {
          eventBus.emit('agent.stream.thinking', {
            channelId,
            text: delta.delta,
            ...withCorrelation('chat', 'stream_thinking_delta'),
          }).catch(err => log.warn('EventBus emit failed', { event: 'agent.stream.thinking', error: String(err) }));
        } else if (delta.type === 'toolcall_start') {
          const toolCall = getToolCallFromPartial(delta.partial, delta.contentIndex);
          eventBus.emit('agent.toolcall.start', {
            channelId,
            contentIndex: delta.contentIndex,
            ...(toolCall?.id ? { toolCallId: toolCall.id } : {}),
            ...(toolCall?.name ? { toolName: toolCall.name } : {}),
            ...(shardId ? { shardId } : {}),
            ...withCorrelation('tool', 'tool_call_stream'),
          }).catch(err => log.warn('EventBus emit failed', { event: 'agent.toolcall.start', error: String(err) }));
        } else if (delta.type === 'toolcall_delta') {
          const toolCall = getToolCallFromPartial(delta.partial, delta.contentIndex);
          eventBus.emit('agent.toolcall.delta', {
            channelId,
            contentIndex: delta.contentIndex,
            delta: delta.delta,
            ...(toolCall?.id ? { toolCallId: toolCall.id } : {}),
            ...(toolCall?.name ? { toolName: toolCall.name } : {}),
            ...(shardId ? { shardId } : {}),
            ...withCorrelation('tool', 'tool_call_stream'),
          }).catch(err => log.warn('EventBus emit failed', { event: 'agent.toolcall.delta', error: String(err) }));
        } else if (delta.type === 'toolcall_end') {
          const toolName = delta.toolCall.name;
          eventBus.emit('agent.toolcall.end', {
            channelId,
            contentIndex: delta.contentIndex,
            toolCallId: delta.toolCall.id,
            toolName,
            arguments: delta.toolCall.arguments as Record<string, unknown>,
            ...(shardId ? { shardId } : {}),
            ...withCorrelation('tool', 'tool_call_stream'),
          }).catch(err => log.warn('EventBus emit failed', { event: 'agent.toolcall.end', error: String(err) }));
        }
        break;
      }
      case 'tool_execution_start': {
        const toolName = event.toolName;
        eventBus.emit('agent.tool.start', {
          channelId,
          toolCallId: event.toolCallId,
          toolName,
          ...(shardId ? { shardId } : {}),
          ...withCorrelation('tool', 'tool_execution'),
        }).catch(err => log.warn('EventBus emit failed', { event: 'agent.tool.start', error: String(err) }));
        break;
      }
      case 'tool_execution_end': {
        const toolName = event.toolName;
        const reportedError = event.isError || hasToolResultError(event.result);
        const errorMessage = extractToolErrorMessage(event.result);
        eventBus.emit('agent.tool.end', {
          channelId,
          toolCallId: event.toolCallId,
          toolName,
          isError: reportedError,
          ...(reportedError && errorMessage ? { errorMessage } : {}),
          ...(shardId ? { shardId } : {}),
          ...withCorrelation('tool', 'tool_execution'),
        }).catch(err => log.warn('EventBus emit failed', { event: 'agent.tool.end', error: String(err) }));
        break;
      }
    }
  });

  return {
    setChannel(
      channelId: string,
      correlation?: Partial<Pick<
        CorrelationMetadata,
        'turnId' | 'requestId' | 'callType' | 'purpose' | 'originType' | 'originStage'
      >>,
    ) {
      const token = nextContextToken++;
      contextStack.push({
        token,
        channelId,
        ...(correlation?.turnId ? { turnId: correlation.turnId } : {}),
        ...(correlation?.requestId ? { requestId: correlation.requestId } : {}),
        ...(correlation?.callType ? { callType: correlation.callType } : {}),
        ...(correlation?.purpose ? { purpose: correlation.purpose } : {}),
        ...(correlation?.originType ? { originType: correlation.originType } : {}),
        ...(correlation?.originStage ? { originStage: correlation.originStage } : {}),
      });
      return token;
    },
    clearChannel(token?: number) {
      if (contextStack.length === 0) {
        return;
      }
      if (token === undefined) {
        contextStack.pop();
        return;
      }
      const index = contextStack.findIndex(entry => entry.token === token);
      if (index === -1) {
        return;
      }
      contextStack.splice(index, 1);
    },
    destroy() {
      contextStack.length = 0;
      unsub();
    },
  };
}

function resolveShardId(channelId: string): string | undefined {
  if (!channelId.startsWith('shard:')) return undefined;
  const shardId = channelId.slice('shard:'.length).trim();
  return shardId.length > 0 ? shardId : undefined;
}

function getToolCallFromPartial(partial: { content?: unknown[] }, contentIndex: number): ToolCall | undefined {
  const block = partial.content?.[contentIndex];
  if (!block || typeof block !== 'object') return undefined;
  if ((block as { type?: string }).type !== 'toolCall') return undefined;
  return block as ToolCall;
}

function hasToolResultError(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== 'object') return false;
  return (details as { isError?: unknown }).isError === true;
}

function extractToolErrorMessage(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const content = (result as { content?: unknown[] }).content;
  if (!Array.isArray(content)) return undefined;
  const textBlock = content.find((entry) => (
    entry
    && typeof entry === 'object'
    && (entry as { type?: unknown }).type === 'text'
    && typeof (entry as { text?: unknown }).text === 'string'
  )) as { text?: string } | undefined;
  const trimmed = textBlock?.text?.trim();
  return trimmed ? trimmed : undefined;
}
