import type { AgentTool } from '../../../boundary/pi-agent/index.js';
import { viewerAdmitsSensitivity } from '../../session/session-viewer-access.js';
import { textResultWithError } from '../../tools/results.js';
import { TOOL_VIEWER_GATE_DECISIONS, resolveToolViewerGateDecision } from './viewer-gates.js';

/**
 * Enforce the `sensitivity` viewer-gate decisions centrally (o5wf5 sweep):
 * a read action over companion-wide records without source provenance runs
 * only when the request-context viewer's trust and room admit that
 * sensitivity. A call whose action cannot be resolved on a tool that has any
 * sensitivity-gated action is held to the strictest of them (fail closed).
 */
export function withViewerReadGate<T extends AgentTool<any>>(tool: T): T {
  const decisions = TOOL_VIEWER_GATE_DECISIONS[tool.name];
  if (!decisions) return tool;
  const gatedLevels = Object.values(decisions).flatMap(decision => (
    decision.kind === 'sensitivity' ? [decision.level] : []
  ));
  if (gatedLevels.length === 0) return tool;
  return {
    ...tool,
    execute: async (toolCallId: string, params: unknown, ...rest: unknown[]) => {
      const action = typeof (params as { action?: unknown } | null)?.action === 'string'
        ? ((params as { action: string }).action).trim()
        : undefined;
      const decision = resolveToolViewerGateDecision(tool.name, action || undefined);
      const required = decision
        ? (decision.kind === 'sensitivity' ? [decision.level] : [])
        : gatedLevels;
      if (!required.every(level => viewerAdmitsSensitivity(level))) {
        return textResultWithError(
          `${tool.name}${action ? ` action=${action}` : ''} is withheld by visibility gating: `
          + 'its records span other conversations and are not readable from this conversation.',
          true,
        );
      }
      return await (tool.execute as (...args: unknown[]) => unknown)(toolCallId, params, ...rest);
    },
  } as T;
}
