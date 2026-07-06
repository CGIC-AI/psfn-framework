// ── Admin tool-surface conformance service ──
//
// Operator-facing adapter over the agent-process ToolConformanceRunner. Exposes
// a manual/post-rollout trigger and a read of the latest persisted run. The
// sweep itself is LLM-free and never writes into a conversational session store.

import type { ToolConformanceRunner } from '../../../core/agent/tool-conformance/runner.js';
import type {
  ToolConformanceRunResult,
  ToolConformanceTrigger,
} from '../../../core/agent/tool-conformance/types.js';

export interface AdminToolConformanceService {
  run(trigger: ToolConformanceTrigger): Promise<ToolConformanceRunResult>;
  getLatest(): ToolConformanceRunResult | null;
}

export function createAdminToolConformanceService(
  runner: ToolConformanceRunner,
): AdminToolConformanceService {
  return {
    run: (trigger) => runner.run(trigger),
    getLatest: () => runner.getLatest(),
  };
}
