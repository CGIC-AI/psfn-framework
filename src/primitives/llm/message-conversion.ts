import { isObjectRecord as isRecord } from '../../shared/utils/types.js';
import type {
  AssistantMessage,
  ImageContent,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from '@mariozechner/pi-ai';
import type { ContextMessage } from '../../shared/contracts/runtime.js';

export type PiChatMessage = UserMessage | AssistantMessage | ToolResultMessage;
const SYSTEM_CONTEXT_OPEN_TAG = '<session_context>';
const SYSTEM_CONTEXT_CLOSE_TAG = '</session_context>';
type AssistantContentBlock = TextContent | ThinkingContent | ToolCall;

interface LooseContextMessage {
  role?: unknown;
  content?: unknown;
  timestamp?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  isError?: unknown;
  api?: unknown;
  provider?: unknown;
  model?: unknown;
  usage?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
  responseId?: unknown;
}

interface GenericBlock {
  type?: unknown;
  text?: unknown;
  data?: unknown;
  mimeType?: unknown;
  thinking?: unknown;
  thinkingSignature?: unknown;
  redacted?: unknown;
  id?: unknown;
  name?: unknown;
  arguments?: unknown;
}


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
    .filter(message => message.role === 'system' && typeof message.content === 'string' && message.content.trim().length > 0)
    .map(message => message.content);
}

function resolveTimestamp(
  message: LooseContextMessage,
  timestamp: () => number,
): number {
  return typeof message.timestamp === 'number'
    ? message.timestamp
    : timestamp();
}

function normalizeTextImageContent(
  content: unknown,
): Array<TextContent | ImageContent> {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  if (!Array.isArray(content)) {
    return [];
  }

  const result: Array<TextContent | ImageContent> = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    const candidate = block as GenericBlock;
    if (candidate.type === 'text' && typeof candidate.text === 'string') {
      result.push({ type: 'text', text: candidate.text });
      continue;
    }
    if (
      candidate.type === 'image'
      && typeof candidate.data === 'string'
      && typeof candidate.mimeType === 'string'
    ) {
      result.push({
        type: 'image',
        data: candidate.data,
        mimeType: candidate.mimeType,
      });
    }
  }
  return result;
}

function normalizeAssistantContent(
  content: unknown,
): AssistantContentBlock[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  if (!Array.isArray(content)) {
    return [];
  }

  const result: AssistantContentBlock[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    const candidate = block as GenericBlock;
    if (candidate.type === 'text' && typeof candidate.text === 'string') {
      result.push({ type: 'text', text: candidate.text });
      continue;
    }
    if (candidate.type === 'thinking' && typeof candidate.thinking === 'string') {
      result.push({
        type: 'thinking',
        thinking: candidate.thinking,
        ...(typeof candidate.thinkingSignature === 'string'
          ? { thinkingSignature: candidate.thinkingSignature }
          : {}),
        ...(candidate.redacted === true ? { redacted: true } : {}),
      });
      continue;
    }
    if (
      candidate.type === 'toolCall'
      && typeof candidate.id === 'string'
      && typeof candidate.name === 'string'
    ) {
      result.push({
        type: 'toolCall',
        id: candidate.id,
        name: candidate.name,
        arguments: isRecord(candidate.arguments)
          ? candidate.arguments
          : {},
      });
    }
  }
  return result;
}

function createAssistantMessage(
  message: LooseContextMessage,
  timestamp: number,
): AssistantMessage | null {
  const normalizedContent = normalizeAssistantContent(message.content);
  if (normalizedContent.length === 0) {
    return null;
  }

  return {
    role: 'assistant',
    content: normalizedContent,
    api: typeof message.api === 'string' ? message.api : '',
    provider: typeof message.provider === 'string' ? message.provider : '',
    model: typeof message.model === 'string' ? message.model : '',
    ...(typeof message.responseId === 'string' ? { responseId: message.responseId } : {}),
    usage: isRecord(message.usage)
      ? message.usage as unknown as AssistantMessage['usage']
      : {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    stopReason: typeof message.stopReason === 'string' ? message.stopReason as AssistantMessage['stopReason'] : 'stop',
    ...(typeof message.errorMessage === 'string' ? { errorMessage: message.errorMessage } : {}),
    timestamp,
  };
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
    const candidate = message as unknown as LooseContextMessage;
    const messageRole = candidate.role;

    if (messageRole === 'system') {
      return [];
    }

    const messageTimestamp = resolveTimestamp(candidate, timestamp);

    if (messageRole === 'user') {
      const normalizedContent = normalizeTextImageContent(candidate.content);
      if (normalizedContent.length === 0) {
        return [];
      }
      const userContent = normalizedContent.every(block => block.type === 'text')
        ? normalizedContent.map(block => block.text).join('\n')
        : normalizedContent;
      return [{
        role: 'user',
        content: userContent,
        timestamp: messageTimestamp,
      } satisfies UserMessage];
    }

    if (messageRole === 'toolResult') {
      const normalizedContent = normalizeTextImageContent(candidate.content);
      if (
        normalizedContent.length === 0
        || typeof candidate.toolCallId !== 'string'
        || typeof candidate.toolName !== 'string'
      ) {
        return [];
      }
      return [{
        role: 'toolResult',
        toolCallId: candidate.toolCallId,
        toolName: candidate.toolName,
        content: normalizedContent,
        isError: candidate.isError === true,
        timestamp: messageTimestamp,
      } satisfies ToolResultMessage];
    }

    if (typeof candidate.content === 'string') {
      return [createInternalAssistantMessage(candidate.content, messageTimestamp)];
    }

    const assistantMessage = createAssistantMessage(candidate, messageTimestamp);
    return assistantMessage ? [assistantMessage] : [];
  });
}
