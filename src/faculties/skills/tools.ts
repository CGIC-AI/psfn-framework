import type { SubstrateAgentTool } from '../../boundary/pi-agent/index.js';
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
  'stats',
  'skill_stats',
  'create',
  'skill_create',
  'update',
  'skill_update',
] as const;
const SKILL_TOOL_ACTION_HELP = [
  'list',
  'view',
  'stats',
  'create',
  'update',
].join(', ');

type SkillToolActionName = (typeof SKILL_TOOL_ACTION_NAMES)[number];
type SkillToolAction = 'list' | 'view' | 'stats' | 'create' | 'update';

function resolveSkillOwnership(source: SkillSource): SkillOwnership {
  switch (source) {
    case 'custom':
      return 'personal';
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
    case 'stats':
    case 'skill_stats':
      return 'stats';
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

function buildSkillMetadata(runtime: SkillsRuntime, name: string): Record<string, unknown> | null {
  const result = runtime.findSkill(name);
  if (!result) return null;
  const { entry, eligible } = result;
  const snapshot = runtime.getSnapshot();
  const includedNames = new Set(snapshot.includedSkills.map(skill => skill.name));
  return {
    name: entry.name,
    category: entry.category ?? null,
    description: entry.description,
    version: entry.version ?? null,
    createdAt: entry.createdAt ?? null,
    updatedAt: entry.updatedAt ?? null,
    source: entry.source,
    ownership: resolveSkillOwnership(entry.source),
    path: entry.relativePath,
    inPromptIndex: includedNames.has(entry.name),
    eligible: eligible.eligible,
    reasons: eligible.reasons,
    requires: entry.requires,
  };
}

function buildStatsTotals(stats: ReturnType<SkillsRuntime['listSkillUsageStats']>): Record<string, unknown> {
  const totals = stats.reduce((accumulator, item) => {
    accumulator.recordedSkills += 1;
    accumulator.invocationCount += item.invocationCount;
    accumulator.successCount += item.successCount;
    accumulator.failureCount += item.failureCount;
    if (item.averageDurationMs !== null && item.durationSampleCount > 0) {
      accumulator.durationSampleCount += item.durationSampleCount;
      accumulator.totalDurationMs += item.averageDurationMs * item.durationSampleCount;
    }
    return accumulator;
  }, {
    recordedSkills: 0,
    invocationCount: 0,
    successCount: 0,
    failureCount: 0,
    durationSampleCount: 0,
    totalDurationMs: 0,
  });

  return {
    recordedSkills: totals.recordedSkills,
    invocationCount: totals.invocationCount,
    successCount: totals.successCount,
    failureCount: totals.failureCount,
    successRate: totals.invocationCount > 0
      ? totals.successCount / totals.invocationCount
      : null,
    averageDurationMs: totals.durationSampleCount > 0
      ? totals.totalDurationMs / totals.durationSampleCount
      : null,
  };
}

function buildSkillStatsPayload(runtime: SkillsRuntime, name?: string): Record<string, unknown> {
  const normalizedName = typeof name === 'string' ? name.trim() : '';
  if (normalizedName) {
    const skill = buildSkillMetadata(runtime, normalizedName);
    const lookupName = typeof skill?.name === 'string' ? skill.name : normalizedName;
    const stats = runtime.getSkillUsageStats(lookupName);
    const status = skill
      ? (stats ? 'ok' : 'no_stats')
      : (stats ? 'stats_without_loaded_skill' : 'not_found');

    return {
      action: 'stats',
      scope: 'skill',
      status,
      name: lookupName,
      skill,
      stats,
      message: stats
        ? null
        : skill
          ? `No skill usage stats recorded for "${lookupName}".`
          : `Skill "${lookupName}" was not found and no usage stats are recorded for it.`,
    };
  }

  const snapshot = runtime.getSnapshot();
  const evaluations = runtime.listSkillEvaluations();
  const includedNames = new Set(snapshot.includedSkills.map(skill => skill.name));
  const stats = runtime.listSkillUsageStats();
  const statsByName = new Map(stats.map(item => [item.name.toLowerCase(), item]));
  const loadedSkillNames = new Set(evaluations.map(({ entry }) => entry.name.toLowerCase()));
  const recordedWithoutLoadedSkillCount = stats
    .filter(item => !loadedSkillNames.has(item.name.toLowerCase()))
    .length;

  return {
    action: 'stats',
    scope: 'list',
    generatedAt: snapshot.generatedAt,
    signature: snapshot.signature,
    managedOwnership: runtime.getManagedOwnership(),
    totals: buildStatsTotals(stats),
    recordedWithoutLoadedSkillCount,
    skills: evaluations.map(({ entry, eligibility }) => ({
      name: entry.name,
      category: entry.category ?? null,
      description: entry.description,
      version: entry.version ?? null,
      source: entry.source,
      ownership: resolveSkillOwnership(entry.source),
      path: entry.relativePath,
      inPromptIndex: includedNames.has(entry.name),
      eligible: eligibility.eligible,
      reasons: eligibility.reasons,
      stats: statsByName.get(entry.name.toLowerCase()) ?? null,
    })),
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

export function createSkillTool(runtime: SkillsRuntime): SubstrateAgentTool {
  return {
    name: 'skill',
    label: 'skill',
    description:
      'Unified skill management surface for list/view/stats/create/update. '
      + 'Skills capture reusable workflow guidance; tools execute actions. '
      + 'Created and updated skills are personal skills stored under the configured personal files root, separate from deployment/system skill directories. '
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
        description: 'Required for action=view|create|update. Optional for action=stats; omit to list summaries.',
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

            const startedAt = Date.now();
            const payload = buildSkillViewPayload(runtime, name);
            if (!payload) {
              return textResultWithError(`Skill "${name}" not found`, true);
            }
            let telemetryWarning: string | null = null;
            try {
              runtime.recordSkillInvocation(name, {
                outcome: 'success',
                durationMs: Date.now() - startedAt,
              });
            } catch (error) {
              telemetryWarning = `Skill usage telemetry was not recorded: ${toErrorMessage(error)}`;
            }
            return textResult(JSON.stringify({
              ...payload,
              ...(telemetryWarning ? { telemetryWarning } : {}),
            }, null, 2));
          }
          case 'stats':
            return textResult(JSON.stringify(buildSkillStatsPayload(runtime, params.name), null, 2));
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
              ownership: 'personal',
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
              ownership: 'personal',
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
