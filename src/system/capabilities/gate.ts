import { Value } from '@sinclair/typebox/value';
import type { AgentTool, AgentToolResult } from '../../boundary/pi-agent/index.js';
import type { TextContent } from '@mariozechner/pi-ai';
import type { CapabilityTier } from '../config/runtime-config-contracts.js';
import type { CapabilityAccess, CapabilityAccessProvider } from './access.js';
import type { CapabilityToken } from './tokens.js';
import { resolveToolCapabilityRequirement } from './requirements.js';
import { evaluateEligibilityDecision } from './eligibility.js';
import {
  buildRedactedPreToolAudit,
  type PreToolHookGateProvider,
} from '../../boundary/gateway/pre-tool-hook.js';

export type { CapabilityAccess, CapabilityAccessProvider } from './access.js';

export interface ToolCapabilityEligibility {
  allowed: boolean;
  requiredTokens: CapabilityToken[];
  missingTokens: CapabilityToken[];
  /**
   * True when the tool declares no capability-requirement path at all. Such a
   * tool is refused fail-closed rather than treated as unrestricted (02-M2):
   * an empty requirement set is otherwise allowed at every tier, so a tool with
   * no resolver/annotation/static entry would silently bypass gating.
   */
  undeclared?: boolean;
}

export function evaluateToolCapabilityEligibility(
  tool: AgentTool<any>,
  params: unknown,
  access: CapabilityAccess,
): ToolCapabilityEligibility {
  const resolution = resolveToolCapabilityRequirement(tool, params);
  if (!resolution.declared) {
    return {
      allowed: false,
      requiredTokens: [],
      missingTokens: [],
      undeclared: true,
    };
  }
  const decision = evaluateEligibilityDecision(
    access,
    { kind: 'tool.execute', toolName: tool.name },
    { requiredTokens: resolution.tokens },
  );
  return {
    allowed: decision.allowed,
    requiredTokens: resolution.tokens,
    missingTokens: decision.missingTokens,
  };
}

function toTextResult(
  text: string,
  details: Record<string, unknown>,
): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: 'text', text }] satisfies TextContent[],
    details,
  };
}

function undeclaredResult(
  toolName: string,
  tier: CapabilityTier,
): AgentToolResult<Record<string, unknown>> {
  return toTextResult(
    `Capability denied: tool "${toolName}" declares no capability requirement and is refused fail-closed. `
    + `A tool must declare a required capability (or an explicit "no requirement") to be eligible; an `
    + `undeclared tool would otherwise be allowed at every tier.`,
    {
      isError: true,
      capabilityDenied: true,
      capabilityUndeclared: true,
      tier,
    },
  );
}

function deniedResult(
  toolName: string,
  tier: CapabilityTier,
  missingTokens: readonly CapabilityToken[],
  grantedTokens: ReadonlySet<CapabilityToken>,
): AgentToolResult<Record<string, unknown>> {
  const grantedText = [...grantedTokens].join(', ') || 'none';
  const requiredText = missingTokens.join(', ');
  return toTextResult(
    `Capability denied: tool "${toolName}" requires ${requiredText}, but tier "${tier}" only grants ${grantedText}.`,
    {
      isError: true,
      capabilityDenied: true,
      tier,
      missingTokens,
    },
  );
}

function hookBlockedResult(
  toolName: string,
  reason: string | undefined,
  blockingHook: string | undefined,
): AgentToolResult<Record<string, unknown>> {
  const detail = reason ?? 'blocked by a pre_tool_use policy hook';
  return toTextResult(
    `Tool "${toolName}" was blocked before execution by a pre_tool_use policy hook: ${detail}`,
    {
      isError: true,
      hookBlocked: true,
      policyDenied: true,
      toolName,
      ...(blockingHook !== undefined ? { blockingHook } : {}),
    },
  );
}

function hookModifiedInputInvalidResult(
  toolName: string,
): AgentToolResult<Record<string, unknown>> {
  return toTextResult(
    `Tool "${toolName}" was blocked: a pre_tool_use hook rewrote its arguments into a shape that `
    + 'fails the tool input schema. Fail-closed: the rewritten call was not executed.',
    {
      isError: true,
      hookBlocked: true,
      hookModifiedInputInvalid: true,
      policyDenied: true,
      toolName,
    },
  );
}

/**
 * Append pre_tool_use hook context to a tool result as an extra model-visible
 * text block, without altering the tool's own output. The augment path lets an
 * operator hook add required context around a call it neither blocks nor
 * rewrites (bead 7ym.3.2 acceptance #3).
 */
function appendHookContext(
  result: AgentToolResult<unknown>,
  contexts: readonly string[],
): AgentToolResult<unknown> {
  const contextBlock: TextContent = {
    type: 'text',
    text: `[pre_tool_use hook context]\n${contexts.join('\n')}`,
  };
  return { ...result, content: [...result.content, contextBlock] };
}

/**
 * Structural egress-guard port (htm9.3). The intake firewall's tool-egress
 * sink gate plugs in here without this module importing cogsec internals.
 * `evaluate` returns null when the guard does not apply to this invocation
 * (non-egress tool, no guard active this turn); a non-null denied result
 * carries the operator-reviewed notice text returned to the model instead of
 * executing the tool.
 */
