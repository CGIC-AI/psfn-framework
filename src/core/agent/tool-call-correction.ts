// ── Tool-call validate-and-reprompt corrections (psfn-framework-b0yl.3) ──
//
// When a model emits a *recoverable* tool-call defect — an unknown/retired tool
// name, non-object ("malformed JSON") arguments, or arguments that fail the
// tool's schema — the runtime must not drop the turn or silently run a
// defaulted action. The universal pattern across surveyed harnesses (Hermes
// re-inject, Codex RespondToModel, opencode Zod-error rewrite) is to feed a
// corrective tool result back to the model so its next completion reprompts
// with a fixed call. This module builds those corrective results and classifies
// the defect for telemetry.
//
// Scope boundary: this module only shapes the corrective *result text* and its
// classification. The bounded retry budget is enforced by the tool-call
// scheduler guard (failureCountsBySignature + repeated-malformed skip), which
// degrades a signature after too many attempts so a model that keeps emitting
// the same broken call cannot loop forever.

import { isRecord } from '../../shared/utils/types.js';
import { getRetiredToolAlias } from './tool-surface/registry.js';

export type ToolCallDefectClass =
  | 'unknown_tool'
  | 'malformed_arguments'
  | 'schema_invalid';

export interface ToolCallCorrection {
  defectClass: ToolCallDefectClass;
  /** Corrective tool-result text fed back to the model to reprompt the call. */
  text: string;
  /** Nearest valid tool name, when one can be confidently suggested. */
  suggestion?: string;
}

/** Cap how many catalog names are echoed so the corrective note stays compact. */
const MAX_ECHOED_CATALOG_NAMES = 24;

function levenshtein(a: string, b: string): number {
  const cols = b.length + 1;
  const dist = new Array<number>(cols);
  for (let j = 0; j < cols; j += 1) dist[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    let prev = dist[0] as number;
    dist[0] = i;
    for (let j = 1; j < cols; j += 1) {
      const temp = dist[j] as number;
      dist[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dist[j] as number, dist[j - 1] as number);
      prev = temp;
    }
  }
  return dist[cols - 1] as number;
}

/**
 * Suggest the nearest available tool name for a mistyped/hallucinated name.
 * Only returns a name that is genuinely close (bounded edit distance) so the
 * correction never steers the model toward an unrelated tool.
 */
export function suggestNearestToolName(
  name: string,
  availableToolNames: readonly string[],
): string | undefined {
  const target = name.trim().toLowerCase();
  if (!target) return undefined;
  let best: { name: string; distance: number } | undefined;
  for (const candidate of availableToolNames) {
    const normalized = candidate.trim().toLowerCase();
    if (!normalized) continue;
    const distance = normalized === target ? 0 : levenshtein(target, normalized);
    if (!best || distance < best.distance) {
      best = { name: candidate, distance };
    }
  }
  if (!best) return undefined;
  // Only suggest a genuinely close name — never a random catalog entry.
  const threshold = Math.max(2, Math.floor(target.length / 3));
  return best.distance <= threshold ? best.name : undefined;
}

function describeArgumentShape(args: unknown): string {
  if (args === null) return 'null';
  if (Array.isArray(args)) return 'a JSON array';
  const type = typeof args;
  if (type === 'string') return 'a JSON string';
  if (type === 'number' || type === 'boolean') return `a JSON ${type}`;
  if (type === 'undefined') return 'no arguments';
  return type;
}

/**
 * A tool call whose top-level arguments are not a JSON object. Providers that
 * drop/garble a tool call's argument fragment can surface a bare string, array,
 * number, or null here; the tool schema always expects a parameters object, so
 * these are structurally malformed and cannot be schema-validated. An empty
 * object (`{}`) is intentionally NOT malformed — it is a valid object that the
 * schema validator rejects on required properties (the schema_invalid class).
 * `undefined` is left to the schema validator (the corrupt-empty-args path).
 */
export function isMalformedToolArguments(args: unknown): boolean {
  return args !== undefined && !isRecord(args);
}

/**
 * Build the corrective result for a call to a tool that does not exist in the
 * live catalog. Retired first-party aliases resolve to their canonical
 * replacement (and action) via the retired-alias machinery; otherwise the
 * nearest catalog name is offered and the available names are echoed.
 */
export function buildUnknownToolCorrection(
  toolName: string,
  availableToolNames: readonly string[],
): ToolCallCorrection {
  const retired = getRetiredToolAlias(toolName);
  if (retired) {
    const actionHint = retired.replacementAction
      ? ` with action="${retired.replacementAction}"`
      : '';
    return {
      defectClass: 'unknown_tool',
      suggestion: retired.canonicalName,
      text: `Tool "${toolName}" is not callable: it was retired. Call "${retired.canonicalName}"${actionHint} instead — ${retired.reason} Re-issue the call using the current tool name.`,
    };
  }
  const nearest = suggestNearestToolName(toolName, availableToolNames);
  const didYouMean = nearest ? ` Did you mean "${nearest}"?` : '';
  const catalog = [...availableToolNames]
    .filter((entry) => entry.trim().length > 0)
    .sort();
  const echoed = catalog.slice(0, MAX_ECHOED_CATALOG_NAMES);
  const overflow = catalog.length > echoed.length ? ', …' : '';
  const catalogHint = echoed.length > 0
    ? ` Available tools: ${echoed.join(', ')}${overflow}.`
    : '';
  return {
    defectClass: 'unknown_tool',
    ...(nearest ? { suggestion: nearest } : {}),
    text: `Tool "${toolName}" is not an available tool.${didYouMean} Call one of the available tools by its exact name, or use toolset action="describe" to inspect a tool's schema first.${catalogHint}`,
  };
}

/**
 * Build the corrective result for a tool call whose arguments are not a JSON
 * object (see isMalformedToolArguments). Echoes the observed shape so the model
 * knows what it emitted and can re-issue a valid parameters object.
 */
export function buildMalformedArgumentsCorrection(
  toolName: string,
  args: unknown,
): ToolCallCorrection {
  return {
    defectClass: 'malformed_arguments',
    text: `Tool "${toolName}" received malformed arguments (${describeArgumentShape(args)}); tool arguments must be a single well-formed JSON object of the tool's parameters. Re-issue the call with a valid JSON object.`,
  };
}

/**
 * Wrap a schema validation failure message with an explicit reprompt
 * instruction. The original validation message (with the per-field errors and
 * the received arguments) is preserved verbatim so downstream diagnostics and
 * the repeated-malformed-argument classifier still parse it; only a corrective
 * instruction is appended.
 */
export function buildSchemaValidationCorrection(
  toolName: string,
  validationMessage: string,
): ToolCallCorrection {
  return {
    defectClass: 'schema_invalid',
    text: `${validationMessage}\n\nFix the arguments to match the schema above, then call "${toolName}" again with a complete JSON object in one tool call.`,
  };
}
