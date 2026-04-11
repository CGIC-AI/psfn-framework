import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import { textResult, textResultWithError } from '../../core/tools/results.js';
import type { SkillsRuntime } from './runtime.js';
import type { SkillOwnership, SkillSource } from './types.js';
import { toErrorMessage } from '../../shared/utils/errors.js';

const SKILL_TOOL_ACTION_NAMES = [
  'list',
  'skill_list',
  'view',
  'skill_view',
  'create',
  'skill_create',
  'update',
  'skill_update',
] as const;
const SKILL_TOOL_ACTION_HELP = [
  'list',
  'view',
  'create',
  'update',
].join(', ');

type SkillToolActionName = (typeof SKILL_TOOL_ACTION_NAMES)[number];
type SkillToolAction = 'list' | 'view' | 'create' | 'update';

function resolveSkillOwnership(source: SkillSource): SkillOwnership {
  switch (source) {
    case 'companion':
    case 'custom':
      return 'companion';
    case 'bundled':
    case 'extra':
      return 'deployment';
  }
}

interface SkillListParams {
  includeSkipped?: boolean;
  includeContent?: boolean;
}

interface SkillToolParams extends SkillListParams {
  action?: SkillToolActionName;
  name?: string;
  category?: string;
  content?: string;
  description?: string;
}

function normalizeSkillAction(params: SkillToolParams): SkillToolAction {
  const rawAction = typeof params.action === 'string' ? params.action.trim() : '';
  if (!rawAction) {
    const hasNonListParams = Object.entries(params).some(([key, value]) => (
      key !== 'action'
      && key !== 'includeSkipped'
      && key !== 'includeContent'
      && value !== undefined
    ));
    if (!hasNonListParams) {
      return 'list';
    }
    throw new Error(`action is required unless using the default list behavior (${SKILL_TOOL_ACTION_HELP})`);
  }

  switch (rawAction) {
    case 'list':
    case 'skill_list':
      return 'list';
    case 'view':
    case 'skill_view':
      return 'view';
    case 'create':
    case 'skill_create':
      return 'create';
    case 'update':
    case 'skill_update':
      return 'update';
    default:
      throw new Error(`action must be one of: ${SKILL_TOOL_ACTION_HELP}`);
  }
}

function buildSkillListPayload(runtime: SkillsRuntime, params: SkillListParams): Record<string, unknown> {
  const snapshot = runtime.getSnapshot();
  const evaluations = runtime.listSkillEvaluations();
  const includeSkipped = params.includeSkipped ?? true;
  const includeContent = params.includeContent ?? false;
  const includedNames = new Set(snapshot.includedSkills.map(skill => skill.name));
  const categorySummary = runtime.listCategorySummary();

  return {
    generatedAt: snapshot.generatedAt,
    signature: snapshot.signature,
    configEnabled: snapshot.configEnabled,
    managedOwnership: runtime.getManagedOwnership(),
    budget: snapshot.budget,
    scannedFiles: snapshot.scannedFiles,
    loadedSkills: snapshot.loadedSkills,
    categories: categorySummary.map(({ category, total, included }) => ({
      category,
      total,
      included,
    })),
    includedInPrompt: snapshot.includedSkills.map(skill => ({
      name: skill.name,
      category: skill.category,
      description: skill.description,
      version: skill.version ?? null,
      always: skill.always,
      source: skill.source,
      ownership: resolveSkillOwnership(skill.source),
      path: skill.relativePath,
      requires: skill.requires,
    })),
    skills: evaluations.map(({ entry, eligibility }) => ({
      name: entry.name,
      category: entry.category,
      description: entry.description,
      version: entry.version ?? null,
      createdAt: entry.createdAt ?? null,
      updatedAt: entry.updatedAt ?? null,
      source: entry.source,
      ownership: resolveSkillOwnership(entry.source),
      path: entry.relativePath,
      inPromptIndex: includedNames.has(entry.name),
      eligible: eligibility.eligible,
      reasons: eligibility.reasons,
      requires: entry.requires,
      ...(includeContent ? { content: entry.content } : {}),
    })),
    ...(includeSkipped
      ? {
        skipped: snapshot.skipped.map(item => ({
          kind: item.kind,
          name: item.name,
          source: item.source,
          path: item.relativePath,
          reason: item.reason,
          details: item.details ?? [],
        })),
      }
      : {}),
  };
}

