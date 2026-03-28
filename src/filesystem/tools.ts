import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { FilesystemReadOperations } from './ops.js';
import { textResult, textResultWithError } from '../tools/results.js';
import { toErrorMessage } from '../shared/utils/errors.js';

const DEFAULT_LIST_MAX_ENTRIES = 200;
const MAX_LIST_MAX_ENTRIES = 500;
const MAX_READ_CHARS = 20_000;

export function createFsReadTool(ops: FilesystemReadOperations): AgentTool<any> {
  return {
    name: 'fs_read',
    label: 'fs_read',
    description:
      'Read a UTF-8 text file from the workspace. Use this for direct file inspection before think; not for broad recursive discovery.',
    parameters: Type.Object({
      path: Type.String({ description: 'Workspace-relative path to read.' }),
    }),
    execute: async (
      _toolCallId: string,
      params: { path: string },
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const content = await ops.read(params.path);
        const output = content.length > MAX_READ_CHARS
          ? `${content.slice(0, MAX_READ_CHARS)}\n... (truncated)`
          : content;
        return textResult(output);
      } catch (error) {
        return textResultWithError(`fs_read failed: ${toErrorMessage(error)}`, true);
      }
    },
  };
}

export function createFsListTool(ops: FilesystemReadOperations): AgentTool<any> {
  return {
    name: 'fs_list',
    label: 'fs_list',
    description:
      'List workspace files with a bounded glob. Prefer this for simple file discovery instead of think.',
    parameters: Type.Object({
      glob: Type.Optional(Type.String({
        description: 'Workspace-relative glob pattern. Defaults to **/*.',
      })),
      max_entries: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: MAX_LIST_MAX_ENTRIES,
        description: `Max entries to return (default ${String(DEFAULT_LIST_MAX_ENTRIES)}).`,
      })),
    }),
    execute: async (
      _toolCallId: string,
      params: { glob?: string; max_entries?: number },
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const paths = await ops.list(params.glob, params.max_entries ?? DEFAULT_LIST_MAX_ENTRIES);
        return textResult(JSON.stringify({
          action: 'list',
          glob: params.glob ?? '**/*',
          count: paths.length,
          paths,
        }, null, 2));
      } catch (error) {
        return textResultWithError(`fs_list failed: ${toErrorMessage(error)}`, true);
      }
    },
  };
}
