import type { AssistantMessage, UserMessage } from '@mariozechner/pi-ai';
import type { ContextMessage } from '../../shared/contracts/runtime.js';

export type PiChatMessage = UserMessage | AssistantMessage;
const SYSTEM_CONTEXT_OPEN_TAG = '<session_context>';
const SYSTEM_CONTEXT_CLOSE_TAG = '</session_context>';

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

function getSystemContextContents(messages: readonly ContextMessage[]): string[] {
  return messages
    .filter(message => message.role === 'system' && message.content.trim().length > 0)
    .map(message => message.content);
}

export function buildSystemContextPromptBlock(messages: readonly ContextMessage[]): string {
  const systemContextContents = getSystemContextContents(messages);
  if (systemContextContents.length === 0) {
    return '';
  }

  return [
    SYSTEM_CONTEXT_OPEN_TAG,
    ...systemContextContents,
    SYSTEM_CONTEXT_CLOSE_TAG,
  ].join('\n\n');
}

export function mergeSystemContextIntoSystemPrompt(
  systemPrompt: string,
  messages: readonly ContextMessage[],
): string {
  const systemContextBlock = buildSystemContextPromptBlock(messages);
  if (!systemContextBlock) {
    return systemPrompt;
  }

  const sections = [systemPrompt, systemContextBlock]
    .filter(section => section.trim().length > 0);

  return sections.join('\n\n');
}

export function contextMessagesToPiMessages(
  messages: ContextMessage[],
  timestamp: () => number = () => Date.now(),
): PiChatMessage[] {
  return messages.flatMap((message): PiChatMessage[] => {
    if (message.role === 'system') {
      return [];
    }
    if (message.role === 'user') {
      return [{
        role: 'user',
        content: message.content,
        timestamp: timestamp(),
      } satisfies UserMessage];
    }

    return [createInternalAssistantMessage(message.content, timestamp())];
  });
}
