import type { LLMContext } from '../../shared/contracts/runtime.js';
import { resolveExplicitlyRequestedToolNames } from '../../shared/tools/explicit-tool-request.js';

type ExplicitToolChoice = 'required' | 'any';

function textContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: 'text'; text: string } => (
      !!block
      && typeof block === 'object'
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string'
    ))
    .map(block => block.text)
    .join('\n');
}

function providerToolChoice(modelApi: string): ExplicitToolChoice | undefined {
  switch (modelApi) {
    case 'openai-completions':
    case 'openai-responses':
    case 'azure-openai-responses':
    case 'openai-codex-responses':
    case 'mistral-conversations':
    case 'pi-messages':
      return 'required';
    case 'anthropic-messages':
    case 'bedrock-converse-stream':
    case 'google-generative-ai':
    case 'google-vertex':
      return 'any';
    default:
      return undefined;
  }
}

/** Require one initial tool call for direct participant instructions naming an active tool. */
export function resolveExplicitToolChoice(input: {
  context: LLMContext;
  originStage?: string;
  modelApi: string;
}): ExplicitToolChoice | undefined {
  if (input.originStage !== 'agent.turn.prompt' || !input.context.tools?.length) {
    return undefined;
  }

  const messages = input.context.messages as unknown as Array<{ role?: unknown; content?: unknown }>;
  let currentUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      currentUserIndex = index;
      break;
    }
  }
  if (currentUserIndex < 0) return undefined;
  if (messages.slice(currentUserIndex + 1).some(message => (
    message.role === 'toolResult' || message.role === 'tool'
  ))) {
    return undefined;
  }

  const requestText = textContent(messages[currentUserIndex]?.content);
  const requestedToolNames = resolveExplicitlyRequestedToolNames(
    requestText,
    input.context.tools.map(tool => tool.name),
  );
  return requestedToolNames.length > 0 ? providerToolChoice(input.modelApi) : undefined;
}
