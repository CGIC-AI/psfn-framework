import type { AgentMessage } from '../../../../boundary/pi-agent/index.js';
import type { LLMProviderWireMessage } from '../../../../shared/contracts/runtime.js';
import { isObjectRecord as isRecord } from '../../../../shared/utils/types.js';
import { convertToLlm } from '../../messages.js';

function serializeMessageContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content);
  return JSON.stringify(content.map(block => (
    isRecord(block) && block.type === 'image'
      ? {
          type: 'image',
          mimeType: typeof block.mimeType === 'string' ? block.mimeType : 'application/octet-stream',
          data: '[omitted]',
        }
      : block
  )));
}

/** Rebuild the message lane from the transcript Pi will actually receive. */
export function rebuildProviderWireMessagesForPrompt(
  existingMessages: readonly LLMProviderWireMessage[],
  historyMessages: readonly AgentMessage[],
  currentPromptMessage: AgentMessage,
): LLMProviderWireMessage[] {
  const systemMessages = existingMessages.filter(message => message.source === 'system_prompt');
  const serializedTranscript = convertToLlm([...historyMessages, currentPromptMessage])
    .map((message): LLMProviderWireMessage => ({
      role: message.role === 'assistant'
        ? 'assistant'
        : message.role === 'toolResult'
          ? 'tool'
          : 'user',
      source: 'message',
      content: serializeMessageContent(message.content),
    }));

  return [
    ...systemMessages,
    ...serializedTranscript,
  ];
}
