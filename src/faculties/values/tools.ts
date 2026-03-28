import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { ValuesJournalStore } from './store.js';
import { textResult, textResultWithError } from '../../core/tools/results.js';
import { toErrorMessage } from '../../shared/utils/errors.js';

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 200;

const VALUES_ADD_TEMPLATE_ID = 'values-tool';
const VALUES_ADD_TEMPLATE_NAME = 'Values Tool';
const VALUES_UPDATE_TEMPLATE_ID = 'values-tool-update';
const VALUES_UPDATE_TEMPLATE_NAME = 'Values Tool Update';

interface ValuesListParams {
  limit?: number;
}

interface ValuesAddParams {
  value: string;
  context?: string;
}

interface ValuesUpdateParams {
  version: number;
  value: string;
  context?: string;
}

function errorMessage(error: unknown): string {
  return toErrorMessage(error);
}

function normalizeLimit(limit: unknown): number {
  if (limit === undefined) return DEFAULT_LIST_LIMIT;
  if (typeof limit !== 'number' || !Number.isFinite(limit) || !Number.isInteger(limit)) {
    throw new Error('limit must be an integer');
  }
  if (limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new Error(`limit must be between 1 and ${String(MAX_LIST_LIMIT)}`);
  }
  return limit;
}

function normalizeVersion(version: unknown): number {
  if (typeof version !== 'number' || !Number.isFinite(version) || !Number.isInteger(version) || version < 1) {
    throw new Error('version must be an integer >= 1');
  }
  return version;
}

function normalizeValue(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('value must be a string');
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error('value must be a non-empty string');
  }
  return trimmed;
}

function normalizeOptionalContext(context: unknown): string | undefined {
  if (context === undefined) return undefined;
  if (typeof context !== 'string') {
    throw new Error('context must be a string when provided');
  }
  const trimmed = context.trim();
  if (trimmed.length === 0) {
    throw new Error('context must be a non-empty string when provided');
  }
  return trimmed;
}

export function createValuesListTool(store: ValuesJournalStore): AgentTool<any> {
  return {
    name: 'values_list',
    label: 'values_list',
    description: 'List values journal entries (newest-first) with optional bounded limit.',
    parameters: Type.Object({
      limit: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: MAX_LIST_LIMIT,
        description: `Max entries to return (default ${String(DEFAULT_LIST_LIMIT)}).`,
      })),
    }),
    execute: async (
      _toolCallId: string,
      params: ValuesListParams,
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const limit = normalizeLimit(params.limit);
        const entries = store.list({ limit });
        return textResult(JSON.stringify({
          action: 'list',
          limit,
          count: entries.length,
          entries,
        }, null, 2));
      } catch (error) {
        return textResultWithError(`values_list failed: ${errorMessage(error)}`, true);
      }
    },
  };
}

export function createValuesAddTool(store: ValuesJournalStore): AgentTool<any> {
  return {
    name: 'values_add',
    label: 'values_add',
    description: 'Append a manual values journal entry.',
    parameters: Type.Object({
      value: Type.String({ minLength: 1, description: 'Values statement to persist.' }),
      context: Type.Optional(Type.String({ description: 'Optional prompt/context for this values entry.' })),
    }),
    execute: async (
      _toolCallId: string,
      params: ValuesAddParams,
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const value = normalizeValue(params.value);
        const context = normalizeOptionalContext(params.context)
          ?? 'Manual values entry created via values_add.';
        const entry = store.append({
          templateId: VALUES_ADD_TEMPLATE_ID,
          templateName: VALUES_ADD_TEMPLATE_NAME,
          prompt: context,
          reflection: value,
          provenance: {
            source: 'values_add_tool',
            templateId: VALUES_ADD_TEMPLATE_ID,
            templateName: VALUES_ADD_TEMPLATE_NAME,
          },
        });
        return textResult(JSON.stringify({
          action: 'added',
          mode: 'append_only',
          entry,
        }, null, 2));
      } catch (error) {
        return textResultWithError(`values_add failed: ${errorMessage(error)}`, true);
      }
    },
  };
}

export function createValuesUpdateTool(store: ValuesJournalStore): AgentTool<any> {
  return {
    name: 'values_update',
    label: 'values_update',
    description:
      'Create an append-only revision for an existing values journal version. ' +
      'This does not mutate historical entries.',
    parameters: Type.Object({
      version: Type.Integer({ minimum: 1, description: 'Existing values journal version to revise.' }),
      value: Type.String({ minLength: 1, description: 'Revised values statement.' }),
      context: Type.Optional(Type.String({ description: 'Optional revision prompt/context.' })),
    }),
    execute: async (
      _toolCallId: string,
      params: ValuesUpdateParams,
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const version = normalizeVersion(params.version);
        const value = normalizeValue(params.value);
        const source = store.list().find(entry => entry.version === version);
        if (!source) {
          return textResultWithError(`values_update failed: version ${String(version)} not found`, true);
        }

        const context = normalizeOptionalContext(params.context)
          ?? `Revision of values entry v${String(version)} (${source.id}).`;
        const entry = store.append({
          templateId: VALUES_UPDATE_TEMPLATE_ID,
          templateName: VALUES_UPDATE_TEMPLATE_NAME,
          prompt: context,
          reflection: value,
          provenance: {
            source: 'values_update_tool',
            templateId: VALUES_UPDATE_TEMPLATE_ID,
            templateName: VALUES_UPDATE_TEMPLATE_NAME,
            derivedFromVersion: source.version,
          },
        });
        return textResult(JSON.stringify({
          action: 'updated',
          mode: 'append_only_revision',
          source: {
            id: source.id,
            version: source.version,
            templateId: source.templateId,
            createdAt: source.createdAt,
          },
          entry,
        }, null, 2));
      } catch (error) {
        return textResultWithError(`values_update failed: ${errorMessage(error)}`, true);
      }
    },
  };
}
