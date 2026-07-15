import type { AgentMessage } from '../../../../boundary/pi-agent/index.js';
import type { LLMProviderWireMessage, LLMSystemPromptTransport } from '../../../../shared/contracts/runtime.js';
import { isObjectRecord as isRecord } from '../../../../shared/utils/types.js';
import { contextMessagesToPiMessages } from '../../../../primitives/llm/message-conversion.js';
import { convertToLlm } from '../../messages.js';
import { serializePromptPlanForProvider, type PromptPlan } from './prompt-plan.js';

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

/**
 * Reconstruct the provider wire messages from a persisted turn snapshot's
 * canonical fields, exactly the way the runtime captured them at write time
 * (agent-invocation.ts): serialize the plan for the recorded transport to seed
 * the system lane, convert plan.messages into the provider history, and append
 * the current turn from promptContext.currentTurnInput.
 *
 * SINGLE SOURCE for both sides of the slimming contract (bead hgw3.3):
 *   - the Garden read path derives the wire view for slim records from this;
 *   - the persist path drops the embedded copy only when it is byte-equal to
 *     this derivation (so group-attribution, system-speaker, MoA, and vision
 *     turn shapes — where the shipped current message diverges from
 *     currentTurnInput — keep the embedded capture).
 */
export function deriveProviderWireMessagesForTurnSnapshot(input: {
  plan: Pick<PromptPlan, 'blocks' | 'messages'>;
  transport: LLMSystemPromptTransport;
  currentTurnInput: string | undefined;
}): LLMProviderWireMessage[] {
  const seededWireMessages = serializePromptPlanForProvider(input.plan, input.transport).providerWireMessages;
  const historyMessages = contextMessagesToPiMessages(input.plan.messages);
  const currentPromptMessage: AgentMessage = {
    role: 'user',
    content: input.currentTurnInput ?? '',
    timestamp: 0,
  };
  return rebuildProviderWireMessagesForPrompt(seededWireMessages, historyMessages, currentPromptMessage);
}
