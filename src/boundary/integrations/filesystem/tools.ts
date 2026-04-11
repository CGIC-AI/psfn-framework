import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { FilesystemOperations } from './ops.js';
import { textResult, textResultWithError } from '../../../core/tools/results.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';

const DEFAULT_LIST_MAX_ENTRIES = 200;
const MAX_LIST_MAX_ENTRIES = 500;
const MAX_READ_CHARS = 20_000;
const DEFAULT_SEARCH_MAX_MATCHES = 50;
const MAX_SEARCH_MAX_MATCHES = 200;
const DEFAULT_SEARCH_MAX_FILES = 200;
const MAX_SEARCH_MAX_FILES = 500;
const DEFAULT_SEARCH_MAX_BYTES_PER_FILE = 40_000;
const MAX_SEARCH_MAX_BYTES_PER_FILE = 200_000;
const MAX_CONTEXT_LINES = 2;

type FilesystemAction = 'list' | 'read' | 'search' | 'write' | 'edit';

function normalizeAction(params: Record<string, unknown>): FilesystemAction {
  const action = typeof params.action === 'string' ? params.action.trim() : '';
  if (action.length === 0 && Object.keys(params).length === 0) {
    return 'list';
  }

  switch (action) {
    case 'list':
    case 'read':
    case 'search':
    case 'write':
    case 'edit':
      return action;
    default:
      throw new Error('action is required. Supported actions: list, read, search, write, edit.');
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} is required.`);
  }
  return value;
}

function requireStringField(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${field} is required.`);
  }
  return value;
}

export function createFsTool(ops: FilesystemOperations): AgentTool<any> {
  return {
    name: 'fs',
    label: 'fs',
    description:
      'Unified filesystem primitive for workspace inspection and safe mutation. '
      + 'Use action=list|read|search|write|edit. Prefer list/search/read for common file inspection before think. '
      + 'Writes stay explicit, bounded, and fail closed on unsafe overwrite/edit requests.',
    parameters: Type.Object({
      action: Type.Optional(Type.Union([
        Type.Literal('list'),
        Type.Literal('read'),
        Type.Literal('search'),
        Type.Literal('write'),
        Type.Literal('edit'),
      ], {
        description: 'Filesystem action. Defaults to list for empty-argument calls.',
      })),
      path: Type.Optional(Type.String({
        description: 'Workspace-relative path for action=read, action=write, or action=edit.',
      })),
      glob: Type.Optional(Type.String({
        description: 'Workspace-relative glob for action=list or action=search. Defaults to **/*.',
      })),
      max_entries: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: MAX_LIST_MAX_ENTRIES,
        description: `Used with action=list. Max entries to return (default ${String(DEFAULT_LIST_MAX_ENTRIES)}).`,
      })),
      max_bytes: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: MAX_READ_CHARS,
        description: `Used with action=read. Read at most this many bytes (default ${String(MAX_READ_CHARS)}).`,
      })),
      query: Type.Optional(Type.String({
        description: 'Used with action=search. Literal text or regex pattern to find.',
      })),
      mode: Type.Optional(Type.Union([
        Type.Literal('literal'),
        Type.Literal('regex'),
      ], { description: 'Used with action=search. Defaults to literal.' })),
      max_matches: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: MAX_SEARCH_MAX_MATCHES,
        description: `Used with action=search. Max matches to return (default ${String(DEFAULT_SEARCH_MAX_MATCHES)}).`,
      })),
      max_files: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: MAX_SEARCH_MAX_FILES,
        description: `Used with action=search. Max files to scan (default ${String(DEFAULT_SEARCH_MAX_FILES)}).`,
      })),
      max_bytes_per_file: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: MAX_SEARCH_MAX_BYTES_PER_FILE,
        description:
          `Used with action=search. Max bytes to inspect per file (default ${String(DEFAULT_SEARCH_MAX_BYTES_PER_FILE)}).`,
      })),
      context_lines: Type.Optional(Type.Integer({
        minimum: 0,
        maximum: MAX_CONTEXT_LINES,
        description: 'Used with action=search. Context lines to include around each match.',
      })),
      content: Type.Optional(Type.String({
        description: 'Used with action=write. Full replacement file content.',
      })),
      overwrite: Type.Optional(Type.Boolean({
        description: 'Used with action=write. Required to replace an existing file with different content.',
      })),
      old_text: Type.Optional(Type.String({
        description: 'Used with action=edit. Exact existing text to replace.',
      })),
      new_text: Type.Optional(Type.String({
        description: 'Used with action=edit. Replacement text.',
      })),
      replace_all: Type.Optional(Type.Boolean({
        description: 'Used with action=edit. Set true only when intentionally replacing every exact old_text match.',
      })),
    }),
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const action = normalizeAction(params);

        switch (action) {
          case 'list': {
            const paths = await ops.list(
              typeof params.glob === 'string' ? params.glob : undefined,
              typeof params.max_entries === 'number' ? params.max_entries : DEFAULT_LIST_MAX_ENTRIES,
            );
            return textResult(JSON.stringify({
              action: 'list',
              glob: typeof params.glob === 'string' && params.glob.trim().length > 0 ? params.glob : '**/*',
              count: paths.length,
              paths,
            }, null, 2));
          }

          case 'read': {
            const path = requireString(params.path, 'path');
            const result = await ops.read(path, {
              maxBytes: typeof params.max_bytes === 'number' ? params.max_bytes : MAX_READ_CHARS,
            });
            return textResult(JSON.stringify({
              action: 'read',
              path,
              truncated: result.truncated,
              content: result.content,
            }, null, 2));
          }

          case 'search': {
            const result = await ops.search({
              query: requireString(params.query, 'query'),
              ...(typeof params.glob === 'string' ? { glob: params.glob } : {}),
              ...(params.mode === 'regex' ? { mode: 'regex' as const } : {}),
              ...(typeof params.max_matches === 'number' ? { maxMatches: params.max_matches } : {}),
              ...(typeof params.max_files === 'number' ? { maxFiles: params.max_files } : {}),
              ...(typeof params.max_bytes_per_file === 'number' ? { maxBytesPerFile: params.max_bytes_per_file } : {}),
              ...(typeof params.context_lines === 'number' ? { contextLines: params.context_lines } : {}),
            });
            return textResult(JSON.stringify({
              action: 'search',
              query: result.query,
              glob: result.glob,
              mode: result.mode,
              scanned_files: result.scannedFiles,
              match_count: result.matches.length,
              hit_limit: result.hitLimit,
              truncated_files: result.truncatedFiles,
              matches: result.matches,
            }, null, 2));
          }

          case 'write': {
            const result = await ops.write({
              path: requireString(params.path, 'path'),
              content: requireStringField(params.content, 'content'),
              overwrite: params.overwrite === true,
            });
            return textResult(JSON.stringify({
              action: 'write',
              path: result.path,
              status: result.status,
              bytes_written: result.bytesWritten,
            }, null, 2));
          }

          case 'edit': {
            const result = await ops.edit({
              path: requireString(params.path, 'path'),
              oldText: requireString(params.old_text, 'old_text'),
              newText: requireStringField(params.new_text, 'new_text'),
              replaceAll: params.replace_all === true,
            });
            return textResult(JSON.stringify({
              action: 'edit',
              path: result.path,
              replacements: result.replacements,
            }, null, 2));
          }
        }
      } catch (error) {
        return textResultWithError(`fs failed: ${toErrorMessage(error)}`, true);
      }
    },
  };
}
