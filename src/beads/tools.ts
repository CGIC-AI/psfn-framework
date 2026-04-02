import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { BeadsActionResult } from '../gateway/protocol.js';
import type { BeadsOperations } from './ops.js';
import type { LegacyAliasTelemetryCallback } from '../tools/legacy-alias-telemetry.js';
import { textResult, textResultWithError } from '../tools/results.js';
import { toErrorMessage } from '../utils/errors.js';

const BEADS_ACTION_HELP = 'ready, show, create, update, close, sync';

type BeadsActionName =
  | 'ready'
  | 'issue_ready'
  | 'show'
  | 'issue_show'
  | 'create'
  | 'issue_create'
  | 'update'
  | 'issue_update'
  | 'close'
  | 'issue_close'
  | 'sync'
  | 'issue_sync';

type BeadsAction = 'ready' | 'show' | 'create' | 'update' | 'close' | 'sync';

export interface BeadsToolParams {
  action?: BeadsActionName;
  id?: string;
  title?: string;
  issue_type?: 'bug' | 'feature' | 'task' | 'epic' | 'chore';
  status?: 'open' | 'in_progress' | 'blocked' | 'closed';
  priority?: number;
  deps?: string[];
  parent?: string;
  reason?: string;
  actor?: string;
}

function formatActionResult(result: BeadsActionResult): string {
  return JSON.stringify({
    actor: result.actor,
    action: result.action,
    target: result.target,
    result: result.result,
    payload: result.payload,
    ...(result.sync ? { sync: result.sync } : {}),
  }, null, 2);
}

function normalizeBeadsAction(params: BeadsToolParams): BeadsAction {
  const rawAction = typeof params.action === 'string' ? params.action.trim() : '';
  if (rawAction) {
    switch (rawAction) {
      case 'ready':
      case 'issue_ready':
        return 'ready';
      case 'show':
      case 'issue_show':
        return 'show';
      case 'create':
      case 'issue_create':
        return 'create';
      case 'update':
      case 'issue_update':
        return 'update';
      case 'close':
      case 'issue_close':
        return 'close';
      case 'sync':
      case 'issue_sync':
        return 'sync';
      default:
        throw new Error(`action must be one of: ${BEADS_ACTION_HELP}`);
    }
  }

  const hasId = typeof params.id === 'string';
  const hasTitle = typeof params.title === 'string';
  const hasStatus = typeof params.status === 'string';
  const hasPriority = typeof params.priority === 'number';
  const hasReason = typeof params.reason === 'string';
  const hasIssueType = typeof params.issue_type === 'string';
  const hasDeps = Array.isArray(params.deps);
  const hasParent = typeof params.parent === 'string';

  if (!hasId && !hasTitle && !hasStatus && !hasPriority && !hasReason && !hasIssueType && !hasDeps && !hasParent) {
    return 'ready';
  }
  if (hasId && hasReason && !hasTitle && !hasStatus && !hasPriority && !hasIssueType && !hasDeps && !hasParent) {
    return 'close';
  }
  if (hasId && (hasStatus || hasPriority) && !hasTitle && !hasReason && !hasIssueType && !hasDeps && !hasParent) {
    return 'update';
  }
  if (hasTitle && !hasId && !hasStatus && !hasReason) {
    return 'create';
  }
  if (hasId && !hasTitle && !hasStatus && !hasPriority && !hasReason && !hasIssueType && !hasDeps && !hasParent) {
    return 'show';
  }

  throw new Error(`action is required. Supported actions: ${BEADS_ACTION_HELP}`);
}

interface BeadsToolOptions {
  emitLegacyAliasTelemetry?: LegacyAliasTelemetryCallback;
}

