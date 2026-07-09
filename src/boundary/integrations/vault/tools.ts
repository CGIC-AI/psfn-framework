// ── External Obsidian Vault Tool ──
// Legacy external Obsidian bridge for bounded source access and compatibility.

import { Type } from '@sinclair/typebox';
import type { AgentToolResult } from '@mariozechner/pi-agent-core';
import type { SubstrateAgentTool } from '../../../shared/contracts/agent-tools.js';
import type { VaultOperations } from './ops.js';
import { textResult, textResultWithError } from '../../../core/tools/results.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import { truncateToolOutputContent } from '../../../shared/utils/tool-output.js';

const MAX_READ_CHARS = 12_000;
const VAULT_ACTION_HELP = 'read, write, search, daily';

type VaultActionName =
  | 'read'
  | 'vault_read'
  | 'write'
  | 'vault_write'
  | 'search'
  | 'vault_search'
  | 'daily'
  | 'vault_daily';

type VaultAction = 'read' | 'write' | 'search' | 'daily';

interface VaultToolParams {
  action?: VaultActionName;
  name?: string;
  content?: string;
  folder?: string;
  mode?: 'create' | 'append' | 'prepend';
  query?: string;
  limit?: number;
}

function normalizeVaultAction(params: VaultToolParams): VaultAction {
  const rawAction = typeof params.action === 'string' ? params.action.trim() : '';
  if (rawAction) {
    switch (rawAction) {
      case 'read':
      case 'vault_read':
        return 'read';
      case 'write':
      case 'vault_write':
        return 'write';
      case 'search':
      case 'vault_search':
        return 'search';
      case 'daily':
      case 'vault_daily':
        return 'daily';
      default:
        throw new Error(`action must be one of: ${VAULT_ACTION_HELP}`);
    }
  }

  const hasName = typeof params.name === 'string';
  const hasContent = typeof params.content === 'string';
  const hasQuery = typeof params.query === 'string';
  const hasFolder = typeof params.folder === 'string';
  const hasMode = typeof params.mode === 'string';
  const hasLimit = typeof params.limit === 'number';

  if (hasQuery && !hasName && !hasContent && !hasFolder && !hasMode) {
    return 'search';
  }
  if (hasName && hasContent) {
    return 'write';
  }
  if (hasName && !hasContent && !hasQuery && !hasFolder && !hasMode && !hasLimit) {
    return 'read';
  }
  if (!hasName && hasContent && !hasQuery && !hasFolder && !hasMode && !hasLimit) {
    return 'daily';
  }

  throw new Error(`action is required. Supported actions: ${VAULT_ACTION_HELP}`);
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} is required.`);
  }
  return value;
}

async function executeVaultRead(
  ops: VaultOperations,
  params: VaultToolParams,
): Promise<AgentToolResult<{ isError?: boolean }>> {
  const name = requireNonEmptyString(params.name, 'name');
  const result = await ops.read(name);
  return textResult(`=== ${result.name} ===\n${truncateToolOutputContent(result.content, MAX_READ_CHARS)}`);
}

async function executeVaultWrite(
  ops: VaultOperations,
  params: VaultToolParams,
): Promise<AgentToolResult<{ isError?: boolean }>> {
  const result = await ops.write(
    requireNonEmptyString(params.name, 'name'),
    requireNonEmptyString(params.content, 'content'),
    {
      folder: params.folder,
      mode: params.mode,
    },
  );
  const location = result.folder ? `${result.folder}${result.name}` : result.name;
  return textResult(`Note ${result.mode === 'create' ? 'created' : `${result.mode}ed`}: ${location}`);
}

async function executeVaultSearch(
  ops: VaultOperations,
  params: VaultToolParams,
): Promise<AgentToolResult<{ isError?: boolean }>> {
  const result = await ops.search(requireNonEmptyString(params.query, 'query'), params.limit ?? 20);
  if (result.results.length === 0) {
    return textResult(`No results for: ${result.query}`);
  }

  const lines = result.results.map((entry, index) => {
    const line = `${index + 1}. ${entry.path}`;
    return entry.snippet ? `${line}\n   ${entry.snippet}` : line;
  });
  return textResult(`Search: "${result.query}" (${result.results.length} results)\n\n${lines.join('\n')}`);
}

async function executeVaultDaily(
  ops: VaultOperations,
  params: VaultToolParams,
): Promise<AgentToolResult<{ isError?: boolean }>> {
  const result = await ops.daily(typeof params.content === 'string' ? { content: params.content } : undefined);
  if (result.mode === 'read') {
    const content = result.content ? truncateToolOutputContent(result.content, MAX_READ_CHARS) : '(empty)';
    return textResult(`=== Daily Note (${result.date}) ===\n${content}`);
  }
  return textResult(`Appended to daily note (${result.date})`);
}

export function createVaultTool(ops: VaultOperations): SubstrateAgentTool {
  return {
    name: 'vault',
    label: 'vault',
    description:
      'Legacy external Obsidian/Vault bridge for bounded read, write, search, and daily-note compatibility. '
      + 'Canonical durable reference knowledge belongs in the internal wiki tool, not vault. '
      + 'Use action=read|write|search|daily. Legacy vault_* aliases remain accepted as action values only.',
    parameters: Type.Object({
      action: Type.Optional(Type.Union([
        Type.Literal('read'),
        Type.Literal('vault_read'),
        Type.Literal('write'),
        Type.Literal('vault_write'),
        Type.Literal('search'),
        Type.Literal('vault_search'),
        Type.Literal('daily'),
        Type.Literal('vault_daily'),
      ], {
        description: 'Vault action. Preferred actions: read, write, search, daily.',
      })),
      name: Type.Optional(Type.String({
        minLength: 1,
        description: 'Used with action=read|write. Note name or path relative to the configured external vault root.',
      })),
      content: Type.Optional(Type.String({
        description: 'Used with action=write to write markdown, or action=daily to append to today\'s daily note.',
      })),
      folder: Type.Optional(Type.String({
        minLength: 1,
        description: 'Used with action=write mode=create. Folder path within the configured external vault root.',
      })),
      mode: Type.Optional(Type.Union([
        Type.Literal('create'),
        Type.Literal('append'),
        Type.Literal('prepend'),
      ], {
        description: 'Used with action=write. Default: create.',
      })),
      query: Type.Optional(Type.String({
        minLength: 1,
        description: 'Used with action=search. Supports Obsidian search syntax.',
      })),
      limit: Type.Optional(Type.Number({
        description: 'Used with action=search. Maximum results, default 20.',
        minimum: 1,
        maximum: 100,
      })),
    }),
    execute: async (
      _toolCallId: string,
      params: VaultToolParams = {},
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      let actionForError = typeof params.action === 'string' ? params.action : undefined;
      try {
        actionForError = normalizeVaultAction(params);
        switch (actionForError) {
          case 'read':
            return await executeVaultRead(ops, params);
          case 'write':
            return await executeVaultWrite(ops, params);
          case 'search':
            return await executeVaultSearch(ops, params);
          case 'daily':
            return await executeVaultDaily(ops, params);
        }
      } catch (error) {
        const suffix = actionForError ? ` for action=${actionForError}` : '';
        return textResultWithError(`vault failed${suffix}: ${toErrorMessage(error)}`, true);
      }
    },
  };
}
