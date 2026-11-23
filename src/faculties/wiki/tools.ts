import { Type } from '@sinclair/typebox';
import { CANONICAL_TOOL_SURFACE_DESCRIPTIONS } from '../../core/agent/tool-surface/descriptions.js';
import type { AgentToolResult, SubstrateAgentTool } from '../../boundary/pi-agent/index.js';
import { textResult, textResultWithError } from '../../core/tools/results.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import {
  withCapabilityRequirement,
  type CapabilityRequirement,
} from '../../system/capabilities/requirements.js';
import { VALID_SENSITIVITY_LEVELS } from '../../system/trust/types.js';
import { INTAKE_FIREWALL_NOTICE_TEMPLATES } from '../../core/cogsec/intake-firewall-notice-templates.js';
import {
  screenSelfAuthoredMutation,
  type SelfAuthoredMutationIntakeRuntime,
} from '../../core/session/intake-sink-gating.js';
import type { SharedWorldWikiProposalSubmissionPort } from './shared-world-caretaker.js';
import { isReservedManagedWikiWrite } from './personal-projects.js';
import { normalizeWikiDocumentId } from './store.js';
import type { WikiAdmissionGate, WikiDocumentAdmission } from './admission.js';
import type { WorldNotesLibrary } from './world-notes.js';
import {
  WIKI_SOURCE_CLASSES,
  type WikiDocumentUpsertInput,
  type WikiSemanticSearchFn,
  type WikiSourceClass,
  type WikiStorePort,
} from './types.js';

type WikiAction =
  | 'list'
  | 'read'
  | 'search'
  | 'semantic_search'
  | 'write'
  | 'import'
  | 'propose_shared_world'
  | 'world_notes_read'
  | 'world_note';

const WIKI_ACTIONS = [
  'list',
  'read',
  'search',
  'semantic_search',
  'write',
  'import',
  'propose_shared_world',
  'world_notes_read',
  'world_note',
] satisfies readonly WikiAction[];

export interface WikiToolDeps {
  /**
   * Optional semantic (pgvector projection) search. When absent, the wiki tool
   * still offers plain text search; action=semantic_search then fails closed
   * with guidance rather than silently downgrading.
   */
  semanticSearch?: WikiSemanticSearchFn;
  /** Screen-then-gate runtime for companion-authored wiki writes. */
  intake: SelfAuthoredMutationIntakeRuntime;
  /**
   * Multi-companion-only enqueue surface. It exposes no SharedWorldWikiStore,
   * so a companion can propose a public world fact but cannot publish it.
   */
  sharedWorldProposal?: {
    actorId: string;
    submitter: SharedWorldWikiProposalSubmissionPort;
  };
  /** Per-world notes (2nsfo): the companion's own map of each shared world. */
  worldNotes?: WorldNotesLibrary;
  /**
   * Content-addressed CogSec admission for wiki documents
   * (psfn-framework-1fjvm.2). Wired, no document body, summary, or preview
   * leaves this tool until its exact canonical bytes are admitted. Absent, the
   * tool behaves exactly as before.
   */
  admissionGate?: WikiAdmissionGate;
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
  site_id?: string;
  source_ref?: string;
  world?: string;
  note_text?: string;
  note_about?: string;
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
  if (isWikiAction(rawAction)) return rawAction;
  throw new Error(`action must be one of: ${WIKI_ACTIONS.join(', ')}`);
}

function isWikiAction(value: string): value is WikiAction {
  return WIKI_ACTIONS.some(action => action === value);
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
    case 'world_notes_read':
      return 'identity.read';
    case 'write':
    case 'import':
    case 'propose_shared_world':
    case 'world_note':
      return 'identity.write.runtime';
    default:
      return ['identity.read', 'identity.write.runtime'];
  }
}

function requireWorldNotes(deps: WikiToolDeps): WorldNotesLibrary {
  if (!deps.worldNotes) {
    throw new Error('per-world notes are unavailable in this runtime');
  }
  return deps.worldNotes;
}

