import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { TextContent } from '@mariozechner/pi-ai';
import type { CapabilityTier } from '../types.js';
import type { CapabilityAccess, CapabilityAccessProvider } from './access.js';
import type { CapabilityToken } from './tokens.js';
import { resolveToolRequiredCapabilities } from './requirements.js';
import { evaluateEligibilityDecision } from './eligibility.js';

export type { CapabilityAccess, CapabilityAccessProvider } from './access.js';

export interface ToolCapabilityEligibility {
  allowed: boolean;
  requiredTokens: CapabilityToken[];
  missingTokens: CapabilityToken[];
}

export function evaluateToolCapabilityEligibility(
  tool: AgentTool<any>,
  params: unknown,
  access: CapabilityAccess,
): ToolCapabilityEligibility {
  const requiredTokens = resolveToolRequiredCapabilities(tool, params);
  const decision = evaluateEligibilityDecision(
    access,
    { kind: 'tool.execute', toolName: tool.name },
    { requiredTokens },
  );
  return {
    allowed: decision.allowed,
    requiredTokens,
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
