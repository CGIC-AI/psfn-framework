// mmo9.7.1 — the typed autonomous LLM client entry.
//
// `completeWithWorkSpec` is the sanctioned entry every autonomous / non-chat
// model call in src/core and src/faculties routes through. It REQUIRES an
// `LLMWorkSpec` (omission is a compile error) and forwards it to the underlying
// `LLMProviderPort.complete`, so the client can reconcile the declared lane and
// consume the ceilings/flags. A lint/AST test backstops any raw `.complete()`
// call that bypasses this entry.
//
// Law 12.4: this file constructs no admission, budget, or second lane resolver.
// It derives the declared lane through the SINGLE resolver
// (`resolveAutonomousModelCallLane`) and asserts it.

import type {
  CompletionPurpose,
  CorrelationMetadata,
  LLMContext,
  LLMModelHint,
  LLMResponse,
  LLMWorkCancellation,
  LLMWorkRetryPolicy,
  LLMWorkSpec,
} from '../../shared/contracts/runtime.js';
import type { RuntimeLaneClass } from '../../core/agent/worker-lanes.js';
import type { LLMProviderPort } from '../../core/agent/contracts.js';
import { resolveAutonomousModelCallLane } from './model-call-lane.js';

/**
 * Inputs to {@link buildLLMWorkSpec}. `lane` is intentionally NOT accepted — it
 * is derived from `purpose` + `correlation` through the single lane resolver so
 * callers cannot declare a drifting lane.
 */
export interface LLMWorkSpecInput {
  purpose: CompletionPurpose;
  durable: boolean;
  correlation?: Partial<CorrelationMetadata>;
  maxOutputTokens?: number;
  deadlineMs?: number;
  tokenCeiling?: number;
  costCeilingUsd?: number;
  cancellation?: LLMWorkCancellation;
  retryPolicy?: LLMWorkRetryPolicy;
  preemptionProtected?: boolean;
  /**
   * fxt1: the background-work `jobId` that granted this call's welfare
   * escalation. Paired with `preemptionProtected`; the gateway re-verifies it
   * against the store before honoring the flag. Set only by the sanctioned
   * post-turn welfare path.
   */
  welfareGrantJobId?: string;
}

/**
 * Build a typed {@link LLMWorkSpec}, deriving `lane` from the single resolver so
 * it reconciles byte-identically with the client's admission lane.
 */
export function buildLLMWorkSpec(input: LLMWorkSpecInput): LLMWorkSpec {
  const lane: RuntimeLaneClass = resolveAutonomousModelCallLane(input.purpose, input.correlation);
  return {
    purpose: input.purpose,
    lane,
    durable: input.durable,
    ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
    ...(input.deadlineMs !== undefined ? { deadlineMs: input.deadlineMs } : {}),
    ...(input.tokenCeiling !== undefined ? { tokenCeiling: input.tokenCeiling } : {}),
    ...(input.costCeilingUsd !== undefined ? { costCeilingUsd: input.costCeilingUsd } : {}),
    ...(input.cancellation !== undefined ? { cancellation: input.cancellation } : {}),
    ...(input.retryPolicy !== undefined ? { retryPolicy: input.retryPolicy } : {}),
    ...(input.preemptionProtected !== undefined
      ? { preemptionProtected: input.preemptionProtected }
      : {}),
    ...(input.welfareGrantJobId !== undefined
      ? { welfareGrantJobId: input.welfareGrantJobId }
      : {}),
    ...(input.correlation !== undefined ? { correlation: input.correlation } : {}),
  };
}

/**
 * Assert a declared `LLMWorkSpec.lane` reconciles with the single lane resolver
 * for its purpose + correlation. Fails closed on drift (Law 12.4). Called by the
 * client and available to tests.
 */
export function assertWorkSpecLaneParity(spec: LLMWorkSpec): void {
  const resolvedLane = resolveAutonomousModelCallLane(spec.purpose, spec.correlation);
  if (spec.lane !== resolvedLane) {
    throw new Error(
      `LLMWorkSpec.lane "${spec.lane}" does not reconcile with the runtime lane resolver `
      + `"${resolvedLane}" for purpose "${spec.purpose}" (Law 12.4: no second lane resolver)`,
    );
  }
}

export interface CompleteWithWorkSpecOptions {
  signal?: AbortSignal;
  modelHint?: LLMModelHint;
}

/**
 * The typed autonomous LLM completion entry. `spec` is REQUIRED, so an
 * autonomous call cannot omit its work spec. Forwards the spec on the completion
 * options and threads the spec's correlation through the existing correlation
 * channel (preserving companion-private collapse + ICP field-agreement, which
 * the client's correlation resolver still owns).
 */
export function completeWithWorkSpec(
  provider: Pick<LLMProviderPort, 'complete'>,
  context: LLMContext,
  spec: LLMWorkSpec,
  options?: CompleteWithWorkSpecOptions,
): Promise<LLMResponse> {
  // Return the provider promise directly (no async wrapper) so the caller's
  // await behaves byte-identically to a direct `provider.complete(...)` call and
  // no extra microtask hop is introduced into timing-sensitive dispatch paths.
  return provider.complete(context, spec.purpose, {
    workSpec: spec,
    ...(spec.correlation ? { correlation: spec.correlation } : {}),
    ...(options?.signal ? { signal: options.signal } : {}),
    ...(options?.modelHint ? { modelHint: options.modelHint } : {}),
  });
}
