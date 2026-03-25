import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { BeadsActionResult } from '../gateway/protocol.js';
import type { BeadsOperations } from './ops.js';
import { textResult, textResultWithError } from '../tools/results.js';
import { toErrorMessage } from '../utils/errors.js';

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

export function createIssueReadyTool(ops: BeadsOperations): AgentTool<any> {
  return {
    name: 'issue_ready',
    label: 'issue_ready',
    description: 'List beads issues that are ready to be worked on.',
    parameters: Type.Object({
      actor: Type.Optional(Type.String({
        description: 'Optional actor identifier for audit attribution.',
      })),
    }),
    execute: async (
      _toolCallId: string,
      params: { actor?: string },
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const result = await ops.ready({ actor: params.actor });
        return textResult(formatActionResult(result));
      } catch (error) {
        return textResultWithError(`issue_ready failed: ${toErrorMessage(error)}`, true);
      }
    },
  };
}

export function createIssueShowTool(ops: BeadsOperations): AgentTool<any> {
  return {
    name: 'issue_show',
    label: 'issue_show',
    description: 'Show details for a beads issue by id.',
    parameters: Type.Object({
      id: Type.String({ description: 'Issue ID (for example PSFN-123 or PSFN-123.1).' }),
      actor: Type.Optional(Type.String({
        description: 'Optional actor identifier for audit attribution.',
      })),
    }),
    execute: async (
      _toolCallId: string,
      params: { id: string; actor?: string },
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const result = await ops.show({ id: params.id, actor: params.actor });
        return textResult(formatActionResult(result));
      } catch (error) {
        return textResultWithError(`issue_show failed: ${toErrorMessage(error)}`, true);
      }
    },
  };
}

export function createIssueCreateTool(ops: BeadsOperations): AgentTool<any> {
  return {
    name: 'issue_create',
    label: 'issue_create',
    description: 'Create a new beads issue with optional type/priority/dependencies.',
    parameters: Type.Object({
      title: Type.String({ description: 'Issue title.' }),
      issue_type: Type.Optional(Type.Union([
        Type.Literal('bug'),
        Type.Literal('feature'),
        Type.Literal('task'),
        Type.Literal('epic'),
        Type.Literal('chore'),
      ])),
      priority: Type.Optional(Type.Integer({
        minimum: 0,
        maximum: 4,
        description: 'Priority 0-4.',
      })),
      deps: Type.Optional(Type.Array(Type.String({
        description: 'Dependency refs (for example discovered-from:PSFN-123).',
      }), {
        maxItems: 16,
      })),
      parent: Type.Optional(Type.String({
        description: 'Optional parent issue ID for subtasks.',
      })),
      actor: Type.Optional(Type.String({
        description: 'Optional actor identifier for audit attribution.',
      })),
    }),
    execute: async (
      _toolCallId: string,
      params: {
        title: string;
        issue_type?: 'bug' | 'feature' | 'task' | 'epic' | 'chore';
        priority?: number;
        deps?: string[];
        parent?: string;
        actor?: string;
      },
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const result = await ops.create({
          title: params.title,
          issueType: params.issue_type,
          priority: params.priority,
          deps: params.deps,
          parent: params.parent,
          actor: params.actor,
        });
        return textResult(formatActionResult(result));
      } catch (error) {
        return textResultWithError(`issue_create failed: ${toErrorMessage(error)}`, true);
      }
    },
  };
}

export function createIssueUpdateTool(ops: BeadsOperations): AgentTool<any> {
  return {
    name: 'issue_update',
    label: 'issue_update',
    description: 'Update beads issue status and/or priority.',
    parameters: Type.Object({
      id: Type.String({ description: 'Issue ID to update.' }),
      status: Type.Optional(Type.Union([
        Type.Literal('open'),
        Type.Literal('in_progress'),
        Type.Literal('blocked'),
        Type.Literal('closed'),
      ])),
      priority: Type.Optional(Type.Integer({
        minimum: 0,
        maximum: 4,
        description: 'Priority 0-4.',
      })),
      actor: Type.Optional(Type.String({
        description: 'Optional actor identifier for audit attribution.',
      })),
    }),
    execute: async (
      _toolCallId: string,
      params: {
        id: string;
        status?: 'open' | 'in_progress' | 'blocked' | 'closed';
        priority?: number;
        actor?: string;
      },
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const result = await ops.update({
          id: params.id,
          status: params.status,
          priority: params.priority,
          actor: params.actor,
        });
        return textResult(formatActionResult(result));
      } catch (error) {
        return textResultWithError(`issue_update failed: ${toErrorMessage(error)}`, true);
      }
    },
  };
}

export function createIssueCloseTool(ops: BeadsOperations): AgentTool<any> {
  return {
    name: 'issue_close',
    label: 'issue_close',
    description: 'Close a beads issue with an explicit reason.',
    parameters: Type.Object({
      id: Type.String({ description: 'Issue ID to close.' }),
      reason: Type.String({ description: 'Close reason text.' }),
      actor: Type.Optional(Type.String({
        description: 'Optional actor identifier for audit attribution.',
      })),
    }),
    execute: async (
      _toolCallId: string,
      params: { id: string; reason: string; actor?: string },
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const result = await ops.close({
          id: params.id,
          reason: params.reason,
          actor: params.actor,
        });
        return textResult(formatActionResult(result));
      } catch (error) {
        return textResultWithError(`issue_close failed: ${toErrorMessage(error)}`, true);
      }
    },
  };
}

export function createIssueSyncTool(ops: BeadsOperations): AgentTool<any> {
  return {
    name: 'issue_sync',
    label: 'issue_sync',
    description: 'Run bd sync so issue JSONL stays aligned with git state.',
    parameters: Type.Object({
      actor: Type.Optional(Type.String({
        description: 'Optional actor identifier for audit attribution.',
      })),
    }),
    execute: async (
      _toolCallId: string,
      params: { actor?: string },
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const result = await ops.sync({ actor: params.actor });
        return textResult(formatActionResult(result));
      } catch (error) {
        return textResultWithError(`issue_sync failed: ${toErrorMessage(error)}`, true);
      }
    },
  };
}