export interface EgressToolGuard {
  evaluate(input: {
    toolName: string;
    requiredTokens: readonly CapabilityToken[];
    /**
     * The invocation params, so a destination-aware guard (the CogSec outbound
     * disclosure gate, jp36.1.3) can derive the outward social destination from
     * a message/reaction send's channel/contact ids. Undefined for callers that
     * do not surface params.
     */
    params?: unknown;
  }): { allowed: boolean; noticeText: string } | null;
}

export type EgressToolGuardProvider = () => EgressToolGuard | null;

/**
 * Narrow transport-only escape hatch for capabilities whose authority lives at
 * a later privileged boundary. Returning true allows the tool implementation
 * to submit the request; it does not add the token to CapabilityAccess.
 */
export type CapabilityDeniedTransportPolicy = (input: {
  toolName: string;
  params: unknown;
  requiredTokens: readonly CapabilityToken[];
  missingTokens: readonly CapabilityToken[];
}) => boolean;

export function gateToolWithCapabilities<T extends AgentTool<any>>(
  tool: T,
  getAccess: CapabilityAccessProvider,
  getEgressGuard?: EgressToolGuardProvider,
  allowDeniedTransport?: CapabilityDeniedTransportPolicy,
  getPreToolHookGate?: PreToolHookGateProvider,
): T {
  const gated = {
    ...tool,
    execute: async (
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
    ): Promise<AgentToolResult<unknown>> => {
      const access = getAccess();

      // Capability eligibility + transport policy + the htm9.3 egress sink gate,
      // as one reusable check so a hook-rewritten input can be re-run through
      // the SAME gates. Returns a denial result, or null when the candidate is
      // allowed to execute. These gates always stay stricter than a hook: a
      // pre_tool_use hook can only block or rewrite, never widen authority.
      const gateCandidate = (candidate: unknown): AgentToolResult<unknown> | null => {
        const eligibility = evaluateToolCapabilityEligibility(tool, candidate, access);
        const transportAllowed = !eligibility.allowed
          && !eligibility.undeclared
          && eligibility.missingTokens.length > 0
          && allowDeniedTransport?.({
            toolName: tool.name,
            params: candidate,
            requiredTokens: eligibility.requiredTokens,
            missingTokens: eligibility.missingTokens,
          }) === true;
        if (!eligibility.allowed && !transportAllowed) {
          if (eligibility.undeclared) {
            return undeclaredResult(tool.name, access.getTier());
          }
          return deniedResult(
            tool.name,
            access.getTier(),
            eligibility.missingTokens,
            access.getGrantedTokens(),
          );
        }

        // htm9.3: tool-egress sink gate (lethal-trifecta invariant). Evaluated
        // per invocation with the current turn's intake context; a denied
        // egress returns the calm notice text instead of executing. Soft
        // (review) verdicts return allowed=true from the guard and are audited
        // there.
        const egressGuard = getEgressGuard?.() ?? null;
        if (egressGuard) {
          const egressDecision = egressGuard.evaluate({
            toolName: tool.name,
            requiredTokens: eligibility.requiredTokens,
            params: candidate,
          });
          if (egressDecision && !egressDecision.allowed) {
            return toTextResult(egressDecision.noticeText, {
              isError: true,
              egressGated: true,
              policyDenied: true,
              toolName: tool.name,
            });
          }
        }
        return null;
      };

      const originalDenial = gateCandidate(params);
      if (originalDenial) return originalDenial;

      // Synchronous pre_tool_use hooks (bead 7ym.3.2). Evaluated AFTER the
      // capability + egress gates and BEFORE tool.execute, so those gates and
      // outer safeguards/confirmation wrappers always win over a hook rewrite.
      // Fail-closed is enforced inside the hook gate (throw/timeout/malformed =
      // block); here a block stops execution, a rewrite is re-validated against
      // the tool schema and re-run through the same gates, and augment context
      // is appended to the result.
      let effectiveParams = params;
      let hookContext: readonly string[] = [];
      const preToolHookGate = getPreToolHookGate?.() ?? null;
      if (preToolHookGate) {
        const evaluation = await preToolHookGate.evaluate({
          toolName: tool.name,
          params,
          tier: access.getTier(),
        });
        if (evaluation && evaluation.matchedHookCount > 0) {
          preToolHookGate.onDecision(
            buildRedactedPreToolAudit(tool.name, access.getTier(), evaluation),
          );
          if (evaluation.outcome === 'block') {
            return hookBlockedResult(tool.name, evaluation.blockReason, evaluation.blockingHook);
          }
          if (evaluation.inputModified) {
            // Fail closed: a rewritten input must satisfy the tool schema AND
            // re-pass every capability/egress gate before it can run.
            if (!Value.Check(tool.parameters, evaluation.finalInput)) {
              return hookModifiedInputInvalidResult(tool.name);
            }
            const modifiedDenial = gateCandidate(evaluation.finalInput);
            if (modifiedDenial) return modifiedDenial;
            effectiveParams = evaluation.finalInput;
          }
          hookContext = evaluation.additionalContext;
        }
      }

      // params is unknown from the gated wrapper; narrow to the wrapped tool's
      // own declared param type (Static<TParameters>) rather than erasing it.
      const result = await tool.execute(
        toolCallId,
        effectiveParams as Parameters<typeof tool.execute>[1],
        signal,
      );
      return hookContext.length > 0 ? appendHookContext(result, hookContext) : result;
    },
  } as T;

  return gated;
}
