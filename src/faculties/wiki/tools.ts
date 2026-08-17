import { Type } from '@sinclair/typebox';
import { CANONICAL_TOOL_SURFACE_DESCRIPTIONS } from '../../core/agent/tool-surface/descriptions.js';
import type { AgentToolResult } from '../../boundary/pi-agent/index.js';
import type { SubstrateAgentTool } from '../../boundary/pi-agent/index.js';
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
import {
  type CompanionOwnedVisibility,
  type PersonalProjectStatus,
  PersonalProjectLibrary,
  isReservedManagedWikiWrite,
} from './personal-projects.js';
import { normalizeWikiDocumentId } from './store.js';
import {
  MAX_WISH_CONTEXT_CHARS,
  MAX_WISH_TEXT_CHARS,
  PersonalWishlist,
} from './personal-wishlist.js';
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
  | 'wish_list'
  | 'wish_read'
  | 'wish_create'
  | 'project_list'
  | 'project_read'
  | 'project_create'
  | 'project_update'
  | 'project_add_artifact'
  | 'project_share'
  | 'wardrobe_list'
  | 'wardrobe_read'
  | 'wardrobe_save'
  | 'wardrobe_revise';

const WIKI_ACTIONS = [
  'list',
  'read',
  'search',
  'semantic_search',
  'write',
  'import',
  'propose_shared_world',
  'wish_list',
  'wish_read',
  'wish_create',
  'project_list',
  'project_read',
  'project_create',
  'project_update',
  'project_add_artifact',
  'project_share',
  'wardrobe_list',
  'wardrobe_read',
  'wardrobe_save',
  'wardrobe_revise',
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
  /** Existing personal-wiki storage interpreted as project and wardrobe manifests. */
  personalProjects?: PersonalProjectLibrary;
  /** Existing personal-wiki storage interpreted as companion-authored wishes. */
  personalWishlist?: PersonalWishlist;
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
  wish_ref?: string;
  wish_text?: string;
  wish_context?: string;
  project_id?: string;
  project_ref?: string;
  project_status?: PersonalProjectStatus;
  visibility?: CompanionOwnedVisibility;
  next_step?: string;
  artifact_ref?: string;
  artifact_label?: string;
  audience?: CompanionOwnedVisibility;
  look_id?: string;
  look_ref?: string;
  look_name?: string;
  look_prompt?: string;
  supersedes_ref?: string;
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
    case 'wish_list':
    case 'wish_read':
    case 'project_list':
    case 'project_read':
    case 'wardrobe_list':
    case 'wardrobe_read':
      return 'identity.read';
    case 'write':
    case 'import':
    case 'propose_shared_world':
    case 'wish_create':
    case 'project_create':
    case 'project_update':
    case 'project_add_artifact':
    case 'project_share':
    case 'wardrobe_save':
    case 'wardrobe_revise':
      return 'identity.write.runtime';
    default:
      return ['identity.read', 'identity.write.runtime'];
  }
}

function requirePersonalProjects(deps: WikiToolDeps): PersonalProjectLibrary {
  if (!deps.personalProjects) {
    throw new Error('personal project storage is unavailable');
  }
  return deps.personalProjects;
}

function requirePersonalWishlist(deps: WikiToolDeps): PersonalWishlist {
  if (!deps.personalWishlist) {
    throw new Error('personal wishlist storage is unavailable');
  }
  return deps.personalWishlist;
}

function isReservedManagedWikiParams(params: WikiToolParams): boolean {
  let resolvedDocId = '';
  try {
    resolvedDocId = normalizeWikiDocumentId(params.id, params.title);
  } catch {
    // An unresolvable id cannot address the reserved namespace by id; fall
    // back to the raw id for the tag/prefix check. Callers must run this check
    // again after screening because sanitization can make an id resolvable.
    resolvedDocId = typeof params.id === 'string' ? params.id : '';
  }
  return isReservedManagedWikiWrite({ documentId: resolvedDocId, tags: params.tags });
}

