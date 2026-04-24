import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import {
  ACTIVE_CONCERN_PRIORITIES,
  type ActiveConcernPriority,
} from './concerns.js';
import type { ConcernStorePort } from './concern-store-port.js';
import { textResultWithError } from '../tools/results.js';
import { toErrorMessage } from '../../shared/utils/errors.js';

interface ListConcernsParams {
  contactId?: string;
  includeResolved?: boolean;
  includeExpired?: boolean;
  limit?: number;
}

interface ResolveConcernParams {
  concernId: string;
  outcome?: string;
}

interface CreateConcernParams {
  text: string;
  priority?: ActiveConcernPriority;
  contactId?: string;
  source?: 'appraisal' | 'agent' | 'heartbeat';
}

function textResult(text: string): AgentToolResult<{ isError?: boolean }> {
  return {
    content: [{ type: 'text', text }],
    details: {},
  };
}

export function createListConcernsTool(store: ConcernStorePort): AgentTool<any> {
  return {
    name: 'list_concerns',
    label: 'list_concerns',
    description: 'List active concerns. Optionally include resolved/expired concerns and filter by contact.',
    parameters: Type.Object({
      contactId: Type.Optional(Type.String({ minLength: 1, description: 'Optional contact id filter.' })),
      includeResolved: Type.Optional(Type.Boolean({
        description: 'Include concerns that have already been resolved.',
      })),
      includeExpired: Type.Optional(Type.Boolean({
        description: 'Include concerns that are already expired.',
      })),
      limit: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: 200,
        description: 'Maximum number of concerns to return (default 32).',
      })),
    }),
    execute: async (
      _toolCallId: string,
      params: ListConcernsParams,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const concerns = await store.list({
          contactId: params.contactId,
          includeResolved: params.includeResolved,
          includeExpired: params.includeExpired,
          limit: params.limit,
        });

        return textResult(JSON.stringify({
          count: concerns.length,
          concerns,
        }, null, 2));
      } catch (error) {
        return textResultWithError(`list_concerns failed: ${toErrorMessage(error)}`, true);
      }
    },
  };
}

export function createResolveConcernTool(store: ConcernStorePort): AgentTool<any> {
  return {
    name: 'resolve_concern',
    label: 'resolve_concern',
    description: 'Resolve an active concern once it has been handled or no longer needs tracking.',
    parameters: Type.Object({
      concernId: Type.String({
        minLength: 1,
        description: 'Concern id to resolve.',
      }),
      outcome: Type.Optional(Type.String({
        minLength: 1,
        description: 'Optional concise outcome note.',
      })),
    }),
    execute: async (
      _toolCallId: string,
      params: ResolveConcernParams,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const resolved = await store.resolveConcern(params.concernId, {
          outcome: params.outcome,
        });
        if (!resolved) {
          return textResultWithError(`No unresolved concern found for id: ${params.concernId}`, true);
        }

        return textResult(JSON.stringify({
          resolved: true,
          concern: resolved,
        }, null, 2));
      } catch (error) {
        return textResultWithError(`resolve_concern failed: ${toErrorMessage(error)}`, true);
      }
    },
  };
}

export function createCreateConcernTool(store: ConcernStorePort): AgentTool<any> {
  return {
    name: 'create_concern',
    label: 'create_concern',
    description: 'Create a new active concern for short-lived follow-up tracking.',
    parameters: Type.Object({
      text: Type.String({
        minLength: 1,
        description: 'Concern text. Keep this concrete and actionable.',
      }),
      priority: Type.Optional(Type.Unsafe<ActiveConcernPriority>({
        type: 'string',
        enum: [...ACTIVE_CONCERN_PRIORITIES],
        description: 'Concern priority (high, medium, low). Defaults to medium.',
      })),
      contactId: Type.Optional(Type.String({
        minLength: 1,
        description: 'Optional contact id this concern is scoped to.',
      })),
      source: Type.Optional(Type.Union([
        Type.Literal('appraisal'),
        Type.Literal('agent'),
        Type.Literal('heartbeat'),
      ], {
        description: 'Creation source. Defaults to agent.',
      })),
    }),
    execute: async (
      _toolCallId: string,
      params: CreateConcernParams,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const created = await store.create({
          text: params.text,
          priority: params.priority,
          contactId: params.contactId,
          source: params.source,
        });
        return textResult(JSON.stringify({
          created: true,
          concern: created,
        }, null, 2));
      } catch (error) {
        return textResultWithError(`create_concern failed: ${toErrorMessage(error)}`, true);
      }
    },
  };
}
