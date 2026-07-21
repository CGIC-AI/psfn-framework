import type { CapabilityTier } from '../../system/config/runtime-config-contracts.js';
import { isRecord } from '../../shared/utils/types.js';

/**
 * Synchronous pre_tool_use decision contract (bead 7ym.3.1).
 *
 * The async lifecycle hook path (bead vvf.2, hook-registry.ts) is
 * fire-and-forget: handlers observe redacted events and can never influence
 * the pipeline. This module adds the SECOND, deliberately different invocation
 * mode reserved by that bead — a synchronous decision path that pauses a tool
 * call until an operator hook resolves, and lets that hook BLOCK the call,
 * rewrite its arguments, or add model-visible context before execution.
 *
 * SECURITY POSTURE — FAIL CLOSED
 * This path sits on a security-sensitive chokepoint (gateToolWithCapabilities,
 * bead 7ym.3.2). Every failure mode denies the call rather than allowing it:
 *  - a handler that throws BLOCKS the tool call;
 *  - a handler that times out BLOCKS the tool call — for handlers that yield
 *    to the event loop; a CPU-bound synchronous handler cannot be preempted
 *    in-process and will stall the turn instead (it still cannot fail open).
 *    True preemption needs async-only handlers or worker isolation;
 *  - a handler that returns a malformed decision BLOCKS the tool call;
 *  - a hook can only SUBTRACT authority (block) or rewrite arguments; it can
 *    never grant a capability. A rewritten input is re-validated against the
 *    tool schema AND re-run through the capability and egress gates by the
 *    enforcement site, so a hook can never approve what a capability gate
 *    rejects (bead 7ym.3.2 acceptance #4).
 *
 * TRUST MODEL
 * Unlike the async lifecycle projections, a decision hook receives the REAL,
 * un-redacted tool input: it fundamentally needs the arguments to decide
 * whether to block or rewrite them (e.g. deny a shell `rm -rf`). This matches
 * the vvf.2 trust model — decision hooks are operator-authored code at the
 * same trust level as workspace skills. Telemetry, however, is redacted: the
 * enforcement site records a content-free audit (see
 * {@link buildRedactedPreToolAudit}) and never logs argument contents.
 *
 * RECONCILIATION WITH b0yl VALIDATE-AND-REPROMPT (design note, bead 7ym.3.1)
 * b0yl.1/b0yl.3 (tool-call-correction.ts, tool-argument-repair.ts) run at the
 * tool-call scheduler, UPSTREAM of the gated execute: they repair malformed or
 * stringified-JSON arguments and re-validate against the tool's JSON schema
 * (pi-ai `validateToolArguments`) before calling the already-gated
 * `tool.execute`. Their intent is correctness/repair, and a repair that cannot
 * be applied falls back to the original arguments.
 *   The pre_tool_use modify path runs DOWNSTREAM, inside the gated execute,
 * and is for operator POLICY rewrites — not error correction. To keep the two
 * non-overlapping and both safe, a hook's `modifiedInput` is re-validated
 * against the same tool schema at the enforcement site; unlike b0yl repair, a
 * `modifiedInput` that fails schema validation BLOCKS fail-closed rather than
 * silently reverting to the original arguments. b0yl = correctness upstream;
 * pre_tool_use = operator policy downstream; both are schema-validated.
 */

/**
 * Immutable context handed to a synchronous pre_tool_use decision hook. Carries
 * the correlation/session/turn identity, capability tier, and the REAL tool
 * input the hook needs to make a decision.
 */
export interface PreToolUseHookContext {
  readonly toolName: string;
  /** Matcher aliases (retired names / surface aliases); may be empty. */
  readonly aliases: readonly string[];
  /**
   * Original, un-redacted tool input. A decision hook needs the real arguments
   * to block or rewrite them; see the trust-model note above.
   */
  readonly input: unknown;
  readonly capabilityTier: CapabilityTier;
  /** Reserved: permission mode when a runtime surfaces one; undefined today. */
  readonly permissionMode?: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly requestId?: string;
  readonly companionId?: string;
  readonly channelId?: string;
  readonly channelType?: string;
  /** Working directory / layout root when the caller can supply it. */
  readonly cwd?: string;
}

/**
 * The shape a decision hook SHOULD return. The runtime treats the actual return
 * as `unknown` and normalizes it fail-closed ({@link normalizePreToolResult}),
 * so this type documents intent for hook authors without trusting it at
 * runtime. Returning `undefined`/`null` (or nothing) is a no-op "allow".
 */
export interface PreToolUseHookResult {
  /**
   * Explicit verdict. `block`/`deny` stop the call; `allow`/`approve`/omitted
   * permit it. Any other value is malformed and blocks fail-closed.
   */
  decision?: 'allow' | 'approve' | 'block' | 'deny';
  /** Operator-facing reason; surfaced to the model when the call is blocked. */
  reason?: string;
  /** Replacement tool input; re-validated against the tool schema by the gate. */
  modifiedInput?: unknown;
  /** Model-visible context added to the tool result without changing the call. */
  additionalContext?: string;
}

