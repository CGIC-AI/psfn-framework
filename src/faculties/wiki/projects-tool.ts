import { Type } from '@sinclair/typebox';
import { CANONICAL_TOOL_SURFACE_DESCRIPTIONS } from '../../core/agent/tool-surface/descriptions.js';
import type { AgentToolResult, SubstrateAgentTool } from '../../boundary/pi-agent/index.js';
import { textResult, textResultWithError } from '../../core/tools/results.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import {
  withCapabilityRequirement,
  type CapabilityRequirement,
} from '../../system/capabilities/requirements.js';
import {
  type CompanionOwnedVisibility,
  type PersonalProjectStatus,
  PersonalProjectLibrary,
} from './personal-projects.js';
import {
  MAX_WISH_CONTEXT_CHARS,
  MAX_WISH_TEXT_CHARS,
  PersonalWishlist,
} from './personal-wishlist.js';

type ProjectsAction =
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

const PROJECTS_ACTIONS = [
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
] satisfies readonly ProjectsAction[];

export interface ProjectsToolDeps {
  personalProjects?: PersonalProjectLibrary;
  personalWishlist?: PersonalWishlist;
}

interface ProjectsToolParams {
  action?: ProjectsAction;
  title?: string;
  sensitivity?: string;
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

function isProjectsAction(value: string): value is ProjectsAction {
  return PROJECTS_ACTIONS.some(action => action === value);
}

function normalizeAction(params: ProjectsToolParams): ProjectsAction {
  const rawAction = typeof params.action === 'string' ? params.action.trim() : '';
  if (isProjectsAction(rawAction)) return rawAction;
  throw new Error(`action is required and must be one of: ${PROJECTS_ACTIONS.join(', ')}`);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
  return value;
}

function requirePersonalProjects(deps: ProjectsToolDeps): PersonalProjectLibrary {
  if (!deps.personalProjects) {
    throw new Error('personal project storage is unavailable');
  }
  return deps.personalProjects;
}

function requirePersonalWishlist(deps: ProjectsToolDeps): PersonalWishlist {
  if (!deps.personalWishlist) {
    throw new Error('personal wishlist storage is unavailable');
  }
  return deps.personalWishlist;
}

function resolveProjectsCapabilityRequirement(params: Record<string, unknown>): CapabilityRequirement {
  const action = typeof params.action === 'string' ? params.action.trim() : '';
  switch (action) {
    case 'wish_list':
    case 'wish_read':
    case 'project_list':
    case 'project_read':
    case 'wardrobe_list':
    case 'wardrobe_read':
      return 'identity.read';
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

export function createProjectsTool(deps: ProjectsToolDeps): SubstrateAgentTool {
  const tool: SubstrateAgentTool = {
    name: 'projects',
    label: 'projects',
    description: CANONICAL_TOOL_SURFACE_DESCRIPTIONS.projects,
    parameters: Type.Object({
      action: Type.Union(
        PROJECTS_ACTIONS.map(action => Type.Literal(action)),
        { description: 'Required projects, wishes, or wardrobe action.' },
      ),
      title: Type.Optional(Type.String({ description: 'Project title for project_create.' })),
      wish_ref: Type.Optional(Type.String({ description: 'Stable wish:<uuid> reference for wish_read.' })),
      wish_text: Type.Optional(Type.String({
        maxLength: MAX_WISH_TEXT_CHARS,
        description: 'What the companion wants for wish_create, in her own words.',
      })),
      wish_context: Type.Optional(Type.String({
        maxLength: MAX_WISH_CONTEXT_CHARS,
        description: 'Optional context about why, when, or how the wish matters.',
      })),
      project_id: Type.Optional(Type.String({ description: 'Stable id for project_create.' })),
      project_ref: Type.Optional(Type.String({ description: 'Stable project:<id> reference.' })),
      project_status: Type.Optional(Type.Union([
        Type.Literal('active'), Type.Literal('paused'), Type.Literal('completed'), Type.Literal('archived'),
      ])),
      visibility: Type.Optional(Type.Union([
        Type.Literal('self'), Type.Literal('primary_contact'), Type.Literal('public'),
      ], { description: 'Companion-owned read/share visibility.' })),
      next_step: Type.Optional(Type.String({ description: 'The companion\'s own next-step intention.' })),
      artifact_ref: Type.Optional(Type.String({ description: 'Durable generated/file/wiki artifact reference.' })),
      artifact_label: Type.Optional(Type.String()),
      audience: Type.Optional(Type.Union([
        Type.Literal('self'), Type.Literal('primary_contact'), Type.Literal('public'),
      ], { description: 'Requested share audience for project_share; never supplied on project_add_artifact.' })),
      look_id: Type.Optional(Type.String({ description: 'Stable id for wardrobe_save.' })),
      look_ref: Type.Optional(Type.String({ description: 'Stable wardrobe:<id> reference.' })),
      look_name: Type.Optional(Type.String()),
      look_prompt: Type.Optional(Type.String({ description: 'Reusable outfit prompt fragment.' })),
      supersedes_ref: Type.Optional(Type.String({ description: 'Prior wardrobe:<id> ref replaced by this look.' })),
    }),
    execute: async (
      _toolCallId: string,
      params: ProjectsToolParams = {},
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      let action = typeof params.action === 'string' ? params.action : 'unknown';
      try {
        const resolved = normalizeAction(params);
        action = resolved;
        switch (resolved) {
          case 'wish_list': {
            const wishes = requirePersonalWishlist(deps).listWishes();
            return textResult(JSON.stringify({
              action: resolved,
              wishes,
              boundary: 'Wishes are companion-authored personal records. Saving one is asynchronous and does not notify or interrupt the operator.',
            }, null, 2));
          }
          case 'wish_read': {
            const wish = requirePersonalWishlist(deps).getWish(requireString(params.wish_ref, 'wish_ref'));
            return textResult(JSON.stringify({ action: resolved, wish }, null, 2));
          }
          case 'wish_create': {
            const wish = requirePersonalWishlist(deps).createWish({
              text: requireString(params.wish_text, 'wish_text'),
              ...(params.wish_context !== undefined ? { context: params.wish_context } : {}),
            });
            return textResult(JSON.stringify({
              action: resolved,
              wish,
              boundary: 'Saved for asynchronous operator review. No push notification or operator interruption was emitted.',
            }, null, 2));
          }
          case 'project_list': {
            const projects = requirePersonalProjects(deps).listProjects();
            return textResult(JSON.stringify({
              action: resolved,
              projects,
              boundary: 'Projects live in personal storage; this does not create a new persistence backend.',
            }, null, 2));
          }
          case 'project_read': {
            const project = requirePersonalProjects(deps).getProject(requireString(params.project_ref, 'project_ref'));
            return textResult(JSON.stringify({ action: resolved, project }, null, 2));
          }
          case 'project_create': {
            const project = await requirePersonalProjects(deps).createProject({
              ...(params.project_id ? { id: params.project_id } : {}),
              title: requireString(params.title, 'title'),
              nextStep: requireString(params.next_step, 'next_step'),
              ...(params.visibility ? { visibility: params.visibility } : {}),
            });
            return textResult(JSON.stringify({ action: resolved, project }, null, 2));
          }
          case 'project_update': {
            const project = await requirePersonalProjects(deps).updateProject({
              ref: requireString(params.project_ref, 'project_ref'),
              ...(params.next_step ? { nextStep: params.next_step } : {}),
              ...(params.project_status ? { status: params.project_status } : {}),
              ...(params.visibility ? { visibility: params.visibility } : {}),
            });
            return textResult(JSON.stringify({ action: resolved, project }, null, 2));
          }
          case 'project_add_artifact': {
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
            return textResult(JSON.stringify({ action: resolved, project }, null, 2));
          }
          case 'project_share': {
            const project = await requirePersonalProjects(deps).requestArtifactShare({
              projectRef: requireString(params.project_ref, 'project_ref'),
              artifactRef: requireString(params.artifact_ref, 'artifact_ref'),
              audience: params.audience ?? 'self',
            });
            return textResult(JSON.stringify({
              action: resolved,
              project,
              boundary: 'This records sharing intent only. Attaching or publishing the artifact still passes through sensitivity inheritance and HITL egress policy.',
            }, null, 2));
          }
          case 'wardrobe_list': {
            const looks = requirePersonalProjects(deps).listWardrobeLooks();
            return textResult(JSON.stringify({ action: resolved, looks }, null, 2));
          }
          case 'wardrobe_read': {
            const look = requirePersonalProjects(deps).getWardrobeLook(requireString(params.look_ref, 'look_ref'));
            return textResult(JSON.stringify({ action: resolved, look }, null, 2));
          }
          case 'wardrobe_save': {
            const look = requirePersonalProjects(deps).saveNamedLook({
              ...(params.look_id ? { id: params.look_id } : {}),
              name: requireString(params.look_name, 'look_name'),
              promptFragment: requireString(params.look_prompt, 'look_prompt'),
              ...(params.visibility ? { visibility: params.visibility } : {}),
              ...(params.supersedes_ref ? { supersedesRef: params.supersedes_ref } : {}),
            });
            return textResult(JSON.stringify({ action: resolved, look }, null, 2));
          }
          case 'wardrobe_revise': {
            const look = requirePersonalProjects(deps).reviseNamedLook({
              ref: requireString(params.look_ref, 'look_ref'),
              promptFragment: requireString(params.look_prompt, 'look_prompt'),
              ...(params.visibility ? { visibility: params.visibility } : {}),
            });
            return textResult(JSON.stringify({ action: resolved, look }, null, 2));
          }
        }
      } catch (error) {
        return textResultWithError(`projects failed for action=${action}: ${toErrorMessage(error)}`, true);
      }
    },
  };
  return withCapabilityRequirement(tool, resolveProjectsCapabilityRequirement);
}
