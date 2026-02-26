// ── spawn_shard tool ──
// Registered on parent SubstrateAgent only. Shards don't get this tool (no recursion).

import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { TextContent } from '@mariozechner/pi-ai';
import type { ShardManager } from './manager.js';

export function createSpawnShardTool(manager: ShardManager): AgentTool<any> {
  return {
    name: 'spawn_shard',
    description:
      'Spawn a sub-agent shard for parallel task execution. ' +
      'Multiple spawn_shard calls in the same turn run concurrently. ' +
      'Each shard is ephemeral — it runs a task and returns the result.',
    label: 'spawn_shard',
    parameters: Type.Object({
      name: Type.String({ description: 'Short label for this shard (e.g. "research", "analysis")' }),
      task: Type.String({ description: 'The task/prompt for the shard to execute' }),
      systemPrompt: Type.Optional(
        Type.String({ description: 'Optional system prompt override (default: inherit parent prompt)' }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: { name: string; task: string; systemPrompt?: string },
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const result = await manager.spawn({
          name: params.name,
          task: params.task,
          systemPrompt: params.systemPrompt,
        });

        return {
          content: [{
            type: 'text',
            text:
              `[Shard "${result.name}" completed in ${result.durationMs}ms, ` +
              `${result.turns} turn(s), ` +
              `${result.inputTokens + result.outputTokens} tokens]\n\n` +
              result.content,
          }] satisfies TextContent[],
          details: {},
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `[Shard error: ${msg}]` }] satisfies TextContent[],
          details: { isError: true },
        };
      }
    },
  };
}
