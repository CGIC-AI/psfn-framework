// ── Tool-surface conformance harness (LLM-free, direct-execution) ──
//
// Runs each classified probe by calling the tool handler directly. No LLM, no
// agent turn, no session write. Fail-closed: an unclassified live tool aborts
// the sweep with a ToolConformanceHarnessError (distinct from per-tool
// conformance failures, which are recorded as ok:false result entries).

import type { AgentTool, AgentToolResult } from '../../../boundary/pi-agent/index.js';
import { isRecord } from '../../../shared/utils/types.js';
import { extractRequiredParameterNames } from '../tool-catalog.js';
import { getCanonicalToolSurface } from '../tool-surface/registry.js';
import {
  getToolProbeSpec,
  getToolActionProbes,
  type ToolProbeSpec,
  type ActionProbeSpec,
} from './probe-registry.js';
import { runSandboxHelperProbes } from './sandbox-helper-probe.js';
import {
  ToolConformanceHarnessError,
  TOOL_CONFORMANCE_SCHEMA_VERSION,
  type ToolConformanceClassification,
  type ToolConformanceProbeResult,
  type ToolConformanceRunResult,
  type ToolConformanceTrigger,
} from './types.js';

/** Default per-probe timeout. A probe that exceeds this is a conformance failure. */
export const DEFAULT_PER_PROBE_TIMEOUT_MS = 5_000;

const PROBE_CALL_ID = 'tool-conformance-probe';
const MAX_ERROR_CHARS = 500;

/**
 * Extract the `action` string literals a tool actually declares in its live
 * TypeBox parameter schema. Mirrors the canonical extractor in tool-catalog.ts
 * (const / enum / anyOf / oneOf / allOf) but is kept local so the conformance
 * harness carries no dependency on the catalog module. Used to make per-action
 * coverage SCHEMA-authoritative: a verb added to a tool's schema without a
 * conformance classification is probed anyway and fails closed (bead 65rk.7 fix
 * for finding 1 — coverage was previously checked only against the hand-kept
 * tool-surface action list, never the live schema).
 */
function extractSchemaStringLiterals(schema: unknown): string[] {
  if (!isRecord(schema)) return [];
  const literals: string[] = [];
  if (typeof schema.const === 'string') literals.push(schema.const);
  if (Array.isArray(schema.enum)) {
    for (const value of schema.enum) {
      if (typeof value === 'string') literals.push(value);
    }
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const entries = (schema as Record<string, unknown>)[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) literals.push(...extractSchemaStringLiterals(entry));
  }
  return literals;
}

function extractSchemaActionLiterals(parameters: unknown): string[] {
  if (!isRecord(parameters)) return [];
  const literals: string[] = [];
  const properties = parameters.properties;
  if (isRecord(properties)) {
    literals.push(...extractSchemaStringLiterals(properties.action));
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const entries = (parameters as Record<string, unknown>)[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) literals.push(...extractSchemaActionLiterals(entry));
  }
  return [...new Set(literals.map(value => value.trim()).filter(Boolean))];
}

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
  /** Override the canonical action list per tool (tests). Defaults to the tool-surface registry. */
  resolveCanonicalActions?: (toolName: string) => readonly string[] | undefined;
  /** Override the per-action probe classification map per tool (tests). Defaults to the action registry. */
  resolveActionProbes?: (toolName: string) => Readonly<Record<string, ActionProbeSpec>> | undefined;
  /**
   * Opt-in per-action coverage (bead 65rk.7). When false/absent the sweep is
   * byte-identical to the legacy per-tool run (the rollout-gate contract). When
   * true the sweep adds one probe per canonical action plus the REPL sandbox
   * helper probes, and stamps `mode: 'extended'` on the result.
   */
  extended?: boolean;
  /**
   * Isolated-scope flag. Only meaningful with `extended`. When true, scoped_mutation
   * probes EXECUTE against the internal:tool-conformance channel with cleanup;
   * otherwise they are recorded skipped and never executed. Default runs never
   * execute mutations regardless of this flag.
   */
  allowScopedMutations?: boolean;
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