function buildSkillViewPayload(runtime: SkillsRuntime, name: string): Record<string, unknown> | null {
  const result = runtime.findSkill(name);
  if (!result) {
    return null;
  }

  const { entry, eligible } = result;
  return {
    name: entry.name,
    category: entry.category,
    description: entry.description,
    version: entry.version ?? null,
    createdAt: entry.createdAt ?? null,
    updatedAt: entry.updatedAt ?? null,
    source: entry.source,
    ownership: resolveSkillOwnership(entry.source),
    path: entry.relativePath,
    always: entry.always,
    requires: entry.requires,
    eligibility: {
      eligible: eligible.eligible,
      reasons: eligible.reasons,
      missingBinaries: eligible.missingBinaries,
      missingEnv: eligible.missingEnv,
      missingConfig: eligible.missingConfig,
      disabledByConfig: eligible.disabledByConfig,
    },
    content: entry.content,
  };
}

export function createSkillTool(runtime: SkillsRuntime): AgentTool<any> {
  return {
    name: 'skill',
    label: 'skill',
    description:
      'Unified skill management surface for list/view/create/update. '
      + 'Skills capture reusable workflow guidance; tools execute actions. '
      + 'Creator workflows such as image or music creation should be modeled as skills loaded with action="view", not as new top-level tools. '
      + `Use action=${SKILL_TOOL_ACTION_HELP}. Legacy action aliases remain available during migration.`,
    parameters: Type.Object({
      action: Type.Optional(Type.Union(SKILL_TOOL_ACTION_NAMES.map((action) => Type.Literal(action)), {
        description:
          'Skill action. Defaults to list when omitted and no action-specific parameters are provided.',
      })),
      includeSkipped: Type.Optional(Type.Boolean({
        description: 'Optional for action=list. Include filtered/omitted skills with reasons.',
      })),
      includeContent: Type.Optional(Type.Boolean({
        description: 'Optional for action=list. Include full SKILL.md body content for included skills.',
      })),
      name: Type.Optional(Type.String({
        minLength: 1,
        description: 'Required for action=view|create|update. Skill name.',
      })),
      category: Type.Optional(Type.String({
        minLength: 1,
        description: 'Required for action=create. Category folder name.',
      })),
      content: Type.Optional(Type.String({
        minLength: 1,
        description: 'Required for action=create|update. Markdown skill instructions.',
      })),
      description: Type.Optional(Type.String({
        description: 'Optional one-line summary used in prompt index.',
      })),
    }),
    execute: async (_toolCallId: string, params: SkillToolParams) => {
      try {
        switch (normalizeSkillAction(params)) {
          case 'list':
            return textResult(JSON.stringify(buildSkillListPayload(runtime, params), null, 2));
          case 'view': {
            const name = typeof params.name === 'string' ? params.name.trim() : '';
            if (!name) {
              return textResultWithError('skill action=view requires a non-empty name.', true);
            }

            const payload = buildSkillViewPayload(runtime, name);
            if (!payload) {
              return textResultWithError(`Skill "${name}" not found`, true);
            }
            return textResult(JSON.stringify(payload, null, 2));
          }
          case 'create': {
            const name = typeof params.name === 'string' ? params.name : '';
            const category = typeof params.category === 'string' ? params.category : '';
            const content = typeof params.content === 'string' ? params.content : '';
            if (!name.trim()) {
              return textResultWithError('skill action=create requires a non-empty name.', true);
            }
            if (!category.trim()) {
              return textResultWithError('skill action=create requires a non-empty category.', true);
            }
            if (!content.trim()) {
              return textResultWithError('skill action=create requires non-empty content.', true);
            }

            const created = runtime.getStore().create({
              name,
              category,
              description: params.description,
              content,
            });
            runtime.invalidate();

            return textResult(JSON.stringify({
              action: 'created',
              name: created.name,
              category: created.category,
              version: created.version,
              createdAt: created.createdAt,
              updatedAt: created.updatedAt,
              ownership: 'companion',
              path: created.relativePath,
            }, null, 2));
          }
          case 'update': {
            const name = typeof params.name === 'string' ? params.name : '';
            const content = typeof params.content === 'string' ? params.content : '';
            if (!name.trim()) {
              return textResultWithError('skill action=update requires a non-empty name.', true);
            }
            if (!content.trim()) {
              return textResultWithError('skill action=update requires non-empty content.', true);
            }

            const updated = runtime.getStore().update({
              name,
              description: params.description,
              content,
            });
            runtime.invalidate();

            return textResult(JSON.stringify({
              action: 'updated',
              name: updated.name,
              category: updated.category,
              version: updated.version,
              createdAt: updated.createdAt,
              updatedAt: updated.updatedAt,
              ownership: 'companion',
              path: updated.relativePath,
            }, null, 2));
          }
        }
      } catch (error) {
        const message = toErrorMessage(error);
        return textResultWithError(`Unable to use skill tool: ${message}`, true);
      }
    },
  };
}
