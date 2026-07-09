import { Type } from '@sinclair/typebox';
import type { AgentToolResult } from '@mariozechner/pi-agent-core';
import type { SubstrateAgentTool } from '../../../shared/contracts/agent-tools.js';
import type { MemoryStorePort } from '../memory-store-port.js';
import { withCapabilityRequirement } from '../../../system/capabilities/requirements.js';
import { textResult, textResultWithError } from '../../../core/tools/results.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import { ResearchLibraryStore } from './store.js';

type ResearchLibraryAction = 'list' | 'read' | 'import_text' | 'import_file' | 'promote_scratchpad';

interface ResearchLibraryToolParams {
  action?: ResearchLibraryAction;
  id?: string;
  title?: string;
  content?: string;
  path?: string;
  sourceUrl?: string;
  note?: string;
  scratchpadId?: string;
}

function requireAction(value: string | undefined): ResearchLibraryAction {
  const action = value?.trim();
  switch (action) {
    case 'list':
    case 'read':
    case 'import_text':
    case 'import_file':
    case 'promote_scratchpad':
      return action;
    default:
      throw new Error('action is required. Supported actions: list, read, import_text, import_file, promote_scratchpad');
  }
}

function requireTrimmed(value: string | undefined, field: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${field} is required.`);
  }
  return normalized;
}

function describeList(store: ResearchLibraryStore): string {
  const entries = store.listEntries();
  if (entries.length === 0) {
    return 'Research library is empty.';
  }

  const lines = entries.map((entry, index) => {
    const provenance = entry.provenance.scratchpadEntryId
      ? `${entry.provenance.sourceKind}:${entry.provenance.scratchpadEntryId}`
      : entry.provenance.sourceKind;
    return `${index + 1}. ${entry.title} [${entry.id}] (${entry.kind}, ${provenance}, ${entry.importedAt})`;
  });
  return `Research library (${entries.length} entries)\n\n${lines.join('\n')}`;
}

function describeEntry(store: ResearchLibraryStore, id: string): string {
  const entry = store.getEntry(id);
  if (!entry) {
    throw new Error(`Library entry not found: ${id}`);
  }

  const previewBlock = entry.previewText ? `\n\n${entry.previewText}` : '';
  return [
    `${entry.manifest.title} [${entry.manifest.id}]`,
    `kind=${entry.manifest.kind}`,
    `source=${entry.manifest.provenance.sourceKind}`,
    `stored=${entry.manifest.asset.relativePath}`,
    `importedAt=${entry.manifest.importedAt}`,
    previewBlock,
  ].join('\n');
}

export function createResearchLibraryTool(
  store: ResearchLibraryStore,
  memoryStore: MemoryStorePort,
): SubstrateAgentTool {
  const tool: SubstrateAgentTool = {
    name: 'library',
    label: 'library',
    description:
      'Durable companion-owned research library for promoted notes, files, and generated artifacts. '
      + 'Use action=list|read|import_text|import_file|promote_scratchpad.',
    parameters: Type.Object({
      action: Type.Optional(Type.Union([
        Type.Literal('list'),
        Type.Literal('read'),
        Type.Literal('import_text'),
        Type.Literal('import_file'),
        Type.Literal('promote_scratchpad'),
      ])),
      id: Type.Optional(Type.String({ minLength: 1, description: 'Used with action=read. Library entry id.' })),
      title: Type.Optional(Type.String({ minLength: 1, description: 'Used with import_text, import_file, or promote_scratchpad.' })),
      content: Type.Optional(Type.String({ description: 'Used with action=import_text.' })),
      path: Type.Optional(Type.String({ minLength: 1, description: 'Used with action=import_file. Must point at a workspace file or generated media artifact.' })),
      sourceUrl: Type.Optional(Type.String({ minLength: 1, description: 'Optional source URL for action=import_text.' })),
      note: Type.Optional(Type.String({ description: 'Optional provenance note for imports/promotions.' })),
      scratchpadId: Type.Optional(Type.String({ minLength: 1, description: 'Used with action=promote_scratchpad. Scratchpad entry id.' })),
    }),
    execute: async (
      _toolCallId: string,
      params: ResearchLibraryToolParams = {},
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const action = requireAction(params.action);
        switch (action) {
          case 'list':
            return textResult(describeList(store));
          case 'read':
            return textResult(describeEntry(store, requireTrimmed(params.id, 'id')));
          case 'import_text': {
            const manifest = store.importText({
              title: requireTrimmed(params.title, 'title'),
              content: requireTrimmed(params.content, 'content'),
              provenance: {
                sourceKind: 'direct_text',
                ...(params.sourceUrl?.trim() ? { sourceUrl: params.sourceUrl.trim() } : {}),
                ...(params.note?.trim() ? { note: params.note.trim() } : {}),
                importedBy: 'tool:library|action:import_text',
              },
            });
            return textResult(`Library entry imported: ${manifest.title} [${manifest.id}] (${manifest.asset.relativePath})`);
          }
          case 'import_file': {
            const manifest = store.importFile({
              path: requireTrimmed(params.path, 'path'),
              title: params.title,
              provenance: {
                sourceKind: 'workspace_file',
                ...(params.note?.trim() ? { note: params.note.trim() } : {}),
                importedBy: 'tool:library|action:import_file',
              },
            });
            return textResult(`Artifact imported: ${manifest.title} [${manifest.id}] (${manifest.asset.relativePath})`);
          }
          case 'promote_scratchpad': {
            const scratchpadId = requireTrimmed(params.scratchpadId, 'scratchpadId');
            const entry = await memoryStore.getScratchpadEntry(scratchpadId);
            if (!entry) {
              throw new Error(`Scratchpad entry not found: ${scratchpadId}`);
            }
            const manifest = store.promoteScratchpadEntry({
              scratchpadEntryId: scratchpadId,
              content: entry.content,
              title: params.title,
              note: params.note,
              importedBy: 'tool:library|action:promote_scratchpad',
            });
            return textResult(`Scratchpad entry promoted: ${manifest.title} [${manifest.id}] (${manifest.asset.relativePath})`);
          }
        }
      } catch (error) {
        return textResultWithError(`library failed: ${toErrorMessage(error)}`, true);
      }
    },
  };

  return withCapabilityRequirement(tool, (params) => {
    const action = typeof params.action === 'string' ? params.action.trim() : '';
    switch (action) {
      case 'list':
      case 'read':
        return 'identity.read';
      case 'import_text':
      case 'import_file':
      case 'promote_scratchpad':
        return 'identity.write.runtime';
      default:
        return ['identity.read', 'identity.write.runtime'];
    }
  });
}