export function createWikiTool(store: WikiStorePort, deps: WikiToolDeps): SubstrateAgentTool {
  const semanticSearch = deps.semanticSearch;
  const tool: SubstrateAgentTool = {
    name: 'wiki',
    label: 'wiki',
    description: CANONICAL_TOOL_SURFACE_DESCRIPTIONS.wiki,
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
        { description: 'Privacy sensitivity for a write/import document. Defaults to personal. Not accepted for project_add_artifact, whose sensitivity is runtime-derived.' },
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
      wish_ref: Type.Optional(Type.String({
        minLength: 1,
        description: 'Stable wish:<uuid> reference for wish_read.',
      })),
      wish_text: Type.Optional(Type.String({
        minLength: 1,
        maxLength: MAX_WISH_TEXT_CHARS,
        description: 'What the companion wants for wish_create, in her own words.',
      })),
      wish_context: Type.Optional(Type.String({
        minLength: 1,
        maxLength: MAX_WISH_CONTEXT_CHARS,
        description: 'Optional context about why, when, or how the wish matters.',
      })),
      project_id: Type.Optional(Type.String({ minLength: 1, description: 'Stable id for project_create.' })),
      project_ref: Type.Optional(Type.String({ minLength: 1, description: 'Stable project:<id> reference.' })),
      project_status: Type.Optional(Type.Union([
        Type.Literal('active'), Type.Literal('paused'), Type.Literal('completed'), Type.Literal('archived'),
      ])),
      visibility: Type.Optional(Type.Union([
        Type.Literal('self'), Type.Literal('primary_contact'), Type.Literal('public'),
      ], { description: 'Companion-owned read/share visibility.' })),
      next_step: Type.Optional(Type.String({ minLength: 1, description: 'The companion\'s own next-step intention.' })),
      artifact_ref: Type.Optional(Type.String({ minLength: 1, description: 'Durable generated/file/wiki artifact reference.' })),
      artifact_label: Type.Optional(Type.String({ minLength: 1 })),
      audience: Type.Optional(Type.Union([
        Type.Literal('self'), Type.Literal('primary_contact'), Type.Literal('public'),
      ], { description: 'Requested share audience for project_share; actual release remains subject to the artifact egress gate. Not accepted for project_add_artifact, whose audience is runtime-derived (fails closed to self).' })),
      look_id: Type.Optional(Type.String({ minLength: 1, description: 'Stable id for wardrobe_save.' })),
      look_ref: Type.Optional(Type.String({ minLength: 1, description: 'Stable wardrobe:<id> reference.' })),
      look_name: Type.Optional(Type.String({ minLength: 1 })),
      look_prompt: Type.Optional(Type.String({ minLength: 1, description: 'Reusable outfit prompt fragment.' })),
      supersedes_ref: Type.Optional(Type.String({ minLength: 1, description: 'Prior wardrobe:<id> ref replaced by this look.' })),
    }),
    execute: async (
      toolCallId: string,
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
            // Bible §6.2/§9.5 (psfn-framework-jp36.1.2.3): the generic wiki
            // write/import action is fully model-controlled (id, tags, and body).
            // It must never create or mutate a runtime-managed personal-project
            // or named-look manifest — otherwise the model could author a
            // `project.<id>` document whose artifacts assert
            // `metadataLineage: runtime_derived` (plus model-chosen
            // sensitivity/intendedAudience/shareState) and forge egress
            // eligibility, defeating the runtime-metadata-authority derivation and
            // the legacy egress quarantine. Reject fail-closed; these manifests
            // are only ever written through the dedicated project_*/wardrobe_*
            // actions, which derive disclosure metadata from runtime state.
            if (isReservedManagedWikiParams(params)) {
              return textResultWithError(
                'wiki '
                + action
                + ' cannot create or modify personal-project or named-look manifests '
                + '(reserved id/tag namespace). Their sensitivity, audience, share state, and '
                + 'metadata lineage are runtime-derived and fail closed (bible §6.2, §9.5). Use the '
                + 'dedicated project_* actions (project_create, project_update, project_add_artifact, '
                + 'project_share) or wardrobe_* actions instead.',
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
              // Soft, truthful, operator-reviewed wording (htm9.12); not an
              // error so the model does not spiral into retries.
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
          case 'wish_list': {
            const wishes = requirePersonalWishlist(deps).listWishes();
            return textResult(JSON.stringify({
              action,
              wishes,
              boundary: 'Wishes are companion-authored personal wiki records. Saving one is asynchronous and does not notify or interrupt the operator.',
            }, null, 2));
          }
          case 'wish_read': {
            const wish = requirePersonalWishlist(deps).getWish(requireString(params.wish_ref, 'wish_ref'));
            return textResult(JSON.stringify({ action, wish }, null, 2));
          }
          case 'wish_create': {
            const wish = requirePersonalWishlist(deps).createWish({
              text: requireString(params.wish_text, 'wish_text'),
              ...(params.wish_context !== undefined ? { context: params.wish_context } : {}),
            });
            return textResult(JSON.stringify({
              action,
              wish,
              boundary: 'Saved for asynchronous operator review. No push notification or operator interruption was emitted.',
            }, null, 2));
          }
          case 'project_list': {
            const projects = requirePersonalProjects(deps).listProjects();
            return textResult(JSON.stringify({
              action,
              projects,
              boundary: 'Projects live in the existing personal wiki; this does not create a new persistence backend.',
            }, null, 2));
          }
          case 'project_read': {
            const project = requirePersonalProjects(deps).getProject(requireString(params.project_ref, 'project_ref'));
            return textResult(JSON.stringify({ action, project }, null, 2));
          }
          case 'project_create': {
            const project = await requirePersonalProjects(deps).createProject({
              ...(params.project_id ? { id: params.project_id } : {}),
              title: requireString(params.title, 'title'),
              nextStep: requireString(params.next_step, 'next_step'),
              ...(params.visibility ? { visibility: params.visibility } : {}),
            });
            return textResult(JSON.stringify({ action, project }, null, 2));
          }
          case 'project_update': {
            const project = await requirePersonalProjects(deps).updateProject({
              ref: requireString(params.project_ref, 'project_ref'),
              ...(params.next_step ? { nextStep: params.next_step } : {}),
              ...(params.project_status ? { status: params.project_status } : {}),
              ...(params.visibility ? { visibility: params.visibility } : {}),
            });
            return textResult(JSON.stringify({ action, project }, null, 2));
          }
          case 'project_add_artifact': {
            // Bible §6.2: sensitivity and permitted audience are runtime-derived
            // metadata, never model self-asserted. Reject the old model-supplied
            // arguments fail-closed instead of silently ignoring them; the write
            // path derives lineage from the project's runtime state.
            if (params.sensitivity !== undefined) {
              throw new Error(
                'sensitivity is runtime-derived for project_add_artifact and must not be supplied',
              );
            }
            if (params.audience !== undefined) {
              throw new Error(
                'audience is runtime-derived for project_add_artifact and must not be supplied',
              );
            }
            const project = await requirePersonalProjects(deps).addArtifact({
              projectRef: requireString(params.project_ref, 'project_ref'),
              artifactRef: requireString(params.artifact_ref, 'artifact_ref'),
              label: requireString(params.artifact_label, 'artifact_label'),
            });
            return textResult(JSON.stringify({ action, project }, null, 2));
          }
          case 'project_share': {
            const project = await requirePersonalProjects(deps).requestArtifactShare({
              projectRef: requireString(params.project_ref, 'project_ref'),
              artifactRef: requireString(params.artifact_ref, 'artifact_ref'),
              audience: params.audience ?? 'self',
            });
            return textResult(JSON.stringify({
              action,
              project,
              boundary: 'This records sharing intent only. Attaching or publishing the artifact still passes through sensitivity inheritance and HITL egress policy.',
            }, null, 2));
          }
          case 'wardrobe_list': {
            const looks = requirePersonalProjects(deps).listWardrobeLooks();
            return textResult(JSON.stringify({ action, looks }, null, 2));
          }
          case 'wardrobe_read': {
            const look = requirePersonalProjects(deps).getWardrobeLook(requireString(params.look_ref, 'look_ref'));
            return textResult(JSON.stringify({ action, look }, null, 2));
          }
          case 'wardrobe_save': {
            const look = requirePersonalProjects(deps).saveNamedLook({
              ...(params.look_id ? { id: params.look_id } : {}),
              name: requireString(params.look_name, 'look_name'),
              promptFragment: requireString(params.look_prompt, 'look_prompt'),
              ...(params.visibility ? { visibility: params.visibility } : {}),
              ...(params.supersedes_ref ? { supersedesRef: params.supersedes_ref } : {}),
            });
            return textResult(JSON.stringify({ action, look }, null, 2));
          }
          case 'wardrobe_revise': {
            const look = requirePersonalProjects(deps).reviseNamedLook({
              ref: requireString(params.look_ref, 'look_ref'),
              promptFragment: requireString(params.look_prompt, 'look_prompt'),
              ...(params.visibility ? { visibility: params.visibility } : {}),
            });
            return textResult(JSON.stringify({ action, look }, null, 2));
          }
        }
      } catch (error) {
        return textResultWithError(`wiki failed for action=${action}: ${toErrorMessage(error)}`, true);
      }
    },
  };
  return withCapabilityRequirement(tool, resolveWikiCapabilityRequirement);
}
