// ── Tool-surface conformance runner ──
//
// The single entry point shared by both trigger surfaces: the companion-facing
// self_status action="conformance" and the operator-facing Garden admin route.
// It gathers the LIVE tool catalog, runs the LLM-free sweep, persists the
// result, and returns it. Harness-level failures (unclassified live tool,
// unreachable catalog, write failure) propagate so callers can distinguish an
// operational fault from per-tool conformance failures.

import type { AgentTool } from '../../../boundary/pi-agent/index.js';
import { runToolConformanceSweep, DEFAULT_PER_PROBE_TIMEOUT_MS } from './harness.js';
import { readToolConformanceLatest, writeToolConformanceResult } from './store.js';
import type { ToolConformanceRunResult, ToolConformanceTrigger } from './types.js';
import type { GatewaySystemDataWriterPort } from '../../../boundary/gateway/system-data-writer.js';

export interface ToolConformanceRunOptions {
  /**
   * Opt-in per-action coverage (bead 65rk.7). Absent/false → the legacy per-tool
   * sweep whose persisted result is byte-compatible with the rollout-gate consumer.
   */
  extended?: boolean;
  /**
   * Isolated-scope flag: only meaningful with `extended`. Executes scoped_mutation
   * probes against the internal:tool-conformance channel with cleanup. Default runs
   * never execute mutations.
   */
  allowScopedMutations?: boolean;
}

export interface ToolConformanceRunner {
  run(trigger: ToolConformanceTrigger, options?: ToolConformanceRunOptions): Promise<ToolConformanceRunResult>;
  getLatest(): ToolConformanceRunResult | null;
}

export interface ToolConformanceRunnerDeps {
  /** Live registered direct tools (core + extended), executable handlers. */
  getToolCatalog: () => { core: readonly AgentTool<any>[]; extended: readonly AgentTool<any>[] };
  /** System-owned data root; results land under <systemDataDir>/state. */
  systemDataDir: string;
  /** Fleet mode routes writes to the gateway while this process keeps a read-only mount. */
  systemDataWriter?: GatewaySystemDataWriterPort;
  perProbeTimeoutMs?: number;
  now?: () => number;
}

export function createToolConformanceRunner(deps: ToolConformanceRunnerDeps): ToolConformanceRunner {
  const perProbeTimeoutMs = deps.perProbeTimeoutMs ?? DEFAULT_PER_PROBE_TIMEOUT_MS;
  let latestInProcess: ToolConformanceRunResult | null = null;
  return {
    async run(trigger: ToolConformanceTrigger, options?: ToolConformanceRunOptions): Promise<ToolConformanceRunResult> {
      const catalog = deps.getToolCatalog();
      const tools = [...catalog.core, ...catalog.extended];
      const result = await runToolConformanceSweep({
        tools,
        trigger,
        perProbeTimeoutMs,
        ...(deps.now ? { now: deps.now } : {}),
        ...(options?.extended ? { extended: true } : {}),
        ...(options?.allowScopedMutations ? { allowScopedMutations: true } : {}),
      });
      if (deps.systemDataWriter) {
        await deps.systemDataWriter.writeSystemData({
          kind: 'tool_conformance',
          payload: result,
        });
      } else {
        writeToolConformanceResult(deps.systemDataDir, result);
      }
      latestInProcess = result;
      return result;
    },
    getLatest(): ToolConformanceRunResult | null {
      const persisted = readToolConformanceLatest(deps.systemDataDir);
      if (!persisted) return latestInProcess;
      if (!latestInProcess) return persisted;
      return persisted.ranAt >= latestInProcess.ranAt
        ? persisted
        : latestInProcess;
    },
  };
}
