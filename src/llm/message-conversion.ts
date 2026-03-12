import type { AssistantMessage, UserMessage } from '@mariozechner/pi-ai';
import type { ContextMessage } from '../types.js';

export type PiChatMessage = UserMessage | AssistantMessage;

export function contextMessagesToPiMessages(
  messages: ContextMessage[],
  timestamp: () => number = () => Date.now(),
): PiChatMessage[] {
  return messages.map((message): PiChatMessage => {
    if (message.role === 'user' || message.role === 'system') {
      return {
        role: 'user',
        content: message.content,
        timestamp: timestamp(),
      } satisfies UserMessage;
    }

    return {
      role: 'assistant',
      content: [{ type: 'text', text: message.content }],
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
      timestamp: timestamp(),
    } satisfies AssistantMessage;
  });
}
