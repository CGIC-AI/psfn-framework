// ── shard tool ──
// Registered on parent SubstrateAgent only. Shards don't get this tool (no recursion).

import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { ArtifactReturnPort, ShardExecutionPort } from './port.js';
import { shardArtifactReturnPort } from './artifact-policy.js';
import { getRequestContext } from '../llm/request-context.js';
import type { LegacyAliasTelemetryCallback } from '../tools/legacy-alias-telemetry.js';
import { textResult, textResultWithError } from '../tools/results.js';
import { toErrorMessage } from '../utils/errors.js';
import type { ShardRuntimeTaskView } from './types.js';

type ShardToolAction = 'spawn' | 'list' | 'status' | 'deliver';

interface ShardToolParams {
  action?: ShardToolAction | 'spawn_shard';
  shard_id?: string;
  name?: string;
  task?: string;
  backend?: 'inline' | 'container' | 'orchestrated';
  system_prompt?: string;
  max_turns?: number;
  capabilities?: string[];
  required_capabilities?: string[];
  shard_limit?: number;
  transcript_limit?: number;
}

const SHARD_ACTION_HELP = 'spawn, list, status, deliver';

function normalizeShardAction(params: ShardToolParams): ShardToolAction {
  const rawAction = typeof params.action === 'string' ? params.action.trim() : '';
  if (rawAction) {
    switch (rawAction) {
      case 'spawn':
      case 'spawn_shard':
        return 'spawn';
      case 'list':
      case 'status':
      case 'deliver':
        return rawAction;
      default:
        throw new Error(`action must be one of: ${SHARD_ACTION_HELP}`);
    }
  }

  const hasName = typeof params.name === 'string';
  const hasTask = typeof params.task === 'string';
  const hasShardId = typeof params.shard_id === 'string';
  const hasLimits = typeof params.shard_limit === 'number' || typeof params.transcript_limit === 'number';

  if (hasName || hasTask) return 'spawn';
  if (hasShardId) return 'status';
  if (hasLimits || Object.keys(params).length === 0) return 'list';
  throw new Error(`action is required. Supported actions: ${SHARD_ACTION_HELP}`);
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} is required.`);
  }
  return value.trim();
}

function formatRuntimeSnapshot(port: ShardExecutionPort, params: ShardToolParams): string {
  const snapshot = port.getRuntimeSnapshot({
    ...(typeof params.shard_limit === 'number' ? { shardLimit: params.shard_limit } : {}),
    ...(typeof params.transcript_limit === 'number' ? { transcriptLimit: params.transcript_limit } : {}),
  });
  const summarize = (view: ShardRuntimeTaskView) =>
    `${view.task.shardId}: ${view.task.name} [runtime=${view.task.runtimeState}, artifact=${view.task.artifactLifecycleState}, review=${view.review.status}]`;
  const active = snapshot.activeShards.map(summarize);
  const recent = snapshot.recentShards.map(summarize);
  return [
    `Shard runtime snapshot generated at ${new Date(snapshot.generatedAt).toISOString()}.`,
    `Active shards: ${snapshot.activeCount}.`,
    active.length > 0 ? `Active:\n${active.map((entry, index) => `${index + 1}. ${entry}`).join('\n')}` : 'Active: none.',
    recent.length > 0 ? `Recent:\n${recent.map((entry, index) => `${index + 1}. ${entry}`).join('\n')}` : 'Recent: none.',
  ].join('\n\n');
}

function formatShardStatus(
  port: ShardExecutionPort,
  shardId: string,
  params: ShardToolParams,
): string {
  const view = port.getRuntimeShardView(shardId, {
    ...(typeof params.transcript_limit === 'number' ? { transcriptLimit: params.transcript_limit } : {}),
  });
  if (!view) {
    throw new Error(`Shard "${shardId}" was not found.`);
  }

  return [
    `Shard "${view.task.name}" (${view.task.shardId})`,
    `runtime=${view.task.runtimeState} artifact=${view.task.artifactLifecycleState} health=${view.task.health}`,
    `review=${view.review.status} pending_tagged_outputs=${view.review.pendingTaggedOutputCount}`,
    `validation_path=${view.review.validationPath}`,
    view.resume.deliveryPending ? 'delivery_pending=true' : 'delivery_pending=false',
    view.artifacts[0]?.content
      ? `artifact_preview=${view.artifacts[0].content}`
      : 'artifact_preview=(none)',
  ].join('\n');
}

export function createShardTool(
  shardPort: ShardExecutionPort,
  artifactReturnPort: ArtifactReturnPort = shardArtifactReturnPort,
  options: { emitLegacyAliasTelemetry?: LegacyAliasTelemetryCallback } = {},
): AgentTool<any> {
  return {
    name: 'shard',
    description:
      'Unified shard control surface for long-horizon shard work. '
      + 'Use action=spawn|list|status|deliver. Multiple shard spawn calls in the same turn run concurrently. '
      + 'Shard runtime remains distinct from bounded subagent tasks, preserves a stable shard prompt prefix, '
      + 'and keeps fold-back outputs pending explicit merge review before core-state promotion.',
    label: 'shard',
    parameters: Type.Object({
      action: Type.Optional(Type.Union([
        Type.Literal('spawn'),
        Type.Literal('spawn_shard'),
        Type.Literal('list'),
        Type.Literal('status'),
        Type.Literal('deliver'),
      ], {
        description: 'Shard action. Preferred actions: spawn, list, status, deliver. Legacy action alias spawn_shard remains accepted.',
      })),
      shard_id: Type.Optional(Type.String({
        minLength: 1,
        description: 'Used with action=status|deliver. Runtime shard id.',
      })),
      name: Type.Optional(Type.String({ description: 'Used with action=spawn. Short label for this shard.' })),
      task: Type.Optional(Type.String({ description: 'Used with action=spawn. Task/prompt for the shard to execute.' })),
      backend: Type.Optional(Type.Union([
        Type.Literal('inline'),
        Type.Literal('container'),
        Type.Literal('orchestrated'),
      ], {
        description:
          'Optional shard backend. Use "inline" for in-process shard execution; '
          + '"container" and "orchestrated" stay behind a mediated shard faculty boundary.',
      })),
      systemPrompt: Type.Optional(Type.String({
        description: 'Optional shard remit and prompt-discipline supplement appended after the inherited shard prefix.',
      })),
      system_prompt: Type.Optional(Type.String({
        description: 'Alias for systemPrompt used with action=spawn.',
      })),
      maxTurns: Type.Optional(Type.Number({
        minimum: 1,
        maximum: 8,
        description: 'Legacy alias for max_turns used with action=spawn.',
      })),
      max_turns: Type.Optional(Type.Number({
        minimum: 1,
        maximum: 8,
        description: 'Used with action=spawn. Optional max turns for the shard loop (default: 1).',
      })),
      capabilities: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
        description: 'Used with action=spawn. Optional capability tokens this shard should advertise.',
      })),
      requiredCapabilities: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
        description: 'Legacy alias for required_capabilities used with action=spawn.',
      })),
      required_capabilities: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
        description: 'Used with action=spawn. Optional capability tokens that must be present before this shard executes.',
      })),
      shard_limit: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: 100,
        description: 'Used with action=list. Maximum recent shard records to include.',
      })),
      transcript_limit: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: 100,
        description: 'Used with action=list|status. Transcript entry limit for runtime views.',
      })),
    }),
    execute: async (
      _toolCallId: string,
      params: ShardToolParams = {},
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      const rawAction = typeof params.action === 'string' ? params.action.trim() : '';
      let actionForError = rawAction || undefined;
      try {
        actionForError = normalizeShardAction(params);
        if (rawAction && rawAction !== actionForError) {
          options.emitLegacyAliasTelemetry?.({
            toolName: 'shard',
            alias: rawAction,
            canonicalAction: actionForError,
            migrationSurface: 'shard',
          });
        }
        switch (actionForError) {
          case 'spawn': {
            const requestContext = getRequestContext();
            const result = await shardPort.spawn({
              name: requireNonEmptyString(params.name, 'name'),
              task: requireNonEmptyString(params.task, 'task'),
              ...(params.backend ? { backend: params.backend } : {}),
              ...(typeof params.system_prompt === 'string'
                ? { systemPrompt: params.system_prompt }
                : typeof params.systemPrompt === 'string'
                  ? { systemPrompt: params.systemPrompt }
                  : {}),
              creationMode: requestContext?.channelId ? 'forked' : 'fresh',
              ...(params.max_turns !== undefined
                ? { maxTurns: params.max_turns }
                : params.maxTurns !== undefined
                  ? { maxTurns: params.maxTurns }
                  : {}),
              ...(params.capabilities?.length ? { capabilities: params.capabilities } : {}),
              ...((params.required_capabilities?.length || params.requiredCapabilities?.length)
                ? { requiredCapabilities: params.required_capabilities ?? params.requiredCapabilities }
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
            if (typeof shardPort.recordArtifactReturn === 'function') {
              shardPort.recordArtifactReturn(result.shardId);
            }
            return artifact;
          }

          case 'list':
            return textResult(formatRuntimeSnapshot(shardPort, params));

          case 'status':
            return textResult(formatShardStatus(
              shardPort,
              requireNonEmptyString(params.shard_id, 'shard_id'),
              params,
            ));

          case 'deliver': {
            const shardId = requireNonEmptyString(params.shard_id, 'shard_id');
            const before = shardPort.getRuntimeShardView(shardId, {
              ...(typeof params.transcript_limit === 'number' ? { transcriptLimit: params.transcript_limit } : {}),
            });
            if (!before) {
              throw new Error(`Shard "${shardId}" was not found.`);
            }
            shardPort.markArtifactDelivered(shardId);
            const after = shardPort.getRuntimeShardView(shardId, {
              ...(typeof params.transcript_limit === 'number' ? { transcriptLimit: params.transcript_limit } : {}),
            });
            if (!after) {
              throw new Error(`Shard "${shardId}" was not found after delivery.`);
            }
            return textResult(
              `Marked shard "${after.task.name}" (${after.task.shardId}) delivered.\n`
              + `runtime=${after.task.runtimeState} artifact=${after.task.artifactLifecycleState} review=${after.review.status}`,
            );
          }
        }
      } catch (error) {
        const suffix = actionForError ? ` for action=${actionForError}` : '';
        return textResultWithError(`shard failed${suffix}: ${toErrorMessage(error)}`, true);
      }
    },
  };
}

export const createSpawnShardTool = createShardTool;
