import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { withCapabilityRequirement } from '../../system/capabilities/requirements.js';
import { tagToolWithReversibility } from '../../system/capabilities/safeguards.js';
import type { SubagentControlPort } from './port.js';
import { textResult, textResultWithError } from '../../core/tools/results.js';
import { toErrorMessage } from '../../shared/utils/errors.js';

type SubagentToolAction = 'spawn' | 'message' | 'wait' | 'cancel' | 'status';

interface SubagentToolParams {
  action?: SubagentToolAction;
  subagent_id?: string;
  name?: string;
  task?: string;
  message?: string;
  reason?: string;
  system_prompt?: string;
  max_turns?: number;
  capabilities?: string[];
  required_capabilities?: string[];
  task_limit?: number;
  transcript_limit?: number;
}

export function createSubagentTool(port: SubagentControlPort): AgentTool<any> {
  const tool: AgentTool<any> = {
    name: 'subagent',
    label: 'subagent',
    description:
      'Control bounded short-horizon subagents with action=spawn, message, wait, cancel, or status. '
      + 'Use shard action=spawn for long-horizon or distributed shard work.',
    parameters: Type.Object({
      action: Type.Optional(Type.Union([
        Type.Literal('spawn'),
        Type.Literal('message'),
        Type.Literal('wait'),
        Type.Literal('cancel'),
        Type.Literal('status'),
      ], { description: 'Subagent control action. Default: spawn.' })),
      subagent_id: Type.Optional(Type.String({ description: 'Subagent id for message, wait, cancel, or status.' })),
      name: Type.Optional(Type.String({ description: 'Short label for a spawned subagent.' })),
      task: Type.Optional(Type.String({ description: 'Initial bounded task for a spawned subagent.' })),
      message: Type.Optional(Type.String({ description: 'Follow-up instruction for an active subagent.' })),
      reason: Type.Optional(Type.String({ description: 'Optional cancellation note.' })),
      system_prompt: Type.Optional(Type.String({ description: 'Optional subagent system prompt override.' })),
      max_turns: Type.Optional(Type.Number({
        minimum: 1,
        maximum: 8,
        description: 'Optional max turns for the bounded worker loop.',
      })),
      capabilities: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
        description: 'Optional advertised capability tokens for routing diagnostics.',
      })),
      required_capabilities: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
        description: 'Optional required capability tokens that must be present before execution.',
      })),
      task_limit: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: 50,
        description: 'Optional status snapshot task limit.',
      })),
      transcript_limit: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: 50,
        description: 'Optional transcript entry limit for status views.',
      })),
    }),
    execute: async (
      _toolCallId: string,
      params: SubagentToolParams,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      const action = params.action ?? 'spawn';

      try {
        switch (action) {
          case 'spawn': {
            const task = await port.spawn({
              name: normalizeRequiredText(params.name, 'name'),
              task: normalizeRequiredText(params.task, 'task'),
              ...(typeof params.system_prompt === 'string' ? { systemPrompt: params.system_prompt } : {}),
              ...(typeof params.max_turns === 'number' ? { maxTurns: params.max_turns } : {}),
              ...(params.capabilities?.length ? { capabilities: params.capabilities } : {}),
              ...(params.required_capabilities?.length
                ? { requiredCapabilities: params.required_capabilities }
                : {}),
            });
            return textResult(formatPayload({
              action,
              surface: 'subagent',
              semantics: 'bounded_worker',
              subagent_id: task.subagentId,
              subagentId: task.subagentId,
              next_action: {
                action: 'wait',
                subagent_id: task.subagentId,
              },
              task,
            }));
          }

          case 'message': {
            const view = await port.message(
              normalizeRequiredText(params.subagent_id, 'subagent_id'),
              normalizeRequiredText(params.message, 'message'),
            );
            return textResult(formatPayload({
              action,
              surface: 'subagent',
              semantics: 'bounded_worker',
              task: view.task,
              resume: view.resume,
            }));
          }

          case 'wait': {
            const result = await port.wait(resolveWaitSubagentId(port, params.subagent_id));
            return textResult(formatPayload({
              action,
              surface: 'subagent',
              semantics: 'bounded_worker',
              result,
            }));
          }

          case 'cancel': {
            const result = await port.cancel(
              normalizeRequiredText(params.subagent_id, 'subagent_id'),
              params.reason,
            );
            return textResult(formatPayload({
              action,
              surface: 'subagent',
              semantics: 'bounded_worker',
              result,
            }));
          }

          case 'status': {
            const transcriptLimit = params.transcript_limit;
            if (typeof params.subagent_id === 'string' && params.subagent_id.trim().length > 0) {
              const detail = port.getRuntimeTaskDetail(params.subagent_id, {
                ...(typeof transcriptLimit === 'number' ? { transcriptLimit } : {}),
              });
              if (!detail) {
                return textResultWithError(`Unknown subagent task "${params.subagent_id}".`, true);
              }
              return textResult(formatPayload({
                action,
                surface: 'subagent',
                semantics: 'bounded_worker',
                detail,
              }));
            }

            return textResult(formatPayload({
              action,
              surface: 'subagent',
              semantics: 'bounded_worker',
              snapshot: port.getRuntimeSnapshot({
                ...(typeof params.task_limit === 'number' ? { taskLimit: params.task_limit } : {}),
                ...(typeof transcriptLimit === 'number' ? { transcriptLimit } : {}),
              }),
            }));
          }
        }
      } catch (error) {
        return textResultWithError(`subagent ${action} failed: ${toErrorMessage(error)}`, true);
      }
    },
  };

  return tagToolWithReversibility(
    withCapabilityRequirement(tool, (params) => {
      const action = typeof params.action === 'string' ? params.action : 'spawn';
      return action === 'status' || action === 'wait'
        ? 'identity.read'
        : 'shard.spawn';
    }),
    'irreversible',
  );
}

function formatPayload(payload: Record<string, unknown>): string {
  return JSON.stringify(payload, null, 2);
}

function normalizeRequiredText(value: string | undefined, field: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${field} is required.`);
  }
  return normalized;
}

function resolveWaitSubagentId(port: SubagentControlPort, value: string | undefined): string {
  const normalized = value?.trim();
  if (normalized) {
    return normalized;
  }

  const snapshot = port.getRuntimeSnapshot({ taskLimit: 2 });
  const candidates = new Set<string>();
  for (const view of [...snapshot.activeTasks, ...snapshot.recentTasks]) {
    const subagentId = view.task.subagentId.trim();
    if (subagentId) {
      candidates.add(subagentId);
    }
  }

  if (candidates.size === 1) {
    for (const subagentId of candidates) {
      return subagentId;
    }
  }

  throw new Error(
    candidates.size > 1
      ? 'subagent_id is required because multiple subagent tasks are visible.'
      : 'subagent_id is required. Use the subagent_id from the spawn result or run action=status first.',
  );
}
