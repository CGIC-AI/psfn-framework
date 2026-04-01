// ── spawn_shard tool ──
// Registered on parent SubstrateAgent only. Shards don't get this tool (no recursion).

import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { ArtifactReturnPort, ShardExecutionPort } from './port.js';
import { shardArtifactReturnPort } from './artifact-policy.js';
import { getRequestContext } from '../llm/request-context.js';
import { textResultWithError } from '../tools/results.js';
import { toErrorMessage } from '../utils/errors.js';

export function createSpawnShardTool(
  shardPort: ShardExecutionPort,
  artifactReturnPort: ArtifactReturnPort = shardArtifactReturnPort,
): AgentTool<any> {
  return {
    name: 'spawn_shard',
    description:
      'Spawn a sub-agent shard for parallel task execution. ' +
      'Multiple spawn_shard calls in the same turn run concurrently. ' +
      'Shard runtime remains distinct from bounded subagent tasks, preserves a stable shard prompt prefix, '
      + 'and completes only after artifact delivery.',
    label: 'spawn_shard',
    parameters: Type.Object({
      name: Type.String({ description: 'Short label for this shard (e.g. "research", "analysis")' }),
      task: Type.String({ description: 'The task/prompt for the shard to execute' }),
      systemPrompt: Type.Optional(
        Type.String({
          description: 'Optional shard remit and prompt-discipline supplement appended after the inherited shard prefix.',
        }),
      ),
      maxTurns: Type.Optional(
        Type.Number({ minimum: 1, maximum: 8, description: 'Optional max turns for the shard loop (default: 1)' }),
      ),
      capabilities: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), {
          description: 'Optional capability tokens this shard should advertise for routing diagnostics.',
        }),
      ),
      requiredCapabilities: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), {
          description: 'Optional capability tokens that must be present before this shard executes.',
        }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: {
        name: string;
        task: string;
        systemPrompt?: string;
        maxTurns?: number;
        capabilities?: string[];
        requiredCapabilities?: string[];
      },
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const requestContext = getRequestContext();
        const result = await shardPort.spawn({
          name: params.name,
          task: params.task,
          systemPrompt: params.systemPrompt,
          creationMode: requestContext?.channelId ? 'forked' : 'fresh',
          ...(params.maxTurns !== undefined ? { maxTurns: params.maxTurns } : {}),
          ...(params.capabilities?.length ? { capabilities: params.capabilities } : {}),
          ...(params.requiredCapabilities?.length
            ? { requiredCapabilities: params.requiredCapabilities }
            : {}),
          sourceContext: requestContext?.channelId
            ? {
              channelId: requestContext.channelId,
              ...(requestContext.requestId ? { requestId: requestContext.requestId } : {}),
              ...(requestContext.turnId ? { turnId: requestContext.turnId } : {}),
            }
            : undefined,
        });

        const artifact = artifactReturnPort.returnArtifact(result);
        if (typeof shardPort.markArtifactDelivered === 'function') {
          shardPort.markArtifactDelivered(result.shardId);
        }
        return artifact;
      } catch (error) {
        return textResultWithError(`[Shard error: ${toErrorMessage(error)}]`, true);
      }
    },
  };
}
