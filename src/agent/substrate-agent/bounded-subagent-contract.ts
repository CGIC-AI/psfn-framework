import type { EmbodimentPresenceMetadata } from '../presence-metadata.js';

export const BOUNDED_SUBAGENT_LAUNCH_TOOL_NAME = 'spawn_shard' as const;
export const DEFAULT_BOUNDED_SUBAGENT_LAUNCH_MAX_PARALLEL = 5;
export const DEFAULT_BOUNDED_SUBAGENT_LAUNCH_MAX_TURNS = 1;
export const MAX_BOUNDED_SUBAGENT_LAUNCH_TURNS = 8;

export type BoundedSubagentLaunchToolName = typeof BOUNDED_SUBAGENT_LAUNCH_TOOL_NAME;

export interface BoundedSubagentSourceContext {
  channelId: string;
  requestId?: string;
  turnId?: string;
  embodimentContext?: EmbodimentPresenceMetadata;
}

export interface BoundedSubagentLaunchRequestInput {
  name: string;
  task: string;
  systemPrompt?: string;
  maxTurns?: number;
  capabilities?: readonly string[];
  requiredCapabilities?: readonly string[];
  sourceContext?: BoundedSubagentSourceContext;
}

export interface BoundedSubagentLaunchRequest {
  name: string;
  task: string;
  systemPrompt?: string;
  maxTurns: number;
  capabilities: string[];
  requiredCapabilities: string[];
  sourceContext?: BoundedSubagentSourceContext;
}

export interface BoundedSubagentLaunchResult {
  shardId: string;
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  turns: number;
}

export interface BoundedSubagentLaunchDiagnostics {
  stateReason: string;
  failureReason?: string;
}

export interface BoundedSubagentLaunchEnvelope {
  kind: 'bounded_subagent_launch';
  toolName: BoundedSubagentLaunchToolName;
  request: BoundedSubagentLaunchRequest;
  result: BoundedSubagentLaunchResult;
  diagnostics: BoundedSubagentLaunchDiagnostics;
}

function normalizeText(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Bounded subagent launch requires a string ${fieldName}.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Bounded subagent launch requires a non-empty ${fieldName}.`);
  }
  return trimmed;
}

function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeStringList(values: readonly string[] | undefined): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    normalized.push(trimmed);
    seen.add(trimmed);
  }
  return normalized;
}

function normalizeMaxTurns(value: number | undefined): number {
  const turns = value ?? DEFAULT_BOUNDED_SUBAGENT_LAUNCH_MAX_TURNS;
  if (!Number.isInteger(turns) || turns < 1 || turns > MAX_BOUNDED_SUBAGENT_LAUNCH_TURNS) {
    throw new Error(
      `Bounded subagent launch maxTurns must be an integer between 1 and ${MAX_BOUNDED_SUBAGENT_LAUNCH_TURNS}.`,
    );
  }
  return turns;
}

function normalizeSourceContext(
  sourceContext: BoundedSubagentSourceContext | undefined,
): BoundedSubagentSourceContext | undefined {
  if (!sourceContext) {
    return undefined;
  }

  const channelId = normalizeText(sourceContext.channelId, 'sourceContext.channelId');
  const requestId = normalizeOptionalText(sourceContext.requestId);
  const turnId = normalizeOptionalText(sourceContext.turnId);
  const embodimentContext = sourceContext.embodimentContext;
  const normalizedEmbodimentContext = embodimentContext
    ? (() => {
      const siteId = normalizeOptionalText(embodimentContext.siteId);
      const satelliteId = normalizeOptionalText(embodimentContext.satelliteId);
      const channelId = normalizeOptionalText(embodimentContext.channelId);
      const companionId = normalizeOptionalText(embodimentContext.companionId);
      const label = normalizeOptionalText(embodimentContext.label);
      return {
        kind: 'embodiment' as const,
        embodimentId: normalizeText(embodimentContext.embodimentId, 'sourceContext.embodimentContext.embodimentId'),
        ...(siteId ? { siteId } : {}),
        ...(satelliteId ? { satelliteId } : {}),
        ...(channelId ? { channelId } : {}),
        ...(companionId ? { companionId } : {}),
        ...(label ? { label } : {}),
        ...(embodimentContext.isPrimary !== undefined ? { isPrimary: embodimentContext.isPrimary } : {}),
        ...(embodimentContext.isActive !== undefined ? { isActive: embodimentContext.isActive } : {}),
      } satisfies EmbodimentPresenceMetadata;
    })()
    : undefined;
  return {
    channelId,
    ...(requestId ? { requestId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(normalizedEmbodimentContext ? { embodimentContext: normalizedEmbodimentContext } : {}),
  };
}

export function isBoundedSubagentLaunchToolName(
  toolName: string,
): toolName is BoundedSubagentLaunchToolName {
  return toolName === BOUNDED_SUBAGENT_LAUNCH_TOOL_NAME;
}

export function normalizeBoundedSubagentLaunchRequest(
  input: BoundedSubagentLaunchRequestInput,
): BoundedSubagentLaunchRequest {
  const systemPrompt = normalizeOptionalText(input.systemPrompt);
  const sourceContext = normalizeSourceContext(input.sourceContext);
  return {
    name: normalizeText(input.name, 'name'),
    task: normalizeText(input.task, 'task'),
    ...(systemPrompt ? { systemPrompt } : {}),
    maxTurns: normalizeMaxTurns(input.maxTurns),
    capabilities: normalizeStringList(input.capabilities),
    requiredCapabilities: normalizeStringList(input.requiredCapabilities),
    ...(sourceContext ? { sourceContext } : {}),
  };
}

export function buildBoundedSubagentLaunchEnvelope(
  request: BoundedSubagentLaunchRequest,
  result: BoundedSubagentLaunchResult,
  diagnostics: BoundedSubagentLaunchDiagnostics,
): BoundedSubagentLaunchEnvelope {
  return {
    kind: 'bounded_subagent_launch',
    toolName: BOUNDED_SUBAGENT_LAUNCH_TOOL_NAME,
    request,
    result,
    diagnostics,
  };
}