/** A synchronous decision hook. Return value is untrusted and normalized. */
export type PreToolUseHookHandler = (context: PreToolUseHookContext) => unknown;

/** Normalized, trusted form of a single hook's decision. */
export interface NormalizedPreToolDecision {
  block: boolean;
  /** Present when `block` is true. */
  reason?: string;
  hasModifiedInput: boolean;
  /** Present when `hasModifiedInput` is true (may be any value; gate re-validates). */
  modifiedInput?: unknown;
  /** Non-empty model-visible context, if the hook supplied one. */
  additionalContext?: string;
}

const GENERIC_BLOCK_REASON = 'blocked by a pre_tool_use hook';

function blockDecision(reason: string): NormalizedPreToolDecision {
  return { block: true, reason, hasModifiedInput: false };
}

/**
 * Fail-closed normalization of an untrusted hook return value into a
 * {@link NormalizedPreToolDecision}. A non-object return, an unknown `decision`
 * verb, or a non-string `additionalContext` all resolve to a BLOCK. A
 * `null`/`undefined` return is a permissive no-op (the hook had no opinion).
 */
export function normalizePreToolResult(raw: unknown): NormalizedPreToolDecision {
  if (raw === undefined || raw === null) {
    return { block: false, hasModifiedInput: false };
  }
  if (!isRecord(raw)) {
    return blockDecision('pre_tool_use hook returned a non-object decision');
  }

  const decisionRaw = raw.decision;
  let blocking = false;
  if (decisionRaw !== undefined) {
    if (decisionRaw === 'block' || decisionRaw === 'deny') {
      blocking = true;
    } else if (decisionRaw !== 'allow' && decisionRaw !== 'approve') {
      return blockDecision(
        `pre_tool_use hook returned an unknown decision "${String(decisionRaw)}"`,
      );
    }
  }

  if (blocking) {
    const reason = typeof raw.reason === 'string' && raw.reason.trim().length > 0
      ? raw.reason.trim()
      : GENERIC_BLOCK_REASON;
    return blockDecision(reason);
  }

  // Non-blocking: validate the optional modify/augment payloads fail-closed.
  let additionalContext: string | undefined;
  if (raw.additionalContext !== undefined) {
    if (typeof raw.additionalContext !== 'string') {
      return blockDecision('pre_tool_use hook additionalContext must be a string');
    }
    if (raw.additionalContext.trim().length > 0) {
      additionalContext = raw.additionalContext;
    }
  }

  const hasModifiedInput = 'modifiedInput' in raw && raw.modifiedInput !== undefined;

  return {
    block: false,
    hasModifiedInput,
    ...(hasModifiedInput ? { modifiedInput: raw.modifiedInput } : {}),
    ...(additionalContext !== undefined ? { additionalContext } : {}),
  };
}

/** Combined outcome of evaluating every matching sync hook for one call. */
export interface PreToolUseEvaluation {
  outcome: 'allow' | 'block' | 'modified';
  /** Number of sync hooks whose matcher selected this tool call. */
  matchedHookCount: number;
  /** Names of the hooks actually evaluated, in order. */
  evaluatedHooks: readonly string[];
  /** Final tool input after applying any modifications, in evaluation order. */
  finalInput: unknown;
  /** True when at least one hook rewrote the input. */
  inputModified: boolean;
  /** Accumulated model-visible context blocks, in evaluation order. */
  additionalContext: readonly string[];
  /** Present when `outcome` is `block`. */
  blockReason?: string;
  /** Hook that produced the block (or the error/timeout that forced it). */
  blockingHook?: string;
}

/**
 * Consumer-facing port the capability gate (bead 7ym.3.2) uses to evaluate sync
 * pre_tool_use hooks and to record a redacted decision. Implemented by the
 * runtime adapter ({@link createPreToolHookGate}); kept as an interface so the
 * gate stays decoupled from the hook registry and request-context internals.
 */
export interface PreToolHookGate {
  /**
   * Evaluate matching sync hooks for this invocation. Returns `null` for the
   * fast path when no sync hook could match (or the registry has none), so the
   * gate skips all hook machinery.
   */
  evaluate(request: PreToolHookGateRequest): Promise<PreToolUseEvaluation | null>;
  /** Redacted telemetry sink; called once per evaluated invocation. */
  onDecision(audit: RedactedPreToolHookAudit): void;
}

export interface PreToolHookGateRequest {
  toolName: string;
  params: unknown;
  tier: CapabilityTier;
}

export type PreToolHookGateProvider = () => PreToolHookGate | null;