/**
 * Execute a MUTATION handler under a cancellation contract (bead 65rk.7 fix for
 * finding 3 — the previous path raced the handler with no AbortSignal and ran
 * teardown the instant the race returned, so a timed-out mutation could still
 * commit AFTER cleanup and leave durable residue).
 *
 * An AbortSignal is threaded into the handler. If the handler settles before the
 * timeout, its outcome is returned with `terminated: true`. If the timeout wins,
 * the signal is aborted and the harness AWAITS confirmed settlement (bounded by a
 * grace window). A handler that settles within grace honored cancellation
 * (`terminated: true`); one that does not is uncancellable (`terminated: false`)
 * and the caller MUST withhold teardown. Cleanup therefore never races an
 * in-flight mutation.
 */
async function executeMutationWithCancellation(
  tool: AgentTool<any>,
  args: Record<string, unknown>,
  timeoutMs: number,
  graceMs: number,
): Promise<{ outcome: ExecuteOutcome; terminated: boolean }> {
  const controller = new AbortController();
  // Never rejects — a thrown/rejected handler is captured as an 'error' outcome,
  // so awaiting `settlement` below can only resolve, never dangle as unhandled.
  const settlement: Promise<ExecuteOutcome> = (async (): Promise<ExecuteOutcome> => {
    try {
      const value = (await tool.execute(PROBE_CALL_ID, args, controller.signal)) as AgentToolResult<unknown>;
      return { kind: 'value', value };
    } catch (error) {
      return { kind: 'error', error };
    }
  })();

  const timeout = (async (): Promise<ExecuteOutcome> => {
    await timeoutDelay(timeoutMs);
    return { kind: 'timeout' };
  })();

  const raced = await Promise.race([settlement, timeout]);
  if (raced.kind !== 'timeout') {
    // Handler settled within the timeout; it has already terminated.
    return { outcome: raced, terminated: true };
  }

  // Timed out: demand cancellation and wait for confirmed termination.
  controller.abort();
  const graceExpired = Symbol('grace-expired');
  const settledMarker = await Promise.race([
    settlement.then(() => 'settled' as const),
    timeoutDelay(Math.max(1, graceMs)).then(() => graceExpired),
  ]);
  return { outcome: { kind: 'timeout' }, terminated: settledMarker === 'settled' };
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

/**
 * Classify an execute outcome into a failure descriptor, or null on success.
 * Shared by the per-action safe_read and scoped_mutation probes so a thrown /
 * timed-out / malformed / isError handler is always a fail-closed failure.
 */
function classifyExecuteOutcome(
  outcome: ExecuteOutcome,
  timeoutMs: number,
): { classification: ToolConformanceClassification; error: string } | null {
  if (outcome.kind === 'timeout') {
    return { classification: 'timeout', error: `exceeded ${timeoutMs}ms` };
  }
  if (outcome.kind === 'error') {
    return { classification: 'threw', error: toErrorText(outcome.error) };
  }
  if (!isWellFormedToolResult(outcome.value)) {
    return { classification: 'malformed_output', error: 'result is not a well-formed AgentToolResult' };
  }
  if (resultIsError(outcome.value)) {
    return { classification: 'returned_error', error: extractResultText(outcome.value) };
  }
  return null;
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

// ── Per-action extended probes (bead 65rk.7) ───────────────────────────────

async function runSafeReadActionProbe(
  tool: AgentTool<any>,
  action: string,
  spec: Extract<ActionProbeSpec, { kind: 'safe_read' }>,
  timeoutMs: number,
  monotonicNow: () => number,
): Promise<ToolConformanceProbeResult> {
  const started = monotonicNow();
  const outcome = await executeWithTimeout(tool, spec.args, timeoutMs);
  const durationMs = Math.max(0, monotonicNow() - started);
  const base = { toolName: tool.name, probeKind: 'safe_read' as const, action, durationMs };
  const failure = classifyExecuteOutcome(outcome, timeoutMs);
  if (failure) return { ...base, ok: false, classification: failure.classification, error: failure.error };
  return { ...base, ok: true };
}

function runSchemaAssertActionProbe(
  tool: AgentTool<any>,
  action: string,
  monotonicNow: () => number,
): ToolConformanceProbeResult {
  const started = monotonicNow();
  const validation = validateSchema(tool);
  const durationMs = Math.max(0, monotonicNow() - started);
  const base = { toolName: tool.name, probeKind: 'schema_assert' as const, action, durationMs };
  if (validation.ok) return { ...base, ok: true };
  return { ...base, ok: false, classification: 'schema_invalid', error: validation.error };
}

/**
 * A scoped_mutation probe. Fail-closed teardown discipline: the mutation runs ONLY
 * when the isolated-scope flag is set; a run that mutates ALWAYS attempts cleanup,
 * and a failed cleanup is a conformance failure so the sweep never leaves residue.
 */
async function runScopedMutationActionProbe(
  tool: AgentTool<any>,
  action: string,
  spec: Extract<ActionProbeSpec, { kind: 'scoped_mutation' }>,
  timeoutMs: number,
  monotonicNow: () => number,
  allowScopedMutations: boolean,
): Promise<ToolConformanceProbeResult> {
  const base = { toolName: tool.name, probeKind: 'scoped_mutation' as const, action };

  // Registration integrity: a scoped_mutation without a valid cancellation
  // contract is refused before anything runs. The harness cannot prove such a
  // mutation has terminated, so it must never be allowed to execute + teardown.
  // Read the kind loosely: the static type forbids a bad value, but a registry
  // entry can be mis-authored at runtime and MUST still fail closed here.
  const cancellationKind = (spec.cancellation as { kind?: unknown } | undefined)?.kind;
  if (cancellationKind !== 'abort_signal' && cancellationKind !== 'transaction') {
    throw new ToolConformanceHarnessError(
      `extended sweep: tool "${tool.name}" action "${action}" is a scoped_mutation with no valid cancellation contract`,
    );
  }

  if (!allowScopedMutations) {
    // Default (unflagged) extended run: classified, execution withheld.
    return { ...base, ok: true, skipped: true, durationMs: 0 };
  }

  const started = monotonicNow();
  const { outcome: mutation, terminated } = await executeMutationWithCancellation(
    tool, spec.args, timeoutMs, timeoutMs,
  );

  if (mutation.kind === 'timeout' && !terminated) {
    // The mutation exceeded its budget and did NOT honor cancellation within the
    // grace window — it may still be in flight. Withhold teardown so cleanup can
    // never race a live mutation, and fail closed.
    const durationMs = Math.max(0, monotonicNow() - started);
    return {
      ...base,
      ok: false,
      durationMs,
      classification: 'mutation_uncancellable',
      error: `mutation exceeded ${timeoutMs}ms and did not honor cancellation within ${timeoutMs}ms; teardown withheld to avoid racing an in-flight mutation`,
    };
  }

  // The mutation has TERMINATED (settled normally, or aborted-and-settled). Only
  // now is teardown safe — it can never commit after a still-running mutation.
  const cleanup = await executeWithTimeout(tool, spec.cleanup.args, timeoutMs);
  const durationMs = Math.max(0, monotonicNow() - started);

  const mutationFailure = classifyExecuteOutcome(mutation, timeoutMs);
  if (mutationFailure) {
    return { ...base, ok: false, durationMs, classification: mutationFailure.classification, error: mutationFailure.error };
  }
  const cleanupFailure = classifyExecuteOutcome(cleanup, timeoutMs);
  if (cleanupFailure) {
    return {
      ...base,
      ok: false,
      durationMs,
      classification: 'cleanup_failed',
      error: `cleanup ${cleanupFailure.classification}: ${cleanupFailure.error}`,
    };
  }
  return { ...base, ok: true, durationMs };
}

/**
 * Run every classified action of one tool. Fails closed (ToolConformanceHarnessError)
 * when a canonical action-aware tool has an action with no per-action classification —
 * the runtime mirror of the static coverage test.
 */
async function runExtendedActionProbes(
  tool: AgentTool<any>,
  timeoutMs: number,
  monotonicNow: () => number,
  allowScopedMutations: boolean,
  resolveCanonicalActions: (toolName: string) => readonly string[] | undefined,
  resolveActionProbes: (toolName: string) => Readonly<Record<string, ActionProbeSpec>> | undefined,
): Promise<ToolConformanceProbeResult[]> {
  // Coverage is SCHEMA-authoritative: the action set is the union of the
  // hand-maintained canonical list and the literals the tool ACTUALLY declares
  // in its live parameter schema. A verb added to the schema (and handler)
  // without a conformance classification therefore still gets probed and fails
  // closed below, instead of silently escaping because the tool-surface list was
  // not updated (bead 65rk.7 fix for finding 1). Union (never subset) so a schema
  // whose action shape the extractor cannot parse never drops existing coverage.
  const registryActions = resolveCanonicalActions(tool.name) ?? [];
  const schemaActions = extractSchemaActionLiterals(tool.parameters);
  const seen = new Set<string>();
  const actions: string[] = [];
  for (const action of [...registryActions, ...schemaActions]) {
    if (seen.has(action)) continue;
    seen.add(action);
    actions.push(action);
  }
  if (actions.length === 0) return [];
  const actionProbes = resolveActionProbes(tool.name);
  const results: ToolConformanceProbeResult[] = [];
  for (const action of actions) {
    const spec = actionProbes ? actionProbes[action] : undefined;
    if (!spec) {
      throw new ToolConformanceHarnessError(
        `extended sweep: tool "${tool.name}" action "${action}" has no per-action probe classification`,
      );
    }
    if (spec.kind === 'safe_read') {
      results.push(await runSafeReadActionProbe(tool, action, spec, timeoutMs, monotonicNow));
    } else if (spec.kind === 'scoped_mutation') {
      results.push(await runScopedMutationActionProbe(tool, action, spec, timeoutMs, monotonicNow, allowScopedMutations));
    } else {
      results.push(runSchemaAssertActionProbe(tool, action, monotonicNow));
    }
  }
  return results;
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

  const extended = input.extended === true;
  const allowScopedMutations = input.allowScopedMutations === true;
  const resolveCanonicalActions = input.resolveCanonicalActions
    ?? ((toolName: string) => getCanonicalToolSurface(toolName)?.actions);
  const resolveActionProbes = input.resolveActionProbes ?? getToolActionProbes;

  const results: ToolConformanceProbeResult[] = [];
  for (const tool of input.tools) {
    const spec = resolveProbeSpec(tool.name);
    if (!spec) continue; // unreachable: guarded above

    if (extended) {
      const actionResults = await runExtendedActionProbes(
        tool, timeoutMs, monotonicNow, allowScopedMutations, resolveCanonicalActions, resolveActionProbes,
      );
      if (actionResults.length > 0) {
        // Action-aware tool: per-action probes replace the single per-tool probe.
        results.push(...actionResults);
      } else if (spec.kind === 'read_only') {
        // Action-less tool: reuse the default per-tool probe.
        results.push(await runReadOnlyProbe(tool, spec, timeoutMs, monotonicNow));
      } else {
        results.push(runSchemaOnlyProbe(tool, monotonicNow));
      }
    } else if (spec.kind === 'read_only') {
      results.push(await runReadOnlyProbe(tool, spec, timeoutMs, monotonicNow));
    } else {
      results.push(runSchemaOnlyProbe(tool, monotonicNow));
    }

    const rejection = await runRejectionProbe(tool, timeoutMs, monotonicNow);
    if (rejection) results.push(rejection);
  }

  if (extended) {
    // REPL-only sandbox helper probes (execution-free, LLM-free).
    results.push(...runSandboxHelperProbes(monotonicNow));
  }

  return {
    schemaVersion: TOOL_CONFORMANCE_SCHEMA_VERSION,
    ranAt: now(),
    trigger: input.trigger,
    results,
    // `mode` is present ONLY on extended runs; a default run omits it so its
    // persisted JSON stays byte-compatible with the rollout-gate consumer.
    ...(extended ? { mode: 'extended' as const } : {}),
  };
}
