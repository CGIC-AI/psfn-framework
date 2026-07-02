import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { textResult, textResultWithError } from '../../core/tools/results.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import {
  withCapabilityRequirement,
  type CapabilityRequirement,
} from '../../system/capabilities/requirements.js';
import { VALID_SENSITIVITY_LEVELS } from '../../system/trust/types.js';
import {
  WIKI_SOURCE_CLASSES,
  type WikiDocumentUpsertInput,
  type WikiSemanticSearchFn,
  type WikiSourceClass,
  type WikiStorePort,
} from './types.js';

const WIKI_ACTIONS = ['list', 'read', 'search', 'semantic_search', 'write', 'import'] as const;
type WikiAction = typeof WIKI_ACTIONS[number];

export interface WikiToolDeps {
  /**
   * Optional semantic (pgvector projection) search. When absent, the wiki tool
   * still offers plain text search; action=semantic_search then fails closed
   * with guidance rather than silently downgrading.
   */
  semanticSearch?: WikiSemanticSearchFn;
}

interface WikiToolParams {
  action?: WikiAction;
  id?: string;
  title?: string;
  body?: string;
  query?: string;
  limit?: number;
  tags?: string[] | string;
  source_class?: WikiSourceClass;
  provenance_refs?: string[] | string;
  sensitivity?: WikiDocumentUpsertInput['sensitivity'];
  summary?: string;
}

function normalizeAction(params: WikiToolParams): WikiAction {
  const rawAction = typeof params.action === 'string' ? params.action.trim() : '';
  if (!rawAction) {
    const hasQuery = typeof params.query === 'string' && params.query.trim().length > 0;
    const hasId = typeof params.id === 'string' && params.id.trim().length > 0;
    const hasWriteFields = typeof params.title === 'string' || typeof params.body === 'string';
    if (hasQuery) return 'search';
    if (hasId && !hasWriteFields) return 'read';
    if (!hasId && !hasWriteFields) return 'list';
    throw new Error(`action is required. Supported actions: ${WIKI_ACTIONS.join(', ')}`);
  }
  if ((WIKI_ACTIONS as readonly string[]).includes(rawAction)) {
    return rawAction as WikiAction;
  }
  throw new Error(`action must be one of: ${WIKI_ACTIONS.join(', ')}`);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
  return value;
}

function normalizeLimit(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(1, Math.floor(value));
}

function buildUpsertInput(params: WikiToolParams, importMode: boolean): WikiDocumentUpsertInput {
  const sourceClass = params.source_class ?? (importMode ? undefined : 'companion_authored_note');
  if (importMode && !sourceClass) {
    throw new Error('source_class is required for wiki import');
  }
  return {
    ...(typeof params.id === 'string' && params.id.trim() ? { id: params.id.trim() } : {}),
    title: requireString(params.title, 'title'),
    body: requireString(params.body, 'body'),
    ...(params.tags !== undefined ? { tags: params.tags } : {}),
    ...(sourceClass ? { sourceClass } : {}),
    ...(params.provenance_refs !== undefined ? { provenanceRefs: params.provenance_refs } : {}),
    ...(params.sensitivity ? { sensitivity: params.sensitivity } : {}),
    ...(typeof params.summary === 'string' && params.summary.trim() ? { summary: params.summary.trim() } : {}),
    updatedBy: importMode ? 'import' : 'agent',
  };
}

function resolveWikiCapabilityRequirement(params: Record<string, unknown>): CapabilityRequirement {
  const action = typeof params.action === 'string' ? params.action.trim() : '';
  switch (action) {
    case '':
    case 'list':
    case 'read':
    case 'search':
    case 'semantic_search':
      return 'identity.read';
    case 'write':
    case 'import':
      return 'identity.write.runtime';
    default:
      return ['identity.read', 'identity.write.runtime'];
  }
}

