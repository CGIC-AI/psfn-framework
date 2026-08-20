import type { ToolSchema } from '../../shared/contracts/runtime.js';
import { isRecord } from '../../shared/utils/types.js';

interface StreamToolCandidate {
  name?: unknown;
  description?: unknown;
  inputSchema?: unknown;
  modelParameters?: unknown;
  parameters?: unknown;
}

type SchemaSelector = (candidate: StreamToolCandidate) => unknown;

function normalizeTools(tools: unknown, selectSchema: SchemaSelector): ToolSchema[] | undefined {
  if (tools === undefined) return undefined;
  if (!Array.isArray(tools)) {
    throw new Error('Invalid stream context tools: tools must be an array');
  }
  if (tools.length === 0) return undefined;
  return tools.map(tool => normalizeTool(tool, selectSchema));
}

function normalizeTool(tool: unknown, selectSchema: SchemaSelector): ToolSchema {
  if (!isRecord(tool)) {
    throw new Error('Invalid stream tool schema: tool must be an object');
  }
  const candidate = tool as StreamToolCandidate;
  if (typeof candidate.name !== 'string' || candidate.name.trim().length === 0) {
    throw new Error('Invalid stream tool schema: tool.name must be a non-empty string');
  }
  if (typeof candidate.description !== 'string' || candidate.description.trim().length === 0) {
    throw new Error(`Invalid stream tool schema for ${candidate.name}: tool.description must be a non-empty string`);
  }
  const inputSchema = selectSchema(candidate);
  if (!isRecord(inputSchema)) {
    throw new Error(`Invalid stream tool schema for ${candidate.name}: inputSchema or parameters must be an object`);
  }
  return {
    name: candidate.name,
    description: candidate.description,
    inputSchema,
  };
}

/** Schema sent to pi-ai. A declared model schema wins over execution parameters. */
export function normalizeTransportTools(tools: unknown): ToolSchema[] | undefined {
  return normalizeTools(
    tools,
    candidate => candidate.inputSchema ?? candidate.modelParameters ?? candidate.parameters,
  );
}

/** Canonical schema used to validate a response before candidate fallback or dispatch. */
export function normalizeExecutionTools(tools: unknown): ToolSchema[] | undefined {
  return normalizeTools(
    tools,
    candidate => candidate.parameters ?? candidate.inputSchema ?? candidate.modelParameters,
  );
}