/**
 * Content-free audit of a pre_tool_use decision. Never carries argument or
 * context CONTENTS — only structural shape (top-level key names), counts, and
 * lengths — matching the redaction posture of the async lifecycle projectors
 * and companion-relay `redactToolActivity`.
 */
export interface RedactedPreToolHookAudit {
  toolName: string;
  tier: CapabilityTier;
  matchedHookCount: number;
  evaluatedHooks: readonly string[];
  outcome: 'allow' | 'block' | 'modified';
  blockingHook?: string;
  /** Length only — the reason text is model-facing but redacted from telemetry. */
  blockReasonLength?: number;
  inputModified: boolean;
  /** Top-level key names of the rewritten input (structural, never values). */
  modifiedInputKeys?: readonly string[];
  /** `typeof` tag when the rewritten input is not a plain object. */
  modifiedInputType?: string;
  additionalContextCount: number;
  additionalContextTotalLength: number;
}

/**
 * Build the redacted telemetry audit for a decision. Deliberately drops all
 * argument and context contents; keeps only shape, counts, and lengths.
 */
export function buildRedactedPreToolAudit(
  toolName: string,
  tier: CapabilityTier,
  evaluation: PreToolUseEvaluation,
): RedactedPreToolHookAudit {
  const audit: RedactedPreToolHookAudit = {
    toolName,
    tier,
    matchedHookCount: evaluation.matchedHookCount,
    evaluatedHooks: [...evaluation.evaluatedHooks],
    outcome: evaluation.outcome,
    inputModified: evaluation.inputModified,
    additionalContextCount: evaluation.additionalContext.length,
    additionalContextTotalLength: evaluation.additionalContext.reduce(
      (sum, entry) => sum + entry.length,
      0,
    ),
  };
  if (evaluation.blockingHook !== undefined) {
    audit.blockingHook = evaluation.blockingHook;
  }
  if (evaluation.blockReason !== undefined) {
    audit.blockReasonLength = evaluation.blockReason.length;
  }
  if (evaluation.inputModified) {
    if (isRecord(evaluation.finalInput)) {
      audit.modifiedInputKeys = Object.keys(evaluation.finalInput);
    } else {
      audit.modifiedInputType = evaluation.finalInput === null
        ? 'null'
        : Array.isArray(evaluation.finalInput)
          ? 'array'
          : typeof evaluation.finalInput;
    }
  }
  return audit;
}

/**
 * Structural port the adapter needs from the hook registry. Kept as an
 * interface so this module does not import {@link HookRegistry} (which imports
 * from here) — the concrete registry satisfies it structurally.
 */
export interface PreToolHookEvaluatorPort {
  hasSyncDecisionHooks(): boolean;
  evaluatePreToolUse(
    context: PreToolUseHookContext,
    options?: { timeoutMs?: number },
  ): Promise<PreToolUseEvaluation>;
}

/** Content-free correlation fields the adapter folds into the hook context. */
export interface PreToolCorrelationSnapshot {
  sessionId?: string;
  turnId?: string;
  requestId?: string;
  companionId?: string;
  channelId?: string;
  channelType?: string;
}

export interface CreatePreToolHookGateOptions {
  evaluator: PreToolHookEvaluatorPort;
  /** Reads the active turn's correlation (e.g. `getRequestContext`). */
  getCorrelation: () => PreToolCorrelationSnapshot | undefined;
  /** Redacted telemetry sink for every evaluated decision. */
  onDecision: (audit: RedactedPreToolHookAudit) => void;
  /** Override the per-hook fail-closed timeout. */
  timeoutMs?: number;
}

/**
 * Build the {@link PreToolHookGate} the capability gate consumes (bead 7ym.3).
 * Fast-paths to `null` when no sync hook is registered, otherwise enriches the
 * decision context with the active turn's correlation and delegates to the
 * registry's fail-closed evaluator.
 */
export function createPreToolHookGate(options: CreatePreToolHookGateOptions): PreToolHookGate {
  return {
    async evaluate(request: PreToolHookGateRequest): Promise<PreToolUseEvaluation | null> {
      if (!options.evaluator.hasSyncDecisionHooks()) return null;
      const correlation = options.getCorrelation() ?? {};
      const context: PreToolUseHookContext = {
        toolName: request.toolName,
        aliases: [],
        input: request.params,
        capabilityTier: request.tier,
        ...(correlation.sessionId ? { sessionId: correlation.sessionId } : {}),
        ...(correlation.turnId ? { turnId: correlation.turnId } : {}),
        ...(correlation.requestId ? { requestId: correlation.requestId } : {}),
        ...(correlation.companionId ? { companionId: correlation.companionId } : {}),
        ...(correlation.channelId ? { channelId: correlation.channelId } : {}),
        ...(correlation.channelType ? { channelType: correlation.channelType } : {}),
      };
      return options.evaluator.evaluatePreToolUse(
        context,
        options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {},
      );
    },
    onDecision: options.onDecision,
  };
}
