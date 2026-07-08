// ── Tool-surface conformance harness (LLM-free, direct-execution) ──
//
// Runs each classified probe by calling the tool handler directly. No LLM, no
// agent turn, no session write. Fail-closed: an unclassified live tool aborts
// the sweep with a ToolConformanceHarnessError (distinct from per-tool
// conformance failures, which are recorded as ok:false result entries).

import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { isRecord } from '../../../shared/utils/types.js';
import { extractRequiredParameterNames } from '../tool-catalog.js';
import { getToolProbeSpec, type ToolProbeSpec } from './probe-registry.js';
import {
  ToolConformanceHarnessError,
  TOOL_CONFORMANCE_SCHEMA_VERSION,
  type ToolConformanceProbeResult,
  type ToolConformanceRunResult,
  type ToolConformanceTrigger,
} from './types.js';

/** Default per-probe timeout. A probe that exceeds this is a conformance failure. */
export const DEFAULT_PER_PROBE_TIMEOUT_MS = 5_000;

const PROBE_CALL_ID = 'tool-conformance-probe';
const MAX_ERROR_CHARS = 500;

export interface ToolConformanceSweepInput {
  /** All live registered direct tools (core + extended). */
  tools: readonly AgentTool<any>[];
  trigger: ToolConformanceTrigger;
  perProbeTimeoutMs?: number;
  /** Injectable clock for wall-clock timestamps. */
  now?: () => number;
  /** Injectable monotonic clock for durations (defaults to Date.now). */
  monotonicNow?: () => number;
  /** Override registry lookup (tests). */
  resolveProbeSpec?: (toolName: string) => ToolProbeSpec | undefined;
}

type ExecuteOutcome =
  | { kind: 'value'; value: AgentToolResult<unknown> }
  | { kind: 'error'; error: unknown }
  | { kind: 'timeout' };

function timeoutDelay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
  });
}

async function executeWithTimeout(
  tool: AgentTool<any>,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<ExecuteOutcome> {
  const invocation = (async (): Promise<ExecuteOutcome> => {
    try {
      const value = (await tool.execute(PROBE_CALL_ID, args)) as AgentToolResult<unknown>;
      return { kind: 'value', value };
    } catch (error) {
      // A rejected handler promise is caught here; the timeout branch never
      // sees an unhandled rejection.
      return { kind: 'error', error };
    }
  })();
  const timeout = (async (): Promise<ExecuteOutcome> => {
    await timeoutDelay(timeoutMs);
    return { kind: 'timeout' };
  })();
  return Promise.race([invocation, timeout]);
}

function toErrorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.length > MAX_ERROR_CHARS ? `${raw.slice(0, MAX_ERROR_CHARS)}…` : raw;
}

function isWellFormedToolResult(value: unknown): value is AgentToolResult<unknown> {
  return isRecord(value) && Array.isArray((value as { content?: unknown }).content);
}

function resultIsError(value: AgentToolResult<unknown>): boolean {
  const details = (value as { details?: unknown }).details;
  return isRecord(details) && details.isError === true;
}

function extractResultText(value: AgentToolResult<unknown>): string {
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  const texts = content
    .filter((entry): entry is { type: 'text'; text: string } =>
      isRecord(entry) && entry.type === 'text' && typeof entry.text === 'string')
    .map(entry => entry.text);
  const joined = texts.join(' ').trim();
  return joined.length > MAX_ERROR_CHARS ? `${joined.slice(0, MAX_ERROR_CHARS)}…` : joined;
}

/** Validate the tool exposes a well-formed TypeBox-style object parameter schema. */
function validateSchema(tool: AgentTool<any>): { ok: true } | { ok: false; error: string } {
  const params = tool.parameters as unknown;
  if (!isRecord(params)) {
    return { ok: false, error: 'parameters schema is not an object' };
  }
  const hasObjectType = params.type === 'object';
  const hasProperties = isRecord(params.properties);
  if (!hasObjectType && !hasProperties) {
    return { ok: false, error: 'parameters schema declares neither type:"object" nor properties' };
  }
  const required = (params as { required?: unknown }).required;
  if (required !== undefined && !(Array.isArray(required) && required.every(v => typeof v === 'string'))) {
    return { ok: false, error: 'parameters.required is not a string array' };
  }
  return { ok: true };
}

