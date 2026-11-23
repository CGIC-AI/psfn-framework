import { Type } from '@sinclair/typebox';
import { CANONICAL_TOOL_SURFACE_DESCRIPTIONS } from '../../../core/agent/tool-surface/descriptions.js';
import type { AgentToolResult, SubstrateAgentTool } from '../../pi-agent/index.js';
import type { FilesystemOperations } from './ops.js';
import { textResult, textResultWithError } from '../../../core/tools/results.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import {
  FILESYSTEM_READ_PAGE_CONTRACT,
  validateFilesystemReadMaxBytes,
} from '../../../shared/contracts/filesystem.js';
import { PARTIAL_TOOL_RESULT_DETAILS_KEY } from '../../../shared/contracts/tool-call-outcome.js';
import { isJournalPath, JOURNAL_PATH_REFUSAL } from '../journal/path-guard.js';

function partialTextResult(text: string): AgentToolResult<Record<string, boolean>> {
  return {
    content: [{ type: 'text', text }],
    details: { [PARTIAL_TOOL_RESULT_DETAILS_KEY]: true },
  };
}

function boundedTextResult(
  text: string,
  partial: boolean,
): AgentToolResult<Record<string, never> | Record<string, boolean>> {
  return partial ? partialTextResult(text) : textResult(text);
}

const LARGE_DOCUMENT_HANDOFF =
  'Continue paging this file with the returned next_offset_bytes, use shell for a targeted byte-range or ripgrep filter, '
  + 'or use analysis_workbench for multi-stage synthesis with provenance-bearing excerpts.';

type FileEditorAction = 'read' | 'write' | 'edit';

function normalizeAction(params: Record<string, unknown>): FileEditorAction {
  const action = typeof params.action === 'string' ? params.action.trim() : '';
  switch (action) {
    case 'read':
    case 'write':
    case 'edit':
      return action;
    default:
      throw new Error('action is required. Supported actions: read, write, edit.');
  }
}

function requireNonEmptyPath(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('path is required.');
  }
  return value;
}

function requireNonEmptyStringField(value: unknown, field: string): string {
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

function optionalSafeIntegerInRange(
  value: unknown,
  field: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return defaultValue;
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    throw new Error(
      `${field} must be a safe integer between ${String(minimum)} and ${String(maximum)}`,
    );
  }
  return value;
}

function refuseJournalPath(path: string): void {
  if (isJournalPath(path)) {
    throw new Error(JOURNAL_PATH_REFUSAL);
  }
}

export interface CreateFileEditorToolOptions {
  defaultMaxBytes?: number;
}

function resolveDefaultReadMaxBytes(value: number | undefined): number {
  return validateFilesystemReadMaxBytes(
    value ?? FILESYSTEM_READ_PAGE_CONTRACT.defaultMaxBytes,
  );
}

export function createFileEditorTool(
  ops: FilesystemOperations,
  options: CreateFileEditorToolOptions = {},
): SubstrateAgentTool {
  const defaultReadMaxBytes = resolveDefaultReadMaxBytes(options.defaultMaxBytes);
  return {
    name: 'file_editor',
    label: 'file_editor',
    description: CANONICAL_TOOL_SURFACE_DESCRIPTIONS.file_editor,
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal('read'),
        Type.Literal('write'),
        Type.Literal('edit'),
      ], {
        description: 'Required file editor action: read, write, or edit.',
      }),
      path: Type.String({
        description:
          'Personal-workspace-relative file path for read, write, or edit.',
      }),
      offset_bytes: Type.Optional(Type.Integer({
        minimum: 0,
        description:
          'Used with action=read. Byte cursor for paging; start at 0, then pass the returned next_offset_bytes.',
      })),
      max_bytes: Type.Optional(Type.Integer({
        minimum: FILESYSTEM_READ_PAGE_CONTRACT.minBytes,
        maximum: FILESYSTEM_READ_PAGE_CONTRACT.maxBytes,
        description:
          `Used with action=read. Read at most this many bytes; `
          + `${String(FILESYSTEM_READ_PAGE_CONTRACT.maxBytes)} is a hard cap `
          + `(default ${String(defaultReadMaxBytes)}).`,
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
        const path = requireNonEmptyPath(params.path);
        refuseJournalPath(path);

        switch (action) {
          case 'read': {
            const maxBytes = optionalSafeIntegerInRange(
              params.max_bytes,
              'max_bytes',
              defaultReadMaxBytes,
              FILESYSTEM_READ_PAGE_CONTRACT.minBytes,
              FILESYSTEM_READ_PAGE_CONTRACT.maxBytes,
            );
            const offsetBytes = optionalSafeIntegerInRange(
              params.offset_bytes,
              'offset_bytes',
              0,
              0,
              Number.MAX_SAFE_INTEGER,
            );
            const result = await ops.read(path, {
              maxBytes,
              offsetBytes,
            });
            return boundedTextResult(JSON.stringify({
              action: 'read',
              path,
              offset_bytes: result.offsetBytes,
              next_offset_bytes: result.nextOffsetBytes,
              eof: result.eof,
              truncated: result.truncated,
              ...(result.truncated ? { next_action: LARGE_DOCUMENT_HANDOFF } : {}),
              content: result.content,
            }, null, 2), result.truncated);
          }

          case 'write': {
            const result = await ops.write({
              path,
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
              path,
              oldText: requireNonEmptyStringField(params.old_text, 'old_text'),
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
        return textResultWithError(`file_editor failed: ${toErrorMessage(error)}`, true, {
          cause: error,
        });
      }
    },
  };
}
