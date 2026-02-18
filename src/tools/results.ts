import type { AgentToolResult } from '@mariozechner/pi-agent-core';
import type { TextContent } from '@mariozechner/pi-ai';

export function textResult(text: string): AgentToolResult<Record<string, never>> {
  return {
    content: [{ type: 'text', text }] satisfies TextContent[],
    details: {},
  };
}

export function textResultWithError(
  text: string,
  isError = false,
): AgentToolResult<{ isError?: boolean }> {
  return {
    content: [{ type: 'text', text }] satisfies TextContent[],
    details: { isError: isError || undefined },
  };
}
