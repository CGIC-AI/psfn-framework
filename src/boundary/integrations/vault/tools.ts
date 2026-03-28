// ── Obsidian Vault Tools ──
// 4 agent-accessible tools for reading/writing notes in an Obsidian vault.
// Read: vault_read, vault_search
// Write: vault_write, vault_daily

import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { VaultOperations } from './ops.js';
import { textResult, textResultWithError } from '../../../core/tools/results.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';

const MAX_READ_CHARS = 12_000;

export function createVaultWriteTool(ops: VaultOperations): AgentTool<any> {
  return {
    name: 'vault_write',
    label: 'vault_write',
    description:
      'Create or append to a markdown note in the Obsidian vault. ' +
      'Use mode "create" for new notes, "append" to add to existing notes, "prepend" to add at the top.',
    parameters: Type.Object({
      name: Type.String({ description: 'Note name (without .md extension) or path relative to vault root.' }),
      content: Type.String({ description: 'Markdown content to write.' }),
      folder: Type.Optional(
        Type.String({ description: 'Folder path within the vault (e.g. "Journal/" or "Reflections/musings/"). Only used with mode "create".' }),
      ),
      mode: Type.Optional(
        Type.Union([
          Type.Literal('create'),
          Type.Literal('append'),
          Type.Literal('prepend'),
        ], { description: 'Write mode. Default: "create".' }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: { name: string; content: string; folder?: string; mode?: 'create' | 'append' | 'prepend' },
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const result = await ops.write(params.name, params.content, {
          folder: params.folder,
          mode: params.mode,
        });
        const location = result.folder ? `${result.folder}${result.name}` : result.name;
        return textResult(`Note ${result.mode === 'create' ? 'created' : result.mode + 'ed'}: ${location}`);
      } catch (error) {
        return textResultWithError(`vault_write failed: ${toErrorMessage(error)}`, true);
      }
    },
  };
}

export function createVaultReadTool(ops: VaultOperations): AgentTool<any> {
  return {
    name: 'vault_read',
    label: 'vault_read',
    description: 'Read the content of a note from the Obsidian vault.',
    parameters: Type.Object({
      name: Type.String({ description: 'Note name or path relative to vault root.' }),
    }),
    execute: async (
      _toolCallId: string,
      params: { name: string },
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const result = await ops.read(params.name);
        const content = result.content.length > MAX_READ_CHARS
          ? result.content.slice(0, MAX_READ_CHARS) + '\n... (truncated)'
          : result.content;
        return textResult(`=== ${result.name} ===\n${content}`);
      } catch (error) {
        return textResultWithError(`vault_read failed: ${toErrorMessage(error)}`, true);
      }
    },
  };
}

export function createVaultSearchTool(ops: VaultOperations): AgentTool<any> {
  return {
    name: 'vault_search',
    label: 'vault_search',
    description: "Search for notes in the Obsidian vault using Obsidian's search syntax.",
    parameters: Type.Object({
      query: Type.String({ description: 'Search query (supports Obsidian search syntax).' }),
      limit: Type.Optional(
        Type.Number({ description: 'Maximum number of results. Default: 20.', minimum: 1, maximum: 100 }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: { query: string; limit?: number },
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const result = await ops.search(params.query, params.limit ?? 20);
        if (result.results.length === 0) {
          return textResult(`No results for: ${result.query}`);
        }
        const lines = result.results.map((r, i) => {
          const line = `${i + 1}. ${r.path}`;
          return r.snippet ? `${line}\n   ${r.snippet}` : line;
        });
        return textResult(`Search: "${result.query}" (${result.results.length} results)\n\n${lines.join('\n')}`);
      } catch (error) {
        return textResultWithError(`vault_search failed: ${toErrorMessage(error)}`, true);
      }
    },
  };
}

export function createVaultDailyTool(ops: VaultOperations): AgentTool<any> {
  return {
    name: 'vault_daily',
    label: 'vault_daily',
    description:
      "Read or append to today's daily note. " +
      'Without content, reads the current daily note. With content, appends to it.',
    parameters: Type.Object({
      content: Type.Optional(
        Type.String({ description: 'Content to append to the daily note. If omitted, reads the current daily note.' }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: { content?: string },
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const result = await ops.daily(params.content ? { content: params.content } : undefined);
        if (result.mode === 'read') {
          const content = result.content && result.content.length > MAX_READ_CHARS
            ? result.content.slice(0, MAX_READ_CHARS) + '\n... (truncated)'
            : (result.content || '(empty)');
          return textResult(`=== Daily Note (${result.date}) ===\n${content}`);
        }
        return textResult(`Appended to daily note (${result.date})`);
      } catch (error) {
        return textResultWithError(`vault_daily failed: ${toErrorMessage(error)}`, true);
      }
    },
  };
}
