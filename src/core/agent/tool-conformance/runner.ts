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

export interface ToolConformanceRunner {
  run(trigger: ToolConformanceTrigger): Promise<ToolConformanceRunResult>;
  getLatest(): ToolConformanceRunResult | null;
}

export interface ToolConformanceRunnerDeps {
  /** Live registered direct tools (core + extended), executable handlers. */
  getToolCatalog: () => { core: readonly AgentTool<any>[]; extended: readonly AgentTool<any>[] };
  /** System-owned data root; results land under <systemDataDir>/state. */
  systemDataDir: string;
  perProbeTimeoutMs?: number;
  now?: () => number;
}

export function createToolConformanceRunner(deps: ToolConformanceRunnerDeps): ToolConformanceRunner {
  const perProbeTimeoutMs = deps.perProbeTimeoutMs ?? DEFAULT_PER_PROBE_TIMEOUT_MS;
  return {
    async run(trigger: ToolConformanceTrigger): Promise<ToolConformanceRunResult> {
      const catalog = deps.getToolCatalog();
      const tools = [...catalog.core, ...catalog.extended];
      const result = await runToolConformanceSweep({
        tools,
        trigger,
        perProbeTimeoutMs,
        ...(deps.now ? { now: deps.now } : {}),
      });
      writeToolConformanceResult(deps.systemDataDir, result);
      return result;
    },
    getLatest(): ToolConformanceRunResult | null {
      return readToolConformanceLatest(deps.systemDataDir);
    },
  };
}
