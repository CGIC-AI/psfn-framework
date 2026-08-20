import { validateToolArguments, type Tool, type ToolCall as PiToolCall } from '@earendil-works/pi-ai';
import type { LLMContext } from '../../shared/contracts/runtime.js';
import type { ToolSchema } from '../../shared/contracts/runtime.js';
import {
  isHeldToolCallResult,
  isToolResultOutcomeProjection,
  resolveToolCallOutcome,
} from '../../shared/contracts/tool-call-outcome.js';
import { resolveExplicitToolRequestSequence } from '../../shared/tools/explicit-tool-request.js';
import { isRecord } from '../../shared/utils/types.js';
import {
  exactToolArgumentsMatch,
  resolveExactExplicitToolArguments,
} from './explicit-tool-arguments.js';

export interface ExplicitNamedToolChoice {
  type: 'function';
  function: { name: string };
}
export type ExplicitToolChoice = ExplicitNamedToolChoice | 'required' | 'none';

export interface ExplicitToolContract {
  choice: ExplicitToolChoice;
  requiredToolName?: string;
  expectedArguments?: Record<string, unknown>;
}

export type ExplicitToolContractViolation =
  | 'missing_required_call'
  | 'corrupt_empty_arguments'
  | 'invalid_arguments'
  | 'unexpected_tool_call'
  | 'mismatched_tool_call';

export class ExplicitToolContractError extends Error {
  readonly code = 'MODEL_TOOL_CONTRACT_INCOMPATIBLE';

  constructor(
    message: string,
    readonly violation: ExplicitToolContractViolation = 'mismatched_tool_call',
  ) {
    super(message);
    this.name = 'ExplicitToolContractError';
  }
}

export function isMissingRequiredToolCallError(error: unknown): boolean {
  return isExplicitToolContractError(error)
    && (error as { violation?: unknown }).violation === 'missing_required_call';
}

export function isExplicitToolContractError(error: unknown): error is ExplicitToolContractError {
  return error instanceof ExplicitToolContractError
    || (
      isRecord(error)
      && error.name === 'ExplicitToolContractError'
      && error.code === 'MODEL_TOOL_CONTRACT_INCOMPATIBLE'
    );
}

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

export function assertExplicitToolContractSatisfied(input: {
  choice: ExplicitToolChoice | undefined;
  requiredToolName?: string;
  toolCalls: ReadonlyArray<{ name: string }>;
}): void {
  if (!input.choice) return;
  if (input.choice === 'none') {
    if (input.toolCalls.length === 0) return;
    throw new ExplicitToolContractError(
      `Provider returned ${input.toolCalls.length} tool call(s) after tool execution was disabled`,
      'unexpected_tool_call',
    );
  }
  const expectedName = input.choice === 'required'
    ? input.requiredToolName
    : input.choice.function.name;
  if (
    expectedName
    && input.toolCalls.length === 1
    && input.toolCalls[0]?.name === expectedName
  ) {
    return;
  }
  if (expectedName && input.toolCalls.length === 0) {
    throw new ExplicitToolContractError(
      `Provider violated explicit tool contract: expected exactly one ${JSON.stringify(expectedName)} call, received []`,
      'missing_required_call',
    );
  }
  throw new ExplicitToolContractError(
    `Provider violated explicit tool contract: expected exactly one ${JSON.stringify(expectedName)} call, received ${JSON.stringify(input.toolCalls.map(call => call.name))}`,
  );
}

function assertExplicitToolArgumentsValid(input: {
  contract: ExplicitToolContract | undefined;
  corruptToolNames: readonly string[];
  toolCalls: ReadonlyArray<{ id: string; name: string; input: Record<string, unknown> }>;
  tools: readonly ToolSchema[] | undefined;
}): void {
  if (input.contract && input.corruptToolNames.length > 0) {
    throw new ExplicitToolContractError(
      `Provider returned empty arguments for required tool call(s): ${input.corruptToolNames.join(', ')}`,
      'corrupt_empty_arguments',
    );
  }
  const requiredToolName = input.contract?.requiredToolName;
  if (!requiredToolName) return;
  const toolCall = input.toolCalls[0];
  const tool = input.tools?.find(candidate => candidate.name === requiredToolName);
  if (!toolCall || !tool) {
    throw new Error(`Explicit tool schema unavailable for ${requiredToolName}`);
  }

  validateExplicitToolArguments({
    requiredToolName,
    tool,
    toolCall,
    failureSubject: 'Provider returned',
  });
  if (
    input.contract?.expectedArguments
    && !exactToolArgumentsMatch(toolCall.input, input.contract.expectedArguments)
  ) {
    throw new ExplicitToolContractError(
      `Provider changed exact requested arguments for required tool call: ${requiredToolName}`,
      'invalid_arguments',
    );
  }
}

function validateExplicitToolArguments(input: {
  requiredToolName: string;
  tool: ToolSchema;
  toolCall: { id: string; name: string; input: Record<string, unknown> };
  failureSubject: 'Provider returned' | 'Requested exact arguments are';
}): void {
  try {
    validateToolArguments(
      {
        name: input.tool.name,
        description: input.tool.description,
        parameters: input.tool.inputSchema as Tool['parameters'],
      },
      {
        type: 'toolCall',
        id: input.toolCall.id,
        name: input.toolCall.name,
        arguments: input.toolCall.input,
      } satisfies PiToolCall,
    );
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('Validation failed for tool ')) {
      throw error;
    }
    throw new ExplicitToolContractError(
      `${input.failureSubject} schema-invalid for required tool call: ${input.requiredToolName}`,
      'invalid_arguments',
    );
  }
}

