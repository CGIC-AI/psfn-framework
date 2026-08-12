import type { SubstrateAgentTool } from '../../../boundary/pi-agent/index.js';
import type {
  LLMContext,
  LLMResponse,
  ToolCall,
  ToolSchema,
} from '../../../shared/contracts/runtime.js';
import { isRecord } from '../../../shared/utils/types.js';
import {
  createAutomataBusTool,
  type AutomataBusWorkerAccess,
  type AutomataBusWorkerOperation,
  type AutomataBusWorkerScope,
} from '../../automata/bus/worker-access.js';
import { normalizeAutomataBusWorkerOperation } from '../../automata/bus/worker-access-operation.js';

const EXTRACTION_REQUEST = 'Extract facts from the conversation above.';
const TOOL_RESULT_INSTRUCTION = [
  'The following Automata Bus results are bounded extraction-process guidance only.',
  'They are not evidence that a fact occurred and must not be copied into companion memory.',
  'Complete the extraction using only the authorized source transcript as factual evidence.',
].join(' ');

export type ExtractionCompletionPhase = 'initial' | 'after_automata_bus';

export interface ExtractionAutomataBusBinding {
  access: AutomataBusWorkerAccess;
  scope: AutomataBusWorkerScope;
}

export interface ExtractionChunkCompletionInput {
  prompt: string;
  automataBus?: ExtractionAutomataBusBinding;
  complete: (
    context: LLMContext,
    phase: ExtractionCompletionPhase,
  ) => Promise<LLMResponse>;
}

interface PreparedToolCall {
  call: ToolCall;
  operation: AutomataBusWorkerOperation;
}

function toToolSchema(tool: SubstrateAgentTool): ToolSchema {
  if (!isRecord(tool.parameters)) {
    throw new Error('automata_bus tool parameters must be a JSON schema object');
  }
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters,
  };
}

function boundedIdentifier(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > maximum) {
    throw new Error(`${field} exceeds its ${maximum}-character bound`);
  }
  return normalized;
}

function prepareToolCalls(
  value: unknown,
  binding: ExtractionAutomataBusBinding,
): PreparedToolCall[] {
  if (!Array.isArray(value)) throw new Error('Extraction model toolCalls must be an array');
  if (value.length > binding.access.bounds.maxArrayItems) {
    throw new Error(
      `Extraction model toolCalls exceed maxArrayItems (${binding.access.bounds.maxArrayItems})`,
    );
  }
  const seenIds = new Set<string>();
  return value.map((candidate, index) => {
    if (!isRecord(candidate)) throw new Error(`Extraction model toolCalls[${index}] must be an object`);
    const id = boundedIdentifier(
      candidate.id,
      `Extraction model toolCalls[${index}].id`,
      binding.access.bounds.maxTextChars,
    );
    if (seenIds.has(id)) throw new Error(`Extraction model tool call id is duplicated: ${id}`);
    seenIds.add(id);
    const name = boundedIdentifier(
      candidate.name,
      `Extraction model toolCalls[${index}].name`,
      binding.access.bounds.maxTextChars,
    );
    if (name !== 'automata_bus') {
      throw new Error(`Extraction model requested unavailable tool: ${name}`);
    }
    const operation = normalizeAutomataBusWorkerOperation(
      candidate.input,
      binding.access.bounds,
    );
    return {
      call: { id, name, input: candidate.input as Record<string, unknown> },
      operation,
    };
  });
}

function resultText(
  result: Awaited<ReturnType<SubstrateAgentTool['execute']>>,
  maximum: number,
): string {
  const texts = result.content
    .filter((entry): entry is Extract<typeof entry, { type: 'text' }> => entry.type === 'text')
    .map(entry => entry.text);
  const text = texts.join('\n');
  if (!text) throw new Error('automata_bus returned no text result');
  if (text.length > maximum) {
    throw new Error(`automata_bus result exceeds maxToolResultChars (${maximum})`);
  }
  if (isRecord(result.details) && result.details.isError === true) {
    throw new Error(text);
  }
  return text;
}

async function executePreparedToolCalls(
  tool: SubstrateAgentTool,
  prepared: readonly PreparedToolCall[],
  binding: ExtractionAutomataBusBinding,
): Promise<string> {
  const outputs: Array<{ toolCallId: string; action: string; result: string }> = [];
  for (const entry of prepared) {
    const result = await tool.execute(entry.call.id, entry.call.input, undefined);
    outputs.push({
      toolCallId: entry.call.id,
      action: entry.operation.action,
      result: resultText(result, binding.access.bounds.maxToolResultChars),
    });
  }
  const serialized = JSON.stringify(outputs);
  if (serialized.length > binding.access.bounds.maxToolResultChars) {
    throw new Error(
      `Combined automata_bus results exceed maxToolResultChars (${binding.access.bounds.maxToolResultChars})`,
    );
  }
  return serialized;
}

/**
 * Complete one extraction chunk with at most one bounded batch of Bus calls.
 * All calls are preflighted before the first port effect, and the follow-up
 * completion receives no callable tools, preventing an unbounded agent loop.
 */
export async function completeExtractionChunkWithAutomataBus(
  input: ExtractionChunkCompletionInput,
): Promise<string> {
  const tool = input.automataBus ? createAutomataBusTool(input.automataBus) : undefined;
  const initial = await input.complete({
    systemPrompt: input.prompt,
    messages: [{ role: 'user', content: EXTRACTION_REQUEST }],
    ...(tool ? { tools: [toToolSchema(tool)] } : {}),
  }, 'initial');
  const toolCalls = (initial as Partial<LLMResponse>).toolCalls ?? [];
  if (toolCalls.length === 0) return initial.content;
  if (!input.automataBus || !tool) {
    throw new Error('Extraction model returned tool calls without an authorized tool binding');
  }

  const prepared = prepareToolCalls(toolCalls, input.automataBus);
  const outputs = await executePreparedToolCalls(tool, prepared, input.automataBus);
  const final = await input.complete({
    systemPrompt: input.prompt,
    messages: [
      { role: 'user', content: EXTRACTION_REQUEST },
      {
        role: 'user',
        content: `${TOOL_RESULT_INSTRUCTION}\n\n${outputs}`,
      },
    ],
  }, 'after_automata_bus');
  if (((final as Partial<LLMResponse>).toolCalls ?? []).length > 0) {
    throw new Error('Extraction model returned tool calls after the bounded Bus batch');
  }
  return final.content;
}