async function runReadOnlyProbe(
  tool: AgentTool<any>,
  spec: Extract<ToolProbeSpec, { kind: 'read_only' }>,
  timeoutMs: number,
  monotonicNow: () => number,
): Promise<ToolConformanceProbeResult> {
  const started = monotonicNow();
  const outcome = await executeWithTimeout(tool, spec.args, timeoutMs);
  const durationMs = Math.max(0, monotonicNow() - started);
  const base = {
    toolName: tool.name,
    probeKind: 'read_only' as const,
    durationMs,
    ...(spec.action ? { action: spec.action } : {}),
  };

  if (outcome.kind === 'timeout') {
    return { ...base, ok: false, classification: 'timeout', error: `exceeded ${timeoutMs}ms` };
  }
  if (outcome.kind === 'error') {
    return { ...base, ok: false, classification: 'threw', error: toErrorText(outcome.error) };
  }
  if (!isWellFormedToolResult(outcome.value)) {
    return { ...base, ok: false, classification: 'malformed_output', error: 'result is not a well-formed AgentToolResult' };
  }
  if (resultIsError(outcome.value)) {
    return { ...base, ok: false, classification: 'returned_error', error: extractResultText(outcome.value) };
  }
  return { ...base, ok: true };
}

function runSchemaOnlyProbe(
  tool: AgentTool<any>,
  monotonicNow: () => number,
): ToolConformanceProbeResult {
  const started = monotonicNow();
  const validation = validateSchema(tool);
  const durationMs = Math.max(0, monotonicNow() - started);
  if (validation.ok) {
    return { toolName: tool.name, probeKind: 'schema_only', ok: true, durationMs };
  }
  return {
    toolName: tool.name,
    probeKind: 'schema_only',
    ok: false,
    durationMs,
    classification: 'schema_invalid',
    error: validation.error,
  };
}

/**
 * Required-action empty-args conformance check (encodes bead gu8m as a permanent
 * regression probe). Only runs when the schema declares `action` as required. A
 * proper tool rejects {} — by throwing or returning an isError result — before
 * mutating. A tool that ACCEPTS {} and returns a success result performs a
 * mutation on empty input: a conformance failure.
 */
async function runRejectionProbe(
  tool: AgentTool<any>,
  timeoutMs: number,
  monotonicNow: () => number,
): Promise<ToolConformanceProbeResult | null> {
  const required = extractRequiredParameterNames(tool.parameters);
  if (!required.includes('action')) return null;

  const started = monotonicNow();
  const outcome = await executeWithTimeout(tool, {}, timeoutMs);
  const durationMs = Math.max(0, monotonicNow() - started);
  const base = { toolName: tool.name, probeKind: 'rejection_check' as const, action: 'action', durationMs };

  if (outcome.kind === 'timeout') {
    return { ...base, ok: false, classification: 'timeout', error: `exceeded ${timeoutMs}ms` };
  }
  if (outcome.kind === 'error') {
    // A thrown validation error is the expected, correct rejection.
    return { ...base, ok: true };
  }
  if (isWellFormedToolResult(outcome.value) && resultIsError(outcome.value)) {
    // An isError result is also an acceptable rejection.
    return { ...base, ok: true };
  }
  // Accepted {} with a non-error result: the tool acted on empty input.
  return {
    ...base,
    ok: false,
    classification: 'accepted_empty_args',
    error: 'tool accepted empty args {} without rejecting a required action',
  };
}

/**
 * Run the full conformance sweep. Throws ToolConformanceHarnessError if any live
 * tool is unclassified (registry drift) — the harness fails closed rather than
 * silently skipping a tool.
 */
export async function runToolConformanceSweep(
  input: ToolConformanceSweepInput,
): Promise<ToolConformanceRunResult> {
  const timeoutMs = Math.max(1, Math.floor(input.perProbeTimeoutMs ?? DEFAULT_PER_PROBE_TIMEOUT_MS));
  const now = input.now ?? Date.now;
  const monotonicNow = input.monotonicNow ?? Date.now;
  const resolveProbeSpec = input.resolveProbeSpec ?? getToolProbeSpec;

  // Fail closed on unclassified live tools before running anything.
  const unclassified = input.tools
    .map(tool => tool.name)
    .filter(name => resolveProbeSpec(name) === undefined);
  if (unclassified.length > 0) {
    throw new ToolConformanceHarnessError(
      `unclassified live tools have no conformance probe entry: ${[...new Set(unclassified)].sort().join(', ')}`,
    );
  }

  const results: ToolConformanceProbeResult[] = [];
  for (const tool of input.tools) {
    const spec = resolveProbeSpec(tool.name);
    if (!spec) continue; // unreachable: guarded above
    if (spec.kind === 'read_only') {
      results.push(await runReadOnlyProbe(tool, spec, timeoutMs, monotonicNow));
    } else {
      results.push(runSchemaOnlyProbe(tool, monotonicNow));
    }
    const rejection = await runRejectionProbe(tool, timeoutMs, monotonicNow);
    if (rejection) results.push(rejection);
  }

  return {
    schemaVersion: TOOL_CONFORMANCE_SCHEMA_VERSION,
    ranAt: now(),
    trigger: input.trigger,
    results,
  };
}
