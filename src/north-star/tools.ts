import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import {
  MAX_NORTH_STAR_ITEMS,
  NORTH_STAR_SCOPES,
  type NorthStarItem,
  type NorthStarScope,
  type NorthStarStore,
} from './store.js';
import { withCapabilityRequirement, type CapabilityRequirement } from '../capabilities/requirements.js';
import { tagToolWithReversibility } from '../capabilities/safeguards.js';
import { textResult, textResultWithError } from '../tools/results.js';
import { toErrorMessage } from '../utils/errors.js';

const NORTH_STAR_ACTIONS = ['list', 'create', 'update', 'delete', 'reorder'] as const;
type NorthStarAction = (typeof NORTH_STAR_ACTIONS)[number];

interface NorthStarToolParams {
  action?: NorthStarAction;
  item_id?: string;
  item_ids?: string[];
  title?: string;
  content?: string;
  scope?: NorthStarScope;
  enabled?: boolean;
}

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

function normalizeAction(value: unknown): NorthStarAction {
  if (value === undefined) return 'list';
  if (typeof value !== 'string') {
    throw new Error(`action must be one of: ${NORTH_STAR_ACTIONS.join(', ')}`);
  }
  const normalized = value.trim();
  if ((NORTH_STAR_ACTIONS as readonly string[]).includes(normalized)) {
    return normalized as NorthStarAction;
  }
  throw new Error(`action must be one of: ${NORTH_STAR_ACTIONS.join(', ')}`);
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

function resolveNorthStarCapabilityRequirement(params: Record<string, unknown>): CapabilityRequirement {
  const rawAction = typeof params.action === 'string' ? params.action.trim() : '';
  switch (rawAction) {
    case '':
    case 'list':
      return 'identity.read';
    case 'create':
    case 'update':
    case 'delete':
    case 'reorder':
      return 'identity.write.runtime';
    default:
      return ['identity.read', 'identity.write.runtime'];
  }
}

export function createNorthStarTool(store: NorthStarStore): AgentTool<any> {
  const tool: AgentTool<any> = {
    name: 'north_star',
    label: 'north_star',
    description:
      'Manage North Star long-horizon guiding intent. ' +
      'Use action=list|create|update|delete|reorder. ' +
      'This surface stays separate from orient and identity and is not for transient session state.',
    parameters: Type.Object({
      action: Type.Optional(Type.Union(
        NORTH_STAR_ACTIONS.map(action => Type.Literal(action)),
        { description: 'North Star action. Defaults to list.' },
      )),
      item_id: Type.Optional(Type.String({
        minLength: 1,
        description: 'North Star item id or unique prefix for update/delete.',
      })),
      item_ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        maxItems: MAX_NORTH_STAR_ITEMS,
        description: 'North Star item ids or unique prefixes in their desired order for reorder.',
      })),
      title: Type.Optional(Type.String({ minLength: 1, description: 'Short long-horizon guiding title.' })),
      content: Type.Optional(Type.String({ minLength: 1, description: 'North Star details or intent.' })),
      scope: Type.Optional(Type.Union(
        NORTH_STAR_SCOPES.map(scope => Type.Literal(scope)),
        { description: 'Whether the North Star item is shared or companion-owned.' },
      )),
      enabled: Type.Optional(Type.Boolean({ description: 'Whether to include this item in the live prompt.' })),
    }),
    execute: async (
      _toolCallId: string,
      params: NorthStarToolParams = {},
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      const action = (() => {
        try {
          return normalizeAction(params.action);
        } catch (error) {
          return error;
        }
      })();

      if (action instanceof Error) {
        return textResultWithError(`north_star failed: ${action.message}`, true);
      }

      try {
        switch (action) {
          case 'list':
            return textResult(JSON.stringify({
              action: 'list',
              limit: MAX_NORTH_STAR_ITEMS,
              count: store.count,
              items: store.list(),
              preview: store.buildPromptLayer()?.content ?? null,
            }, null, 2));

          case 'create': {
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
          }

          case 'update': {
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
          }

          case 'delete': {
            const item = resolveItemByPrefix(store, params.item_id);
            store.delete(item.id);
            return textResult(JSON.stringify({
              action: 'deleted',
              item_id: item.id,
              count: store.count,
            }, null, 2));
          }

          case 'reorder': {
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
          }
        }
        throw new Error('action is required. Supported actions: list, create, update, delete, reorder');
      } catch (error) {
        return textResultWithError(`north_star failed for action=${action}: ${errorMessage(error)}`, true);
      }
    },
  };

  return tagToolWithReversibility(
    withCapabilityRequirement(tool, resolveNorthStarCapabilityRequirement),
    'irreversible',
  );
}
