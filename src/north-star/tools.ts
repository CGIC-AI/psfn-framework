import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import {
  MAX_NORTH_STAR_ITEMS,
  NORTH_STAR_SCOPES,
  type NorthStarItem,
  type NorthStarScope,
  type NorthStarStore,
} from './store.js';
import { textResult, textResultWithError } from '../tools/results.js';
import { toErrorMessage } from '../utils/errors.js';

function errorMessage(error: unknown): string {
  return toErrorMessage(error);
}

function normalizeNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return trimmed;
}

function normalizeScope(value: unknown, defaultScope: NorthStarScope = 'shared'): NorthStarScope {
  if (value === undefined) return defaultScope;
  if (typeof value !== 'string' || !NORTH_STAR_SCOPES.includes(value as NorthStarScope)) {
    throw new Error(`scope must be one of: ${NORTH_STAR_SCOPES.join(', ')}`);
  }
  return value as NorthStarScope;
}

function normalizeEnabled(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error('enabled must be a boolean');
  }
  return value;
}

function resolveItemByPrefix(store: NorthStarStore, rawId: unknown): NorthStarItem {
  const requested = normalizeNonEmptyString(rawId, 'item_id');
  const matches = store.list().filter(item => item.id === requested || item.id.startsWith(requested));
  if (matches.length === 0) {
    throw new Error(`North Star item not found: ${requested}`);
  }
  if (matches.length > 1) {
    throw new Error(`North Star item id is ambiguous: ${requested}`);
  }
  return matches[0];
}

export function createNorthStarListTool(store: NorthStarStore): AgentTool<any> {
  return {
    name: 'north_star_list',
    label: 'north_star_list',
    description: 'List North Star long-term goals and the current composed prompt section.',
    parameters: Type.Object({}),
    execute: async (): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        return textResult(JSON.stringify({
          action: 'list',
          limit: MAX_NORTH_STAR_ITEMS,
          count: store.count,
          items: store.list(),
          preview: store.buildPromptLayer()?.content ?? null,
        }, null, 2));
      } catch (error) {
        return textResultWithError(`north_star_list failed: ${errorMessage(error)}`, true);
      }
    },
  };
}

export function createNorthStarCreateTool(store: NorthStarStore): AgentTool<any> {
  return {
    name: 'north_star_create',
    label: 'north_star_create',
    description: 'Create a North Star goal. The list is capped at three total items.',
    parameters: Type.Object({
      title: Type.String({ minLength: 1, description: 'Short goal title.' }),
      content: Type.String({ minLength: 1, description: 'Goal details or intent.' }),
      scope: Type.Optional(Type.Union(
        NORTH_STAR_SCOPES.map(scope => Type.Literal(scope)),
        { description: 'Whether the goal is shared or companion-owned.' },
      )),
      enabled: Type.Optional(Type.Boolean({ description: 'Whether to include this goal in the live prompt.' })),
    }),
    execute: async (
      _toolCallId: string,
      params: { title: string; content: string; scope?: NorthStarScope; enabled?: boolean },
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const item = store.create({
          title: normalizeNonEmptyString(params.title, 'title'),
          content: normalizeNonEmptyString(params.content, 'content'),
          scope: normalizeScope(params.scope),
          ...(params.enabled !== undefined ? { enabled: normalizeEnabled(params.enabled) } : {}),
          updatedBy: 'agent',
        });
        return textResult(JSON.stringify({
          action: 'created',
          item,
          count: store.count,
          limit: MAX_NORTH_STAR_ITEMS,
        }, null, 2));
      } catch (error) {
        return textResultWithError(`north_star_create failed: ${errorMessage(error)}`, true);
      }
    },
  };
}

export function createNorthStarUpdateTool(store: NorthStarStore): AgentTool<any> {
  return {
    name: 'north_star_update',
    label: 'north_star_update',
    description: 'Update a North Star goal by id or unique id prefix.',
    parameters: Type.Object({
      item_id: Type.String({ minLength: 1, description: 'North Star item id or unique prefix.' }),
      title: Type.Optional(Type.String({ minLength: 1, description: 'Updated goal title.' })),
      content: Type.Optional(Type.String({ minLength: 1, description: 'Updated goal details.' })),
      scope: Type.Optional(Type.Union(
        NORTH_STAR_SCOPES.map(scope => Type.Literal(scope)),
        { description: 'Updated goal scope.' },
      )),
      enabled: Type.Optional(Type.Boolean({ description: 'Whether the goal should stay active in the prompt.' })),
    }),
    execute: async (
      _toolCallId: string,
      params: { item_id: string; title?: string; content?: string; scope?: NorthStarScope; enabled?: boolean },
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const item = resolveItemByPrefix(store, params.item_id);
        const patch: {
          title?: string;
          content?: string;
          scope?: NorthStarScope;
          enabled?: boolean;
        } = {};
        if (params.title !== undefined) patch.title = normalizeNonEmptyString(params.title, 'title');
        if (params.content !== undefined) patch.content = normalizeNonEmptyString(params.content, 'content');
        if (params.scope !== undefined) patch.scope = normalizeScope(params.scope);
        if (params.enabled !== undefined) patch.enabled = normalizeEnabled(params.enabled);

        const updated = store.update(item.id, patch, 'agent');
        return textResult(JSON.stringify({
          action: 'updated',
          item: updated,
        }, null, 2));
      } catch (error) {
        return textResultWithError(`north_star_update failed: ${errorMessage(error)}`, true);
      }
    },
  };
}

export function createNorthStarDeleteTool(store: NorthStarStore): AgentTool<any> {
  return {
    name: 'north_star_delete',
    label: 'north_star_delete',
    description: 'Delete a North Star goal by id or unique id prefix.',
    parameters: Type.Object({
      item_id: Type.String({ minLength: 1, description: 'North Star item id or unique prefix.' }),
    }),
    execute: async (
      _toolCallId: string,
      params: { item_id: string },
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const item = resolveItemByPrefix(store, params.item_id);
        store.delete(item.id);
        return textResult(JSON.stringify({
          action: 'deleted',
          item_id: item.id,
          count: store.count,
        }, null, 2));
      } catch (error) {
        return textResultWithError(`north_star_delete failed: ${errorMessage(error)}`, true);
      }
    },
  };
}

export function createNorthStarReorderTool(store: NorthStarStore): AgentTool<any> {
  return {
    name: 'north_star_reorder',
    label: 'north_star_reorder',
    description: 'Reorder North Star goals by providing every current item id exactly once.',
    parameters: Type.Object({
      item_ids: Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        maxItems: MAX_NORTH_STAR_ITEMS,
        description: 'North Star item ids or unique prefixes in their desired order.',
      }),
    }),
    execute: async (
      _toolCallId: string,
      params: { item_ids: string[] },
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        if (!Array.isArray(params.item_ids) || params.item_ids.length === 0) {
          throw new Error('item_ids must be a non-empty array');
        }
        const resolvedIds = params.item_ids.map(itemId => resolveItemByPrefix(store, itemId).id);
        const touched = store.reorder(resolvedIds, 'agent');
        return textResult(JSON.stringify({
          action: 'reordered',
          touched: touched.map(item => item.id),
          items: store.list(),
        }, null, 2));
      } catch (error) {
        return textResultWithError(`north_star_reorder failed: ${errorMessage(error)}`, true);
      }
    },
  };
}
