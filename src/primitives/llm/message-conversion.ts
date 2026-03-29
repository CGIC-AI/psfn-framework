import type { AssistantMessage, UserMessage } from '@mariozechner/pi-ai';
import type { ContextMessage } from '../../shared/contracts/runtime.js';

export type PiChatMessage = UserMessage | AssistantMessage;

function createInternalAssistantMessage(
  content: string,
  timestamp: number,
): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: content }],
    api: '',
    provider: '',
    model: '',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp,
  };
}

export function contextMessagesToPiMessages(
  messages: ContextMessage[],
  timestamp: () => number = () => Date.now(),
): PiChatMessage[] {
  return messages.map((message): PiChatMessage => {
    if (message.role === 'user' || message.role === 'system') {
      if (message.role === 'system') {
        return createInternalAssistantMessage(message.content, timestamp());
      }

      return {
        role: 'user',
        content: message.content,
        timestamp: timestamp(),
      } satisfies UserMessage;
    }

    return createInternalAssistantMessage(message.content, timestamp());
  });
}
