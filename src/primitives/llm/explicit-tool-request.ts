import type { LLMContext } from '../../shared/contracts/runtime.js';
import { resolveExplicitToolRequestSequence } from '../../shared/tools/explicit-tool-request.js';

export interface ExplicitNamedToolChoice {
  type: 'function';
  function: { name: string };
}
export type ExplicitToolChoice = ExplicitNamedToolChoice | 'none';

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

function providerToolChoice(modelApi: string, toolName?: string): ExplicitToolChoice {
  switch (modelApi) {
    case 'openai-completions':
    case 'pi-messages':
      return toolName
        ? { type: 'function', function: { name: toolName } }
        : 'none';
    default:
      throw new Error(
        `cannot enforce explicit tool execution for unsupported model API: ${modelApi}`,
      );
  }
}

/** Enforce the named sequence, then forbid extra tools for that explicit request. */
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
  const requestText = textContent(messages[currentUserIndex]?.content);
  const requestedToolSequence = resolveExplicitToolRequestSequence(
    requestText,
    input.context.tools.map(tool => tool.name),
  );
  if (requestedToolSequence.length === 0) return undefined;
  const attemptedToolNames = messages.slice(currentUserIndex + 1)
    .filter(message => message.role === 'toolResult' || message.role === 'tool')
    .map(message => (message as { toolName?: unknown }).toolName)
    .filter((name): name is string => typeof name === 'string');
  let completedSequenceSteps = 0;
  for (const attemptedToolName of attemptedToolNames) {
    if (attemptedToolName === requestedToolSequence[completedSequenceSteps]) {
      completedSequenceSteps += 1;
    }
    if (completedSequenceSteps === requestedToolSequence.length) break;
  }
  return providerToolChoice(
    input.modelApi,
    requestedToolSequence[completedSequenceSteps],
  );
}