/**
 * Make an unambiguous participant-supplied exact argument object authoritative.
 *
 * The model still has to select the one required tool. Before replacing its
 * argument copy, validate the participant's JSON against the canonical execution
 * schema so an invalid prompt can never gain execution authority.
 */
export function applyExactExplicitToolArguments<
  T extends { id: string; name: string; input: Record<string, unknown> },
>(input: {
  contract: ExplicitToolContract | undefined;
  toolCalls: readonly T[];
  tools: readonly ToolSchema[] | undefined;
}): T[] {
  const requiredToolName = input.contract?.requiredToolName;
  const expectedArguments = input.contract?.expectedArguments;
  if (!requiredToolName || !expectedArguments) return [...input.toolCalls];
  if (
    input.toolCalls.length !== 1
    || input.toolCalls[0]?.name !== requiredToolName
  ) {
    return [...input.toolCalls];
  }
  const tool = input.tools?.find(candidate => candidate.name === requiredToolName);
  if (!tool) {
    throw new Error(`Explicit tool schema unavailable for ${requiredToolName}`);
  }
  const toolCall = input.toolCalls[0];
  validateExplicitToolArguments({
    requiredToolName,
    tool,
    toolCall: {
      id: toolCall.id,
      name: toolCall.name,
      input: expectedArguments,
    },
    failureSubject: 'Requested exact arguments are',
  });
  return [{
    ...toolCall,
    input: structuredClone(expectedArguments),
  }];
}

export function assertExplicitToolResponseSatisfied(input: {
  contract: ExplicitToolContract | undefined;
  corruptToolNames: readonly string[];
  toolCalls: ReadonlyArray<{ id: string; name: string; input: Record<string, unknown> }>;
  tools: readonly ToolSchema[] | undefined;
}): void {
  assertExplicitToolContractSatisfied({
    choice: input.contract?.choice,
    ...(input.contract?.requiredToolName
      ? { requiredToolName: input.contract.requiredToolName }
      : {}),
    toolCalls: input.toolCalls,
  });
  assertExplicitToolArgumentsValid(input);
}

/**
 * Keep one provider-emitted call for the current explicit sequence step.
 *
 * Some OpenAI-compatible providers return several calls for the sole exposed
 * function even when the client asks for a required single-tool step. The
 * agent loop must not execute that fan-out concurrently: retain the first
 * exact call, feed its result back to the model, and let the next loop
 * iteration enforce the next requested step. Mixed or missing calls still
 * fail closed.
 */
export function selectExplicitToolContractCall<T extends { name: string }>(input: {
  choice: ExplicitToolChoice | undefined;
  requiredToolName?: string;
  toolCalls: readonly T[];
  deferMissingRequiredCall?: boolean;
}): T[] {
  if (!input.choice) return [...input.toolCalls];
  if (input.choice === 'none') {
    if (input.toolCalls.length === 0) return [];
    throw new ExplicitToolContractError(
      `Provider returned ${input.toolCalls.length} tool call(s) after tool execution was disabled`,
      'unexpected_tool_call',
    );
  }
  const expectedName = input.choice === 'required'
    ? input.requiredToolName
    : input.choice.function.name;
  if (
    expectedName
    && input.toolCalls.length > 0
    && input.toolCalls.every(call => call.name === expectedName)
  ) {
    const first = input.toolCalls[0];
    return first ? [first] : [];
  }
  if (expectedName && input.toolCalls.length === 0) {
    if (input.deferMissingRequiredCall) return [];
    throw new ExplicitToolContractError(
      `Provider violated explicit tool contract: expected exactly one ${JSON.stringify(expectedName)} call, received []`,
      'missing_required_call',
    );
  }
  throw new ExplicitToolContractError(
    `Provider violated explicit tool contract: expected exactly one ${JSON.stringify(expectedName)} call, received ${JSON.stringify(input.toolCalls.map(call => call.name))}`,
  );
}

/** Enforce the named sequence, then forbid extra tools for that explicit request. */
export function resolveExplicitToolContract(input: {
  context: LLMContext;
  originStage?: string;
  modelApi: string;
}): ExplicitToolContract | undefined {
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
    .filter(isToolResultOutcomeProjection)
    .filter((message) => {
      if (isHeldToolCallResult(message.details)) return false;
      const outcome = resolveToolCallOutcome(message);
      return outcome === 'success'
        || outcome === 'execution_failure'
        || outcome === 'policy_denial'
        || outcome === 'duplicate_skip';
    })
    .map(message => message.toolName);
  let completedSequenceSteps = 0;
  for (const attemptedToolName of attemptedToolNames) {
    if (attemptedToolName === requestedToolSequence[completedSequenceSteps]) {
      completedSequenceSteps += 1;
    }
    if (completedSequenceSteps === requestedToolSequence.length) break;
  }
  const nextToolName = requestedToolSequence[completedSequenceSteps];
  const choice = providerToolChoice(
    input.modelApi,
    nextToolName,
  );
  const expectedArguments = nextToolName && requestedToolSequence.length === 1
    ? resolveExactExplicitToolArguments(requestText, nextToolName)
    : undefined;
  return {
    choice,
    ...(nextToolName
      ? {
          requiredToolName: nextToolName,
          ...(expectedArguments ? { expectedArguments } : {}),
        }
      : {}),
  };
}

export function resolveExplicitToolChoice(input: {
  context: LLMContext;
  originStage?: string;
  modelApi: string;
}): ExplicitToolChoice | undefined {
  return resolveExplicitToolContract(input)?.choice;
}
