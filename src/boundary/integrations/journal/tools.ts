import { Type } from '@sinclair/typebox';
import { CANONICAL_TOOL_SURFACE_DESCRIPTIONS } from '../../../core/agent/tool-surface/descriptions.js';
import type { AgentToolResult } from '../../pi-agent/index.js';
import type { SubstrateAgentTool } from '../../pi-agent/index.js';
import type { JournalOperations } from './ops.js';
import { textResult, textResultWithError } from '../../../core/tools/results.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';

const JOURNAL_ACTIONS = ['list', 'read', 'write', 'append', 'search'] as const;
type JournalAction = typeof JOURNAL_ACTIONS[number];

interface JournalToolParams {
  action: JournalAction;
  path?: string;
  title?: string;
  content?: string;
  query?: string;
  limit?: number;
  offset_bytes?: number;
}

function requireAction(value: unknown): JournalAction {
  if (typeof value !== 'string' || !(JOURNAL_ACTIONS as readonly string[]).includes(value)) {
    throw new Error(`action must be one of: ${JOURNAL_ACTIONS.join(', ')}`);
  }
  return value as JournalAction;
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function resolveNotePath(params: JournalToolParams): string {
  if (typeof params.path === 'string' && params.path.trim().length > 0) {
    return params.path.trim();
  }
  const title = requireNonEmpty(params.title, 'path or title');
  return slugifyTitle(title);
}

function slugifyTitle(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) {
    throw new Error('title must contain at least one letter or number');
  }
  return slug;
}

export function createJournalTool(ops: JournalOperations): SubstrateAgentTool {
  return {
    name: 'journal',
    label: 'journal',
    description: CANONICAL_TOOL_SURFACE_DESCRIPTIONS.journal,
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal('list'),
        Type.Literal('read'),
        Type.Literal('write'),
        Type.Literal('append'),
        Type.Literal('search'),
      ], {
        description: 'Journal action.',
      }),
      path: Type.Optional(Type.String({
        minLength: 1,
        description: 'Markdown note path relative to the journal root. .md is added if omitted.',
      })),
      title: Type.Optional(Type.String({
        minLength: 1,
        description: 'Optional title used to create a slug path when path is not provided.',
      })),
      content: Type.Optional(Type.String({
        description: 'Markdown content for action=write or action=append.',
      })),
      query: Type.Optional(Type.String({
        minLength: 1,
        description: 'Search query for action=search.',
      })),
      limit: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: 100,
        description: 'Maximum search results for action=search.',
      })),
      offset_bytes: Type.Optional(Type.Integer({
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
        description: 'Byte offset for action=read. Repeat with the returned next_offset_bytes until eof=true.',
      })),
    }),
    execute: async (
      _toolCallId: string,
      params: JournalToolParams,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      let action = typeof params.action === 'string' ? params.action : 'unknown';
      try {
        action = requireAction(params.action);
        switch (action) {
          case 'list': {
            const result = await ops.list();
            if (result.notes.length === 0) {
              return textResult('Journal is empty.');
            }
            return textResult(
              `Journal notes (${String(result.notes.length)} of ${String(result.totalFiles)}):\n`
              + `List truncated: ${String(result.truncated)}\n`
              + result.notes.map(note => `- ${note}`).join('\n'),
            );
          }
          case 'read': {
            const result = await ops.read(resolveNotePath(params), {
              offsetBytes: params.offset_bytes,
            });
            return textResult(
              `=== ${result.path} ===\n`
              + `offset_bytes: ${String(result.offsetBytes)}\n`
              + `next_offset_bytes: ${result.nextOffsetBytes === null ? 'null' : String(result.nextOffsetBytes)}\n`
              + `eof: ${String(result.eof)}\n\n`
              + result.content,
            );
          }
          case 'write': {
            const result = await ops.write(resolveNotePath(params), requireNonEmpty(params.content, 'content'));
            return textResult(`Journal note ${result.created ? 'created' : 'replaced'}: ${result.path}`);
          }
          case 'append': {
            const result = await ops.append(resolveNotePath(params), requireNonEmpty(params.content, 'content'));
            return textResult(`Journal note ${result.created ? 'created' : 'appended'}: ${result.path}`);
          }
          case 'search': {
            const result = await ops.search(requireNonEmpty(params.query, 'query'), params.limit);
            if (result.results.length === 0) {
              return textResult(
                `No journal results for: ${result.query}\n`
                + formatSearchMetadata(result),
              );
            }
            const lines = result.results.map((entry, index) => `${index + 1}. ${entry.path}\n   ${entry.snippet}`);
            return textResult(
              `Journal search: "${result.query}" (${String(result.results.length)} results)\n`
              + `${formatSearchMetadata(result)}\n\n`
              + lines.join('\n'),
            );
          }
        }
        return textResultWithError(`journal failed for action=${action}: unsupported action`, true);
      } catch (error) {
        return textResultWithError(`journal failed for action=${action}: ${toErrorMessage(error)}`, true);
      }
    },
  };
}

function formatSearchMetadata(result: Awaited<ReturnType<JournalOperations['search']>>): string {
  const skipped = result.skippedOversizedFiles.length > 0
    ? `\nSkipped oversized notes: ${result.skippedOversizedFiles.join(', ')}`
    : '';
  return `Search complete: ${String(result.complete)}; `
    + `scanned ${String(result.scannedFiles)} of ${String(result.totalFiles)} notes `
    + `(${String(result.scannedBytes)} bytes); `
    + `more matches than limit: ${String(result.resultLimitReached)}.`
    + skipped;
}
