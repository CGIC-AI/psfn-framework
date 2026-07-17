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

/**
 * Probe kinds.
 *   - read_only / schema_only : the default per-tool probes (byte-stable
 *     rollout-gate contract; never removed).
 *   - rejection_check         : required-action empty-args regression probe.
 *   - safe_read / scoped_mutation / schema_assert : the per-action extended
 *     probes (only emitted when the sweep runs in extended mode).
 *   - sandbox_helper          : REPL-only sandbox host-helper wiring/gate probe.
 */
export type ToolConformanceProbeKind =
  | 'read_only'
  | 'schema_only'
  | 'rejection_check'
  | 'safe_read'
  | 'scoped_mutation'
  | 'schema_assert'
  | 'sandbox_helper';

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
  | 'missing_required_fields'
  // Extended-mode classifications.
  | 'cleanup_failed'
  // A scoped_mutation handler that exceeded its timeout and did NOT honor
  // cancellation (settle) within the grace window. Teardown is withheld so the
  // sweep never runs cleanup against an in-flight mutation (bead 65rk.7 fix).
  | 'mutation_uncancellable'
  | 'gate_inconsistent'
  | 'helper_missing';

export interface ToolConformanceProbeResult {
  toolName: string;
  probeKind: ToolConformanceProbeKind;
  /** Present for read_only probes (the action exercised) and rejection_check probes. */
  action?: string;
  ok: boolean;
  durationMs: number;
  /**
   * True when a scoped_mutation probe was recorded but deliberately NOT executed
   * because the caller did not pass the isolated-scope flag. A skipped probe is a
   * pass (ok:true) with no classification — it means "classified, execution
   * withheld", never a silent failure.
   */
  skipped?: boolean;
  classification?: ToolConformanceClassification;
  error?: string;
}

export interface ToolConformanceRunResult {
  schemaVersion: typeof TOOL_CONFORMANCE_SCHEMA_VERSION;
  ranAt: number;
  trigger: ToolConformanceTrigger;
  results: ToolConformanceProbeResult[];
  /**
   * Present ONLY on extended-mode runs. A default (per-tool) run omits this field
   * entirely so its persisted JSON stays byte-compatible with the kube
   * post-rollout gate and self_status diagnosis consumers.
   */
  mode?: 'extended';
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
