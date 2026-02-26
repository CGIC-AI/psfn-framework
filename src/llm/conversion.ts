import type {
  Message,
  UserMessage,
  AssistantMessage,
  Tool as PiTool,
  Context as PiContext,
  TextContent as TextBlock,
  ThinkingContent as ThinkingBlock,
} from '@mariozechner/pi-ai';
import type { ContextMessage, LLMContext, ToolSchema } from '../types.js';

interface GenericBlock {
  type?: unknown;
  text?: unknown;
  thinking?: unknown;
}

function isTextBlock(block: unknown): block is TextBlock {
  if (!block || typeof block !== 'object') return false;
  const candidate = block as GenericBlock;
  return candidate.type === 'text' && typeof candidate.text === 'string';
}

function isThinkingBlock(block: unknown): block is ThinkingBlock {
  if (!block || typeof block !== 'object') return false;
  const candidate = block as GenericBlock;
  return candidate.type === 'thinking' && typeof candidate.thinking === 'string';
}

export function extractTextContent(blocks?: unknown[]): string {
  if (!Array.isArray(blocks) || blocks.length === 0) return '';
  return blocks
    .filter(isTextBlock)
    .map(block => block.text)
    .join('');
}

export function extractReasoningContent(blocks?: unknown[]): string {
  if (!Array.isArray(blocks) || blocks.length === 0) return '';
  return blocks
    .filter(isThinkingBlock)
    .map(block => block.thinking)
    .join('');
}

export function toPiTools(tools: ToolSchema[]): PiTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema as PiTool['parameters'],
  }));
}

export function toPiMessages(messages: ContextMessage[]): Message[] {
  const now = Date.now();
  return messages.map((message): Message => {
    if (message.role === 'user') {
      return {
        role: 'user',
        content: message.content,
        timestamp: now,
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
      timestamp: now,
    } satisfies AssistantMessage;
  });
}

export function toPiContext(context: LLMContext): PiContext {
  return {
    systemPrompt: context.systemPrompt,
    messages: toPiMessages(context.messages),
    ...(context.tools?.length ? { tools: toPiTools(context.tools) } : {}),
  };
}
