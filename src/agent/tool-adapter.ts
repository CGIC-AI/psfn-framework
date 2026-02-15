// ── SubstrateTool → AgentTool Adapter ──
// Wraps our existing SubstrateTool interface into pi-agent-core's AgentTool.
// This enables gradual migration — tools can be converted one at a time.

import { Type, type TSchema } from '@sinclair/typebox';
import type { TextContent } from '@mariozechner/pi-ai';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { SubstrateTool } from '../types.js';

/**
 * Wrap a SubstrateTool as an AgentTool for use with pi-agent-core's Agent.
 *
 * The adapter:
 * - Converts inputSchema (plain JSON Schema) → Type.Unsafe() TypeBox wrapper
 * - Maps execute(input) → execute(toolCallId, params, signal, onUpdate)
 * - Maps ToolResult { content, isError } → AgentToolResult { content[], details }
 * - Adds a label (defaults to tool name)
 *
 * Tools can later be migrated to native AgentTool for full TypeBox typing,
 * AbortSignal support, and streaming onUpdate callbacks.
 */
export function wrapSubstrateTool(tool: SubstrateTool, label?: string): AgentTool<TSchema, { isError?: boolean }> {
  // Wrap the JSON Schema as a TypeBox schema using Type.Unsafe()
  // At runtime, providers pass it as-is (it's already valid JSON Schema)
  const schema = Type.Unsafe<Record<string, unknown>>(tool.inputSchema as any);

  return {
    name: tool.name,
    description: tool.description,
    parameters: schema,
    label: label ?? tool.name,
    execute: async (
      _toolCallId: string,
      params: unknown,
      _signal?: AbortSignal,
      _onUpdate?: (partialResult: AgentToolResult<{ isError?: boolean }>) => void,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      const result = await tool.execute(params as Record<string, unknown>);
      const content: TextContent[] = [{ type: 'text', text: result.content }];
      return {
        content,
        details: { isError: result.isError },
      };
    },
  };
}

/**
 * Wrap multiple SubstrateTools as AgentTools.
 */
export function wrapSubstrateTools(tools: SubstrateTool[]): AgentTool[] {
  return tools.map(t => wrapSubstrateTool(t));
}

/**
 * Convert an AgentToolResult back to our ToolResult format.
 * Useful for bridging pi-agent-core tool results back to our event system.
 */
export function toSubstrateToolResult(result: AgentToolResult<any>): { content: string; isError?: boolean } {
  const text = result.content
    .filter((block): block is TextContent => block.type === 'text')
    .map(block => block.text)
    .join('');
  return {
    content: text,
    isError: result.details?.isError,
  };
}