export function createBeadsTool(ops: BeadsOperations, options: BeadsToolOptions = {}): AgentTool<any> {
  return {
    name: 'beads',
    label: 'beads',
    description:
      'Unified tracked-work surface for beads issue discovery and mutation. '
      + 'Use action=ready|show|create|update|close|sync. Read-style actions '
      + 'stay available on the same tool, but mutations remain explicit via action.',
    parameters: Type.Object({
      action: Type.Optional(Type.Union([
        Type.Literal('ready'),
        Type.Literal('issue_ready'),
        Type.Literal('show'),
        Type.Literal('issue_show'),
        Type.Literal('create'),
        Type.Literal('issue_create'),
        Type.Literal('update'),
        Type.Literal('issue_update'),
        Type.Literal('close'),
        Type.Literal('issue_close'),
        Type.Literal('sync'),
        Type.Literal('issue_sync'),
      ], {
        description: 'Beads action. Preferred actions: ready, show, create, update, close, sync. Legacy issue_* aliases remain accepted.',
      })),
      id: Type.Optional(Type.String({
        description: 'Used with action=show|update|close. Issue ID (for example PSFN-123 or PSFN-123.1).',
      })),
      title: Type.Optional(Type.String({
        description: 'Used with action=create. Issue title.',
      })),
      issue_type: Type.Optional(Type.Union([
        Type.Literal('bug'),
        Type.Literal('feature'),
        Type.Literal('task'),
        Type.Literal('epic'),
        Type.Literal('chore'),
      ])),
      status: Type.Optional(Type.Union([
        Type.Literal('open'),
        Type.Literal('in_progress'),
        Type.Literal('blocked'),
        Type.Literal('closed'),
      ])),
      priority: Type.Optional(Type.Integer({
        minimum: 0,
        maximum: 4,
        description: 'Used with action=create|update. Priority 0-4.',
      })),
      deps: Type.Optional(Type.Array(Type.String({
        description: 'Used with action=create. Dependency refs (for example discovered-from:PSFN-123).',
      }), {
        maxItems: 16,
      })),
      parent: Type.Optional(Type.String({
        description: 'Used with action=create. Optional parent issue ID for subtasks.',
      })),
      reason: Type.Optional(Type.String({
        description: 'Used with action=close. Close reason text.',
      })),
      actor: Type.Optional(Type.String({
        description: 'Optional actor identifier for audit attribution.',
      })),
    }),
    execute: async (
      _toolCallId: string,
      params: BeadsToolParams = {},
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      const rawAction = typeof params.action === 'string' ? params.action.trim() : '';
      let actionForError: BeadsAction | undefined;
      try {
        actionForError = normalizeBeadsAction(params);
        if (rawAction && rawAction !== actionForError) {
          options.emitLegacyAliasTelemetry?.({
            toolName: 'beads',
            alias: rawAction,
            canonicalAction: actionForError,
            migrationSurface: 'beads',
          });
        }
        const result = await (async (): Promise<BeadsActionResult> => {
          switch (actionForError) {
            case 'ready':
              return await ops.ready({ actor: params.actor });
            case 'show':
              return await ops.show({ id: params.id!, actor: params.actor });
            case 'create':
              return await ops.create({
                title: params.title!,
                issueType: params.issue_type,
                priority: params.priority,
                deps: params.deps,
                parent: params.parent,
                actor: params.actor,
              });
            case 'update':
              return await ops.update({
                id: params.id!,
                status: params.status,
                priority: params.priority,
                actor: params.actor,
              });
            case 'close':
              return await ops.close({
                id: params.id!,
                reason: params.reason!,
                actor: params.actor,
              });
            case 'sync':
              return await ops.sync({ actor: params.actor });
            default: {
              const unreachableAction: never = actionForError;
              throw new Error(`Unsupported beads action: ${unreachableAction}`);
            }
          }
        })();
        return textResult(formatActionResult(result));
      } catch (error) {
        const suffix = actionForError ? ` for action=${actionForError}` : '';
        return textResultWithError(`beads failed${suffix}: ${toErrorMessage(error)}`, true);
      }
    },
  };
}
