// ── spawn_shard tool ──
// Registered on parent AgentLoop only. Shards don't get this tool (no recursion).

import type { SubstrateTool } from '../types.js';
import type { ShardManager } from './manager.js';

export function createSpawnShardTool(manager: ShardManager): SubstrateTool {
  return {
    name: 'spawn_shard',
    description:
      'Spawn a sub-agent shard for parallel task execution. ' +
      'Multiple spawn_shard calls in the same turn run concurrently. ' +
      'Each shard is ephemeral — it runs a task and returns the result.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Short label for this shard (e.g. "research", "analysis")',
        },
        task: {
          type: 'string',
          description: 'The task/prompt for the shard to execute',
        },
        systemPrompt: {
          type: 'string',
          description: 'Optional system prompt override (default: inherit parent prompt)',
        },
      },
      required: ['name', 'task'],
    },
    execute: async (input) => {
      try {
        const result = await manager.spawn({
          name: input.name as string,
          task: input.task as string,
          systemPrompt: input.systemPrompt as string | undefined,
        });

        return {
          content:
            `[Shard "${result.name}" completed in ${result.durationMs}ms, ` +
            `${result.turns} turn(s), ` +
            `${result.inputTokens + result.outputTokens} tokens]\n\n` +
            result.content,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: `[Shard error: ${msg}]`, isError: true };
      }
    },
  };
}
