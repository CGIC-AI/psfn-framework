// ── bounded subagent launch tool ──
// Registered on parent SubstrateAgent only. Child subagents don't get this tool (no recursion).

import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { TextContent } from '@mariozechner/pi-ai';
import type { BoundedSubagentLaunchPort } from '../../core/agent/substrate-agent/bounded-subagent-contract.js';
import {
  BOUNDED_SUBAGENT_LAUNCH_TOOL_NAME,
  buildBoundedSubagentLaunchEnvelope,
  normalizeBoundedSubagentLaunchRequest,
} from '../../core/agent/substrate-agent/bounded-subagent-contract.js';
import { getRequestContext } from '../../primitives/llm/request-context.js';
import { textResultWithError } from '../../core/tools/results.js';
import { toErrorMessage } from '../../shared/utils/errors.js';

export function createBoundedSubagentLaunchTool(manager: BoundedSubagentLaunchPort): AgentTool<any> {
  return {
    name: BOUNDED_SUBAGENT_LAUNCH_TOOL_NAME,
    description:
      'Launch a bounded subagent for parallel task execution. ' +
      'Multiple spawn_subagent calls in the same turn run concurrently. ' +
      'Each launch is ephemeral — it runs a task and returns the result. ' +
      'For repository change work, the bounded subagent must return reviewable patch, artifact, or PR-style output rather than mutating the parent runtime in place.',
    label: BOUNDED_SUBAGENT_LAUNCH_TOOL_NAME,
    parameters: Type.Object({
      name: Type.String({ description: 'Short label for this bounded subagent (e.g. "research", "analysis")' }),
      task: Type.String({ description: 'The task/prompt for the bounded subagent to execute' }),
      systemPrompt: Type.Optional(
        Type.String({ description: 'Optional system prompt override (default: inherit parent prompt)' }),
      ),
      maxTurns: Type.Optional(
        Type.Number({ minimum: 1, maximum: 8, description: 'Optional max turns for the bounded subagent loop (default: 1)' }),
      ),
      capabilities: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), {
          description: 'Optional capability tokens this bounded subagent should advertise for routing diagnostics.',
        }),
      ),
      requiredCapabilities: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), {
          description: 'Optional capability tokens that must be present before this bounded subagent executes.',
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
        const launchRequest = normalizeBoundedSubagentLaunchRequest({
          ...params,
          sourceContext: requestContext?.channelId
            ? {
              channelId: requestContext.channelId,
              ...(requestContext.requestId ? { requestId: requestContext.requestId } : {}),
              ...(requestContext.turnId ? { turnId: requestContext.turnId } : {}),
              ...(requestContext.embodimentContext
                ? { embodimentContext: requestContext.embodimentContext }
                : {}),
            }
            : undefined,
        });
        const result = await manager.launchBoundedSubagent(launchRequest);
        const boundedSubagent = buildBoundedSubagentLaunchEnvelope(
          launchRequest,
          {
            subagentId: result.subagentId,
            content: result.content,
            model: result.model,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            durationMs: result.durationMs,
            turns: result.turns,
          },
          {
            stateReason: result.stateReason,
            ...(result.failureReason ? { failureReason: result.failureReason } : {}),
          },
        );

        return {
          content: [{
            type: 'text',
            text:
              `[Bounded subagent "${result.name}" completed in ${result.durationMs}ms, ` +
              `${result.turns} turn(s), ` +
              `${result.inputTokens + result.outputTokens} tokens, ` +
              `state=${result.lifecycleState}, health=${result.health}]\n` +
              `[State reason: ${result.stateReason}]\n` +
              `${result.failureReason
                ? `[Failure reason: ${result.failureReason}]\n`
                : ''}` +
              `${result.capabilities.length > 0
                ? `[Capabilities: ${result.capabilities.join(', ')}]\n`
                : ''}` +
              `${result.requiredCapabilities.length > 0
                ? `[Required capabilities: ${result.requiredCapabilities.join(', ')}]\n`
                : ''}\n` +
              result.content,
            }] satisfies TextContent[],
          details: {
            boundedSubagent,
            mutationWorkflow: 'artifact_return_only',
            returnedArtifacts: result.returnedArtifacts ?? [],
          },
        };
      } catch (error) {
        return textResultWithError(`[Bounded subagent error: ${toErrorMessage(error)}]`, true);
      }
    },
  };
}
