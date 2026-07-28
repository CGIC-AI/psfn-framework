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
import { resolveCorrelationMetadata } from '../../primitives/llm/correlation.js';
import { buildLLMWorkSpec } from '../../primitives/llm/work-spec.js';
import { COMPANION_PRIVATE_BACKGROUND_TELEMETRY } from '../../shared/telemetry/model-usage.js';

/**
 * The completion purpose every subagent model call declares. Mirrors the
 * task-focused worker execution policy's `modelPurpose` (`createWorkerExecutionPolicy`
 * for the subagent lane), so the work spec's lane resolves to the same runtime
 * class the bounded worker is admitted on.
 */
export const SUBAGENT_WORK_SPEC_PURPOSE = 'background' as const;

/**
 * Stable origin stage stamped on a subagent work spec's correlation in the normal
 * (operator-visible) case. Forcing `callType`/`originStage` (they win the client's
 * correlation merge) keeps lane derivation deterministic for a non-private context
 * — those are the lane-relevant fields the single resolver reads on that path.
 *
 * This does NOT cover the companion_private case: a `companion_private`
 * telemetryVisibility short-circuits the single lane resolver, collapsing
 * origin/purpose to {@link COMPANION_PRIVATE_BACKGROUND_PURPOSE} and thereby
 * *overriding* this origin stage. That field is lane-relevant too, so it cannot be
 * neutralized by stamping callType/originStage. {@link buildSubagentWorkSpec}
 * handles it by adopting the canonical collapsed telemetry shape below, so the
 * stored correlation agrees with the resolver's short-circuit by construction.
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
  const context = input.correlation ?? {};
  // Resolve telemetry visibility deterministically so the declared lane holds
  // parity by construction. When the context carries companion_private, the single
  // lane resolver takes its private short-circuit and derives the lane from
  // COMPANION_PRIVATE_BACKGROUND_PURPOSE — silently overriding a stamped
  // callType/originStage. Adopt the canonical collapsed background telemetry shape
  // in that case so the correlation we store is self-consistent with that
  // short-circuit (originStage/purpose already collapsed); the resolved lane is
  // then invariant to the short-circuit and the client's private collapse reflects
  // the spec byte-for-byte. Non-private contexts keep the subagent's background
  // stamp. Either way the built spec's `lane` is derived from — and stored
  // alongside — this same correlation, so `assertWorkSpecLaneParity` reconciles by
  // construction and can never brick a spawn.
  const correlation: Partial<CorrelationMetadata> = context.telemetryVisibility === 'companion_private'
    ? { ...context, ...COMPANION_PRIVATE_BACKGROUND_TELEMETRY }
    : { ...context, callType: 'background', originStage: SUBAGENT_WORK_SPEC_ORIGIN_STAGE };
  return buildLLMWorkSpec({
    purpose: SUBAGENT_WORK_SPEC_PURPOSE,
    durable: false,
    correlation,
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
    complete: (context, purpose, options) => {
      const injectSubagentSpec = options?.workSpec === undefined && purpose === spec.purpose;
      const hasInjectedCorrelation = injectSubagentSpec && (
        spec.correlation !== undefined || options?.correlation !== undefined
      );
      const preservePrivateCorrelation = spec.correlation?.telemetryVisibility === 'companion_private'
        || options?.correlation?.telemetryVisibility === 'companion_private';
      const injectedCorrelation = hasInjectedCorrelation
        ? (
            preservePrivateCorrelation
              ? resolveCorrelationMetadata(
                  spec.correlation,
                  {
                    ...(options?.correlation ?? {}),
                    telemetryVisibility: 'companion_private',
                  },
                  purpose,
                )
              : {
                  ...(spec.correlation ?? {}),
                  ...(options?.correlation ?? {}),
                }
          )
        : undefined;
      return provider.complete(context, purpose, {
        ...(options ?? {}),
        ...(injectSubagentSpec
          ? {
              workSpec: spec,
              // Completion providers resolve explicit option correlation rather
              // than workSpec.correlation. Merge partial caller overrides onto
              // the injected spec so omitted lane fields remain attributable;
              // either side declaring companion_private collapses the result.
              ...(injectedCorrelation ? { correlation: injectedCorrelation } : {}),
            }
          : {}),
      });
    },
  };
}
