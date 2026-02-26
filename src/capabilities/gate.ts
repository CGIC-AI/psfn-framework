import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { TextContent } from '@mariozechner/pi-ai';
import type { CapabilityTier } from '../types.js';
import type { CapabilityToken } from './tokens.js';
import { resolveToolRequiredCapabilities } from './requirements.js';

export interface CapabilityAccess {
  getTier(): CapabilityTier;
  getGrantedTokens(): ReadonlySet<CapabilityToken>;
  has(token: CapabilityToken): boolean;
}

export type CapabilityAccessProvider = () => CapabilityAccess;

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
      const requiredTokens = resolveToolRequiredCapabilities(tool, params);
      if (requiredTokens.length > 0) {
        const missing = requiredTokens.filter(token => !access.has(token));
        if (missing.length > 0) {
          return deniedResult(
            tool.name,
            access.getTier(),
            missing,
            access.getGrantedTokens(),
          );
        }
      }

      return tool.execute(toolCallId, params as any, signal);
    },
  } as T;

  return gated;
}
