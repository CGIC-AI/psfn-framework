import type { AdaptiveToolSnapshotTelemetry } from '../adaptive-tools-telemetry.js';
import type { ToolSchema, TurnID } from '../../../shared/contracts/runtime.js';
import { cloneAdaptiveToolSnapshotTelemetry, cloneToolSchema } from '../../turns/snapshot.js';

interface ToolSchemaCandidate {
  name?: unknown;
  description?: unknown;
  inputSchema?: unknown;
  parameters?: unknown;
}

interface AgentStateCandidate {
  tools?: unknown;
}

interface AgentLike {
  state?: AgentStateCandidate;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toToolSchema(candidate: unknown): ToolSchema | null {
  if (!isPlainRecord(candidate)) return null;
  const { name, description, inputSchema, parameters } = candidate as ToolSchemaCandidate;
  if (typeof name !== 'string' || name.trim().length === 0) return null;
  if (typeof description !== 'string' || description.trim().length === 0) return null;
  const schema = inputSchema ?? parameters;
  if (!isPlainRecord(schema)) return null;
  return cloneToolSchema({
    name: name.trim(),
    description: description.trim(),
    inputSchema: schema,
  });
}

export function readActiveTurnToolSchemas(agent: unknown): ToolSchema[] {
  const tools = (agent as AgentLike | null | undefined)?.state?.tools;
  if (!Array.isArray(tools)) return [];
  const deduped = new Map<string, ToolSchema>();
  for (const tool of tools) {
    const schema = toToolSchema(tool);
    if (!schema) continue;
    deduped.set(schema.name, schema);
  }
  return [...deduped.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(cloneToolSchema);
}

export function matchesAdaptiveToolSnapshotForTurn(
  snapshot: AdaptiveToolSnapshotTelemetry,
  expected: {
    channelId: string;
    turnId: TurnID;
    requestId: string;
  },
): boolean {
  if (snapshot.channelId !== expected.channelId) return false;
  if (snapshot.turnId && snapshot.turnId !== expected.turnId) return false;
  if (snapshot.requestId && snapshot.requestId !== expected.requestId) return false;
  return true;
}

export function cloneObservedAdaptiveToolSnapshot(
  snapshot: AdaptiveToolSnapshotTelemetry | null,
): AdaptiveToolSnapshotTelemetry | null {
  return cloneAdaptiveToolSnapshotTelemetry(snapshot);
}
