import type { AssistantMessage } from '@mariozechner/pi-ai';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';

interface AgentStateRuntimeLogger {
  warn(message: string, payload?: Record<string, unknown>): void;
}

export function deriveCharacterName(systemPrompt: string): string {
  const firstLine = systemPrompt.split('\n')[0]?.trim() ?? '';
  const match = firstLine.match(/^You are\s+(.+?)\.?$/i);
  const candidate = match?.[1]?.trim();
  return candidate && candidate.length > 0 ? candidate : 'Assistant';
}

export function resolveContextWindow(
  config: SubstrateConfig,
  runtimeModel: { contextWindow?: unknown } | undefined,
): number {
  const configWindow = config.modelRoster.chat?.contextWindow ?? config.defaultContextWindow;
  if (configWindow > 0) return configWindow;
  const modelWindow = runtimeModel?.contextWindow;
  if (typeof modelWindow === 'number' && Number.isFinite(modelWindow) && modelWindow > 0) {
    return modelWindow;
  }
  throw new Error('No positive context window is configured for the active chat model.');
}

export function getLatestAssistantMessage(messages: readonly unknown[]): AssistantMessage | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if ((message as unknown as { role: string }).role === 'assistant') {
      return message as unknown as AssistantMessage;
    }
  }
  return null;
}

export function extractResponseText(input: {
  assistantMessage: AssistantMessage | null;
  logger: AgentStateRuntimeLogger;
}): string {
  if (!input.assistantMessage) {
    input.logger.warn('No assistant message found in agent state after prompt');
    return '';
  }

  const content = input.assistantMessage.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const textParts = content
      .filter((block: any) => block.type === 'text')
      .map((block: any) => block.text)
      .join('');
    if (!textParts) {
      const thinkingParts = content.filter((block: any) => block.type === 'thinking');
      if (thinkingParts.length) {
        input.logger.warn('Assistant produced thinking but no text content', {
          thinkingBlocks: thinkingParts.length,
          blockTypes: content.map((block: any) => block.type),
          stopReason: input.assistantMessage.stopReason,
          errorMessage: input.assistantMessage.errorMessage ?? null,
        });
      } else {
        input.logger.warn('Assistant message has no text content blocks', {
          blockTypes: content.map((block: any) => block.type),
          stopReason: input.assistantMessage.stopReason,
          errorMessage: input.assistantMessage.errorMessage ?? null,
        });
      }
    }
    return textParts;
  }

  input.logger.warn('No assistant message found in agent state after prompt');
  return '';
}
