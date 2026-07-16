// mmo9.7.7 — subagent typed work-spec seam.
//
// Bounded subagent runs carry a typed `LLMWorkSpec` (mmo9.7.1). This module is
// the single place that BUILDS that spec for a subagent and THREADS it onto the
// bounded worker's model calls through the existing client boundary
// (`options.workSpec`). Law 12.4: it constructs no admission/budget/second lane
// resolver — the declared lane is derived through the ONE resolver
// (`buildLLMWorkSpec` → `resolveAutonomousModelCallLane`) so the client
// reconciles it byte-identically.

import type { CorrelationMetadata, LLMWorkSpec } from '../../shared/contracts/runtime.js';
import type { LLMProviderPort } from '../../core/agent/contracts.js';
import { buildLLMWorkSpec } from '../../primitives/llm/work-spec.js';

/**
 * The completion purpose every subagent model call declares. Mirrors the
 * task-focused worker execution policy's `modelPurpose` (`createWorkerExecutionPolicy`
 * for the subagent lane), so the work spec's lane resolves to the same runtime
 * class the bounded worker is admitted on.
 */
export const SUBAGENT_WORK_SPEC_PURPOSE = 'background' as const;

/**
 * Stable origin stage stamped on the subagent work spec's correlation. Forcing
 * `callType`/`originStage` here (they win the client's correlation merge) keeps
 * the lane derivation deterministic and parity-safe regardless of whatever the
 * bounded turn's own context correlation carries — the only lane-relevant fields
 * that could otherwise leak from context are overridden to background values.
 */
export const SUBAGENT_WORK_SPEC_ORIGIN_STAGE = 'subagent.turn' as const;

export interface BuildSubagentWorkSpecInput {
  /** Caller correlation (channel/request/turn/charge lineage) to carry, if any. */
  correlation?: Partial<CorrelationMetadata>;
  /** Advisory wall-clock budget in ms; curtails a multi-turn run when exceeded. */
  deadlineMs?: number;
  /** Output-token ceiling; curtails a multi-turn run once accumulated output hits it. */
  maxOutputTokens?: number;
}

/**
 * Build the typed {@link LLMWorkSpec} a bounded subagent run carries. Purpose is
 * always background (the task-focused worker purpose) and the run is ephemeral
 * (`durable: false`) — subagents intentionally own no durable post-turn lane. The
 * lane is derived through the single resolver so it reconciles with the client's
 * admission lane (Law 12.4).
 */
export function buildSubagentWorkSpec(input: BuildSubagentWorkSpecInput = {}): LLMWorkSpec {
  return buildLLMWorkSpec({
    purpose: SUBAGENT_WORK_SPEC_PURPOSE,
    durable: false,
    correlation: {
      ...(input.correlation ?? {}),
      callType: 'background',
      originStage: SUBAGENT_WORK_SPEC_ORIGIN_STAGE,
    },
    ...(input.deadlineMs !== undefined ? { deadlineMs: input.deadlineMs } : {}),
    ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
  });
}

/**
 * Wrap the LLM provider handed to a bounded subagent's SubstrateAgent so its
 * model calls carry `spec` on the mmo9.7.1 client seam (`options.workSpec`),
 * threading admission/accounting attribution through the existing client
 * boundary. No new admission logic:
 * - `stream()` (the bounded turn's generation) inherits the spec when the caller
 *   did not already supply one. The streaming seam then honors the spec's
 *   purpose + correlation instead of hardcoding 'chat'.
 * - `complete()` inherits the spec ONLY when the call's purpose matches the
 *   spec's purpose, so an internal call of a different purpose is never
 *   mis-attributed (fail closed — the client's own reconciliation is never
 *   fought). Calls that already carry a work spec (mmo9.7.1-adopted autonomous
 *   entries) are left untouched.
 */
export function createSubagentWorkSpecProvider(
  provider: LLMProviderPort,
  spec: LLMWorkSpec,
): LLMProviderPort {
  return {
    stream: (context, callbacks, options) => provider.stream(context, callbacks, {
      ...(options ?? {}),
      workSpec: options?.workSpec ?? spec,
    }),
    complete: (context, purpose, options) => provider.complete(context, purpose, {
      ...(options ?? {}),
      ...(options?.workSpec === undefined && purpose === spec.purpose
        ? { workSpec: spec }
        : {}),
    }),
  };
}
