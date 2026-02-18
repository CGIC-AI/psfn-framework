// ── Event Bridge ──
// Bridges pi-agent-core's AgentEvent stream to our EventBus.
// Persistent subscription — set/clear channel around each prompt call.

import type { Agent, AgentEvent } from '@mariozechner/pi-agent-core';
import type { EventBus } from '../event-bus.js';
import { createComponentLogger } from '../logger.js';

const log = createComponentLogger('EventBridge');

export interface EventBridge {
  /** Set the active channel before calling agent.prompt() */
  setChannel(channelId: string): void;
  /** Clear the active channel after prompt completes */
  clearChannel(): void;
  /** Unsubscribe from Agent events */
  destroy(): void;
}

/**
 * Create a persistent bridge from pi-agent-core Agent events to our EventBus.
 *
 * Maps:
 * - message_update (text_delta) → agent.stream.delta
 * - message_update (thinking_delta) → agent.stream.thinking
 * - tool_execution_start → agent.tool.start
 * - tool_execution_end → agent.tool.end
 *
 * Events are only emitted when a channel is active (between setChannel/clearChannel).
 */
export function createEventBridge(agent: Agent, eventBus: EventBus): EventBridge {
  let currentChannelId: string | null = null;

  const unsub = agent.subscribe((event: AgentEvent) => {
    if (!currentChannelId) return;
    const channelId = currentChannelId;

    switch (event.type) {
      case 'message_update': {
        const delta = event.assistantMessageEvent;
        if (delta.type === 'text_delta') {
          eventBus.emit('agent.stream.delta', {
            channelId,
            text: delta.delta,
          }).catch(err => log.warn('EventBus emit failed', { event: 'agent.stream.delta', error: String(err) }));
        } else if (delta.type === 'thinking_delta') {
          eventBus.emit('agent.stream.thinking', {
            channelId,
            text: delta.delta,
          }).catch(err => log.warn('EventBus emit failed', { event: 'agent.stream.thinking', error: String(err) }));
        }
        break;
      }
      case 'tool_execution_start':
        eventBus.emit('agent.tool.start', {
          channelId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
        }).catch(err => log.warn('EventBus emit failed', { event: 'agent.tool.start', error: String(err) }));
        break;
      case 'tool_execution_end':
        eventBus.emit('agent.tool.end', {
          channelId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: event.isError,
        }).catch(err => log.warn('EventBus emit failed', { event: 'agent.tool.end', error: String(err) }));
        break;
    }
  });

  return {
    setChannel(channelId: string) { currentChannelId = channelId; },
    clearChannel() { currentChannelId = null; },
    destroy() { unsub(); },
  };
}
