// ── Tool-surface conformance harness: shared contracts ──
//
// A live, LLM-free smoke that verifies every registered first-party direct tool
// responds correctly to a SAFE probe. Born from the 2026-07-06 incident where a
// hand-rolled sweep ran ~110 tool calls inside a live Discord DM and wrote the
// observations into the companion's own transcript. The harness NEVER runs an
// LLM in the probe loop and NEVER writes tool observations into a conversational
// session store: probes execute tool handlers directly and their results are
// aggregated in memory, not persisted as session entries.
//
// The result file schema below is a stable cross-workstream contract. Another
// workstream reads <system-data>/state/tool-conformance-latest.json. Do not
// reshape these fields without coordinating that reader.

export const TOOL_CONFORMANCE_SCHEMA_VERSION = 1 as const;

export type ToolConformanceTrigger = 'manual' | 'post_rollout' | 'scheduled';

export type ToolConformanceProbeKind = 'read_only' | 'schema_only' | 'rejection_check';

/**
 * Failure classification. Absent on a passing probe. Fail-closed: any throw,
 * timeout, malformed output, or an accepted empty-args mutation is a
 * conformance failure with an explicit classification, never a silent pass.
 */
export type ToolConformanceClassification =
  | 'threw'
  | 'timeout'
  | 'malformed_output'
  | 'returned_error'
  | 'accepted_empty_args'
  | 'schema_invalid'
  | 'missing_required_fields';

export interface ToolConformanceProbeResult {
  toolName: string;
  probeKind: ToolConformanceProbeKind;
  /** Present for read_only probes (the action exercised) and rejection_check probes. */
  action?: string;
  ok: boolean;
  durationMs: number;
  classification?: ToolConformanceClassification;
  error?: string;
}

export interface ToolConformanceRunResult {
  schemaVersion: typeof TOOL_CONFORMANCE_SCHEMA_VERSION;
  ranAt: number;
  trigger: ToolConformanceTrigger;
  results: ToolConformanceProbeResult[];
}

/**
 * Raised only for harness-level failures (an unclassified live tool, an
 * unreachable tool catalog, a result-file write failure). Distinct from
 * per-tool conformance failures, which are recorded as result entries with
 * `ok: false`. Callers surface a harness error as an operational fault, not as
 * a tool regression.
 */
export class ToolConformanceHarnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolConformanceHarnessError';
  }
}
