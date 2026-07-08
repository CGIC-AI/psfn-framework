import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { BeadsActionResult } from '../../gateway/protocol.js';
import type { BeadsOperations } from './ops.js';
import { textResult, textResultWithError } from '../../../core/tools/results.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';

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
  limit?: number;
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

function requirePlainStringParam(
  params: BeadsToolParams,
  key: 'id' | 'title' | 'reason',
  action: BeadsAction,
  example: string,
): string {
  const value = params[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(
      `action=${action} requires ${key} as a plain non-empty string. `
      + `Example: ${example}. Do not pass a whole issue object, payload array, or nested JSON object.`,
    );
  }
  return value.trim();
}

export function createBeadsTool(ops: BeadsOperations): AgentTool<any> {
  return {
    name: 'beads',
    label: 'beads',
    description:
      'Unified tracked-work surface for beads issue discovery and mutation. '
      + 'Use action=ready|show|create|update|close|sync. '
      + 'Use id as a plain string such as "PSFN-123" for action=show|update|close; do not pass the whole ready payload or issue object. '
      + 'If you need an id from action=ready, call ready first, read its tool result, then call show/update/close in a later assistant step. '
      + 'Legacy issue_* aliases remain accepted as action values only.',
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
        description: 'Beads action. Preferred actions: ready, show, create, update, close, sync.',
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
      limit: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: 100,
        description: 'Used with action=ready. Max issues returned (default 20). Raise only when you truly need more; the full list is very large.',
      })),
      actor: Type.Optional(Type.String({
        description: 'Optional actor identifier for audit attribution.',
      })),
    }),
    execute: async (
      _toolCallId: string,
      params: BeadsToolParams = {},
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      let actionForError = typeof params.action === 'string' ? params.action : undefined;
      try {
        actionForError = normalizeBeadsAction(params);
        const result = await (async (): Promise<BeadsActionResult> => {
          switch (actionForError) {
            case 'ready':
              return await ops.ready({
                actor: params.actor,
                ...(params.limit !== undefined ? { limit: params.limit } : {}),
              });
            case 'show':
              return await ops.show({
                id: requirePlainStringParam(params, 'id', 'show', '{"action":"show","id":"PSFN-123"}'),
                actor: params.actor,
              });
            case 'create':
              return await ops.create({
                title: requirePlainStringParam(params, 'title', 'create', '{"action":"create","title":"Tracked work"}'),
                issueType: params.issue_type,
                priority: params.priority,
                deps: params.deps,
                parent: params.parent,
                actor: params.actor,
              });
            case 'update':
              return await ops.update({
                id: requirePlainStringParam(params, 'id', 'update', '{"action":"update","id":"PSFN-123","status":"in_progress"}'),
                status: params.status,
                priority: params.priority,
                actor: params.actor,
              });
            case 'close':
              return await ops.close({
                id: requirePlainStringParam(params, 'id', 'close', '{"action":"close","id":"PSFN-123","reason":"Completed"}'),
                reason: requirePlainStringParam(params, 'reason', 'close', '{"action":"close","id":"PSFN-123","reason":"Completed"}'),
                actor: params.actor,
              });
            case 'sync':
              return await ops.sync({ actor: params.actor });
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