function isReservedManagedWikiParams(params: WikiToolParams): boolean {
  let resolvedDocId = '';
  try {
    resolvedDocId = normalizeWikiDocumentId(params.id, params.title);
  } catch {
    resolvedDocId = typeof params.id === 'string' ? params.id : '';
  }
  return isReservedManagedWikiWrite({ documentId: resolvedDocId, tags: params.tags });
}

function withheldWikiDocument(
  id: string,
  title: string,
  admission: Pick<WikiDocumentAdmission, 'state' | 'detail'>,
): Record<string, unknown> {
  return {
    id,
    title,
    withheld: true,
    admission: { state: admission.state, reason: admission.detail },
    notice: INTAKE_FIREWALL_NOTICE_TEMPLATES.withheldContent,
  };
}

export function createWikiTool(store: WikiStorePort, deps: WikiToolDeps): SubstrateAgentTool {
  const semanticSearch = deps.semanticSearch;
  const admissionGate = deps.admissionGate;
  const tool: SubstrateAgentTool = {
    name: 'wiki',
    label: 'wiki',
    description: CANONICAL_TOOL_SURFACE_DESCRIPTIONS.wiki,
    parameters: Type.Object({
      action: Type.Union(
        WIKI_ACTIONS.map(action => Type.Literal(action)),
        { description: 'Required wiki knowledge action.' },
      ),
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
        { description: 'Privacy sensitivity for a write/import document. Defaults to personal.' },
      )),
      summary: Type.Optional(Type.String({
        minLength: 1,
        description: 'Optional short summary used in list/search previews.',
      })),
      site_id: Type.Optional(Type.String({
        minLength: 1,
        description: 'Known shared-world site id for action=propose_shared_world.',
      })),
      source_ref: Type.Optional(Type.String({
        minLength: 1,
        description: 'Non-memory source event/reference for action=propose_shared_world.',
      })),
      world: Type.Optional(Type.String({
        minLength: 1, maxLength: 64,
        description: 'World name for world_notes_read / world_note (e.g. "commons").',
      })),
      note_text: Type.Optional(Type.String({
        minLength: 1, maxLength: 280,
        description: 'world_note: what you want to remember about this world.',
      })),
      note_about: Type.Optional(Type.String({
        minLength: 1, maxLength: 64,
        description: 'world_note: optional landmark id or participant id the note is about.',
      })),
    }),
    execute: async (
      toolCallId: string,
      params: WikiToolParams = {},
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      let action: WikiAction = 'list';
      try {
        action = normalizeAction(params);
        switch (action) {
          case 'list': {
            const entries = store.list();
            const documents = admissionGate
              ? entries.map((entry) => {
                const document = store.get(entry.id);
                const admission = document
                  ? admissionGate.status(document)
                  : { state: 'unknown' as const, detail: 'document is unreadable' };
                return admission.state === 'admitted'
                  ? entry
                  : withheldWikiDocument(entry.id, entry.title, admission);
              })
              : entries;
            return textResult(JSON.stringify({
              action: 'list',
              roots: store.getRootInfo(),
              documents,
              boundary: 'Wiki/reference knowledge is separate from L0/L0.1/L2 memory.',
            }, null, 2));
          }
          case 'read': {
            const document = store.get(requireString(params.id, 'id'));
            if (!document) {
              return textResultWithError(`wiki document not found: ${params.id}`, true);
            }
            const admission = admissionGate ? await admissionGate.admit(document) : null;
            if (admission && admission.state !== 'admitted') {
              return textResult(JSON.stringify({
                action: 'read',
                document: withheldWikiDocument(document.id, document.title, admission),
                boundary: 'This is authored/imported reference knowledge, not transcript memory.',
              }, null, 2));
            }
            return textResult(JSON.stringify({
              action: 'read',
              document,
              boundary: 'This is authored/imported reference knowledge, not transcript memory.',
            }, null, 2));
          }
          case 'search': {
            const found = store.search({
              query: requireString(params.query, 'query'),
              ...(normalizeLimit(params.limit) ? { limit: normalizeLimit(params.limit) } : {}),
            });
            const matches = admissionGate
              ? found.matches.filter((match) => {
                const document = store.get(match.id);
                return document !== null && admissionGate.status(document).state === 'admitted';
              })
              : found.matches;
            return textResult(JSON.stringify({
              action: 'search',
              ...found,
              count: matches.length,
              matches,
              boundary: 'Search results are wiki/reference knowledge, not lived memory.',
            }, null, 2));
          }
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
            if (isReservedManagedWikiParams(params)) {
              return textResultWithError(
                'wiki '
                + action
                + ' cannot create or modify personal-project or named-look manifests '
                + '(reserved id/tag namespace). Their sensitivity, audience, share state, and '
                + 'metadata lineage are runtime-derived and fail closed (bible §6.2, §9.5). Use the '
                + 'dedicated projects tool instead.',
                true,
              );
            }
            const screened = await screenSelfAuthoredMutation(
              'wiki_write',
              params as unknown as Record<string, unknown>,
              deps.intake,
              { tool: 'wiki', action, attemptRef: toolCallId },
            );
            if (!screened.allowed) {
              return textResult(INTAKE_FIREWALL_NOTICE_TEMPLATES.sinkHeld);
            }
            params = screened.params as WikiToolParams;
            if (isReservedManagedWikiParams(params)) {
              return textResultWithError(
                'wiki '
                + action
                + ' cannot create or modify personal-project or named-look manifests '
                + 'after intake screening normalized the proposed id/tags into a reserved namespace. '
                + 'Their disclosure metadata is runtime-derived and fails closed.',
                true,
              );
            }
            const document = store.upsert(buildUpsertInput(params, action === 'import'));
            return textResult(JSON.stringify({
              action,
              document,
              boundary: 'Stored in the internal wiki/knowledge-base; no L2 memory was created.',
            }, null, 2));
          }
          case 'propose_shared_world': {
            const proposalSurface = deps.sharedWorldProposal;
            if (!proposalSurface) {
              return textResultWithError(
                'wiki propose_shared_world is unavailable outside the configured multi-companion caretaker flow.',
                true,
              );
            }
            const provenanceRefs = typeof params.provenance_refs === 'string'
              ? params.provenance_refs.split(',')
              : (params.provenance_refs ?? []);
            const tags = typeof params.tags === 'string' ? params.tags.split(',') : params.tags;
            const result = await proposalSurface.submitter.submit({
              siteId: requireString(params.site_id, 'site_id'),
              ...(typeof params.id === 'string' && params.id.trim() ? { documentId: params.id.trim() } : {}),
              actorId: proposalSurface.actorId,
              sourceRef: requireString(params.source_ref, 'source_ref'),
              title: requireString(params.title, 'title'),
              body: requireString(params.body, 'body'),
              ...(tags ? { tags } : {}),
              provenanceRefs,
              sensitivity: params.sensitivity ?? 'public',
            });
            return textResult(JSON.stringify({
              action,
              proposal: result.proposal,
              deduplicated: result.deduplicated,
              boundary: 'Queued for operator review; no shared-world document was written.',
            }, null, 2));
          }
          case 'world_notes_read': {
            const library = requireWorldNotes(deps);
            const world = typeof params.world === 'string' ? params.world.trim() : '';
            if (!world) {
              return textResult(JSON.stringify({ action, worlds: library.listWorlds() }, null, 2));
            }
            const notes = library.get(world);
            return textResult(JSON.stringify({
              action,
              world,
              notes: notes ?? null,
              ...(notes ? {} : { note: 'nothing remembered about this world yet; perceive and move there to build the map' }),
            }, null, 2));
          }
          case 'world_note': {
            const note = requireWorldNotes(deps).addNote({
              world: requireString(params.world, 'world'),
              text: requireString(params.note_text, 'note_text'),
              ...(params.note_about ? { about: params.note_about } : {}),
            });
            return textResult(JSON.stringify({ action, note }, null, 2));
          }
        }
      } catch (error) {
        return textResultWithError(`wiki failed for action=${action}: ${toErrorMessage(error)}`, true);
      }
    },
  };
  return withCapabilityRequirement(tool, resolveWikiCapabilityRequirement);
}
