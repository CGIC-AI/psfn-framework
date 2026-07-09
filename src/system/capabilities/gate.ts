import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { TextContent } from '@mariozechner/pi-ai';
import type { CapabilityTier } from '../config/runtime-config-contracts.js';
import type { CapabilityAccess, CapabilityAccessProvider } from './access.js';
import type { CapabilityToken } from './tokens.js';
import { resolveToolCapabilityRequirement } from './requirements.js';
import { evaluateEligibilityDecision } from './eligibility.js';

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

export function gateToolWithCapabilities<T extends AgentTool<any>>(
  tool: T,
  getAccess: CapabilityAccessProvider,
): T {
  const gated = {
    ...tool,
    execute: async (
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
    ): Promise<AgentToolResult<any>> => {
      const access = getAccess();
      const eligibility = evaluateToolCapabilityEligibility(tool, params, access);
      if (!eligibility.allowed) {
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

      // params is unknown from the gated wrapper; tool.execute expects Static<TSchema>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return tool.execute(toolCallId, params as any, signal);
    },
  } as T;

  return gated;
}
