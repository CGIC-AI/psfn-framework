import { Type } from '@sinclair/typebox';
import { CANONICAL_TOOL_SURFACE_DESCRIPTIONS } from '../../../core/agent/tool-surface/descriptions.js';
import type { AgentToolResult } from '../../pi-agent/index.js';
import type { SubstrateAgentTool } from '../../pi-agent/index.js';
import type { JournalOperations } from './ops.js';
import { textResult, textResultWithError } from '../../../core/tools/results.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import { requireNonEmptyString } from '../../../shared/utils/strings.js';
import { canViewerReadJournalNote, resolveWriterJournalProvenance } from './provenance.js';

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

function resolveNotePath(params: JournalToolParams): string {
  if (typeof params.path === 'string' && params.path.trim().length > 0) {
    return params.path.trim();
  }
  const title = requireNonEmptyString(params.title, 'path or title');
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
            const visible = await visibleNotePaths(ops, result.notes);
            const withheld = withheldNotice(result.notes.length - visible.length);
            if (visible.length === 0) {
              return textResult(`Journal is empty.${withheld}`);
            }
            return textResult(
              `Journal notes (${String(visible.length)} of ${String(result.totalFiles)}):\n`
              + `List truncated: ${String(result.truncated)}\n`
              + visible.map(note => `- ${note}`).join('\n')
              + withheld,
            );
          }
          case 'read': {
            const path = resolveNotePath(params);
            const provenance = await ops.readProvenance(path);
            // A note this conversation may not read is reported like a
            // missing one, never confirmed (psfn-framework-75oi4).
            if (!provenance || !canViewerReadJournalNote(provenance)) {
              return textResultWithError(`journal failed for action=read: Journal note not readable from this conversation: ${path}`, true);
            }
            const result = await ops.read(path, {
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
          case 'write':
          case 'append': {
            const path = resolveNotePath(params);
            const content = requireNonEmptyString(params.content, 'content');
            const existing = await ops.readProvenance(path);
            if (existing && !canViewerReadJournalNote(existing)) {
              return textResultWithError(`journal failed for action=${action}: Journal note not readable from this conversation: ${path}`, true);
            }
            const provenance = resolveWriterJournalProvenance();
            if (action === 'write') {
              const result = await ops.write(path, content, provenance);
              return textResult(`Journal note ${result.created ? 'created' : 'replaced'}: ${result.path}`);
            }
            const result = await ops.append(path, content, provenance);
            return textResult(`Journal note ${result.created ? 'created' : 'appended'}: ${result.path}`);
          }
          case 'search': {
            const result = await ops.search(requireNonEmptyString(params.query, 'query'), params.limit);
            const visiblePaths = new Set(await visibleNotePaths(ops, result.results.map(entry => entry.path)));
            const visibleResults = result.results.filter(entry => visiblePaths.has(entry.path));
            const withheld = withheldNotice(result.results.length - visibleResults.length);
            if (visibleResults.length === 0) {
              return textResult(
                `No journal results for: ${result.query}\n`
                + formatSearchMetadata(result)
                + withheld,
              );
            }
            const lines = visibleResults.map((entry, index) => `${index + 1}. ${entry.path}\n   ${entry.snippet}`);
            return textResult(
              `Journal search: "${result.query}" (${String(visibleResults.length)} results)\n`
              + `${formatSearchMetadata(result)}\n\n`
              + lines.join('\n')
              + withheld,
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

/** Notes the current conversation may read (psfn-framework-75oi4). */
async function visibleNotePaths(ops: JournalOperations, paths: readonly string[]): Promise<string[]> {
  const visible: string[] = [];
  for (const path of paths) {
    const provenance = await ops.readProvenance(path);
    if (provenance && canViewerReadJournalNote(provenance)) visible.push(path);
  }
  return visible;
}

function withheldNotice(count: number): string {
  if (count <= 0) return '';
  return `\n${String(count)} journal note${count === 1 ? '' : 's'} withheld by visibility gating `
    + '(written from other conversations or private reflection); they exist but are not readable from this conversation.';
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