export function createWikiTool(store: WikiStorePort, deps: WikiToolDeps = {}): AgentTool<any> {
  const semanticSearch = deps.semanticSearch;
  const tool: AgentTool<any> = {
    name: 'wiki',
    label: 'wiki',
    description:
      'Internal runtime-owned knowledge-base for durable reference documents and personal knowledge notes. '
      + 'Use action=list|read|search|semantic_search|write|import. search is exact/substring text search; '
      + 'semantic_search finds conceptually related documents via the pgvector projection and returns similarity scores. '
      + 'This is separate from L0/L0.1/L2 memory, scratchpad, journal, and Obsidian/Vault. '
      + 'Imports require source_class and provenance_refs so external notes never masquerade as lived memory.',
    parameters: Type.Object({
      action: Type.Optional(Type.Union(
        WIKI_ACTIONS.map(action => Type.Literal(action)),
        { description: 'Wiki action. Defaults to list, read when id is provided, or search when query is provided.' },
      )),
      id: Type.Optional(Type.String({
        minLength: 1,
        description: 'Stable wiki document id for read/write. Defaults from title for new writes.',
      })),
      title: Type.Optional(Type.String({
        minLength: 1,
        description: 'Document title for write/import.',
      })),
      body: Type.Optional(Type.String({
        minLength: 1,
        description: 'Markdown body for write/import.',
      })),
      query: Type.Optional(Type.String({
        minLength: 1,
        description: 'Query text for action=search (substring/text) or action=semantic_search (vector similarity).',
      })),
      limit: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: 100,
        description: 'Maximum search matches to return.',
      })),
      tags: Type.Optional(Type.Union([
        Type.Array(Type.String({ minLength: 1 })),
        Type.String({ minLength: 1 }),
      ], {
        description: 'Tags for write/import. String values are comma-separated.',
      })),
      source_class: Type.Optional(Type.Union(
        WIKI_SOURCE_CLASSES.map(sourceClass => Type.Literal(sourceClass)),
        { description: 'Document source class. Required for imports.' },
      )),
      provenance_refs: Type.Optional(Type.Union([
        Type.Array(Type.String({ minLength: 1 })),
        Type.String({ minLength: 1 }),
      ], {
        description: 'Source/provenance references. Required for imported/source-derived documents.',
      })),
      sensitivity: Type.Optional(Type.Union(
        VALID_SENSITIVITY_LEVELS.map(level => Type.Literal(level)),
        { description: 'Privacy sensitivity for the document. Defaults to personal.' },
      )),
      summary: Type.Optional(Type.String({
        minLength: 1,
        description: 'Optional short summary used in list/search previews.',
      })),
    }),
    execute: async (
      _toolCallId: string,
      params: WikiToolParams = {},
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      let action: WikiAction = 'list';
      try {
        action = normalizeAction(params);
        switch (action) {
          case 'list':
            return textResult(JSON.stringify({
              action: 'list',
              roots: store.getRootInfo(),
              documents: store.list(),
              boundary: 'Wiki/reference knowledge is separate from L0/L0.1/L2 memory.',
            }, null, 2));
          case 'read': {
            const document = store.get(requireString(params.id, 'id'));
            if (!document) {
              return textResultWithError(`wiki document not found: ${params.id}`, true);
            }
            return textResult(JSON.stringify({
              action: 'read',
              document,
              boundary: 'This is authored/imported reference knowledge, not transcript memory.',
            }, null, 2));
          }
          case 'search':
            return textResult(JSON.stringify({
              action: 'search',
              ...store.search({
                query: requireString(params.query, 'query'),
                ...(normalizeLimit(params.limit) ? { limit: normalizeLimit(params.limit) } : {}),
              }),
              boundary: 'Search results are wiki/reference knowledge, not lived memory.',
            }, null, 2));
          case 'semantic_search': {
            const query = requireString(params.query, 'query');
            if (!semanticSearch) {
              return textResultWithError(
                'wiki semantic_search is unavailable (no pgvector projection wired); use action=search for text search.',
                true,
              );
            }
            const limit = normalizeLimit(params.limit) ?? 10;
            const result = await semanticSearch(query, limit);
            return textResult(JSON.stringify({
              action: 'semantic_search',
              ...result,
              boundary: 'Semantic matches are wiki/reference knowledge, not lived memory.',
            }, null, 2));
          }
          case 'write':
          case 'import': {
            const document = store.upsert(buildUpsertInput(params, action === 'import'));
            return textResult(JSON.stringify({
              action,
              document,
              boundary: 'Stored in the internal wiki/knowledge-base; no L2 memory was created.',
            }, null, 2));
          }
        }
      } catch (error) {
        return textResultWithError(`wiki failed for action=${action}: ${toErrorMessage(error)}`, true);
      }
    },
  };
  return withCapabilityRequirement(tool, resolveWikiCapabilityRequirement);
}
