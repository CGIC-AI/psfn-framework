import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import { textResult, textResultWithError } from '../tools/results.js';
import type { SkillsRuntime } from './runtime.js';

interface SkillListParams {
  includeSkipped?: boolean;
  includeContent?: boolean;
}

interface SkillViewParams {
  name: string;
}

interface SkillCreateParams {
  name: string;
  category: string;
  content: string;
  description?: string;
}

interface SkillUpdateParams {
  name: string;
  content: string;
  description?: string;
}

export function createSkillListTool(runtime: SkillsRuntime): AgentTool<any> {
  return {
    name: 'skill_list',
    label: 'skill_list',
    description: 'List discovered skills, eligibility outcomes, and currently injected skill context.',
    parameters: Type.Object({
      includeSkipped: Type.Optional(Type.Boolean({ description: 'Include filtered/omitted skills with reasons.' })),
      includeContent: Type.Optional(Type.Boolean({ description: 'Include SKILL.md body content for included skills.' })),
    }),
    execute: async (_toolCallId: string, params: SkillListParams) => {
      const snapshot = runtime.getSnapshot();
      const evaluations = runtime.listSkillEvaluations();
      const includeSkipped = params.includeSkipped ?? true;
      const includeContent = params.includeContent ?? false;
      const includedNames = new Set(snapshot.includedSkills.map(skill => skill.name));

      const payload = {
        generatedAt: snapshot.generatedAt,
        signature: snapshot.signature,
        configEnabled: snapshot.configEnabled,
        budget: snapshot.budget,
        scannedFiles: snapshot.scannedFiles,
        loadedSkills: snapshot.loadedSkills,
        includedInPrompt: snapshot.includedSkills.map(skill => ({
          name: skill.name,
          category: skill.category,
          description: skill.description,
          version: skill.version ?? null,
          always: skill.always,
          source: skill.source,
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

      return textResult(JSON.stringify(payload, null, 2));
    },
  };
}

export function createSkillViewTool(runtime: SkillsRuntime): AgentTool<any> {
  return {
    name: 'skill_view',
    label: 'skill_view',
    description: 'Load full YAML + Markdown content for one skill by name.',
    parameters: Type.Object({
      name: Type.String({ description: 'Skill name to load.' }),
    }),
    execute: async (_toolCallId: string, params: SkillViewParams) => {
      const result = runtime.findSkill(params.name);
      if (!result) {
        return textResultWithError(`Skill "${params.name}" not found`, true);
      }

      const { entry, eligible } = result;
      const payload = {
        name: entry.name,
        category: entry.category,
        description: entry.description,
        version: entry.version ?? null,
        createdAt: entry.createdAt ?? null,
        updatedAt: entry.updatedAt ?? null,
        source: entry.source,
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

      return textResult(JSON.stringify(payload, null, 2));
    },
  };
}

export function createSkillCreateTool(runtime: SkillsRuntime): AgentTool<any> {
  return {
    name: 'skill_create',
    label: 'skill_create',
    description: 'Create a managed skill document in data/skills/<category>/<name>/SKILL.md.',
    parameters: Type.Object({
      name: Type.String({ description: 'Unique skill name (letters, numbers, _, -).' }),
      category: Type.String({ description: 'Category folder (letters, numbers, _, -).' }),
      content: Type.String({ description: 'Markdown skill instructions.' }),
      description: Type.Optional(Type.String({ description: 'One-line summary used in prompt index.' })),
    }),
    execute: async (_toolCallId: string, params: SkillCreateParams) => {
      try {
        const created = runtime.getStore().create({
          name: params.name,
          category: params.category,
          description: params.description,
          content: params.content,
        });
        runtime.invalidate();

        return textResult(JSON.stringify({
          action: 'created',
          name: created.name,
          category: created.category,
          version: created.version,
          createdAt: created.createdAt,
          updatedAt: created.updatedAt,
          path: created.relativePath,
        }, null, 2));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return textResultWithError(`Unable to create skill: ${message}`, true);
      }
    },
  };
}

export function createSkillUpdateTool(runtime: SkillsRuntime): AgentTool<any> {
  return {
    name: 'skill_update',
    label: 'skill_update',
    description: 'Update an existing managed skill by name and increment its version.',
    parameters: Type.Object({
      name: Type.String({ description: 'Existing skill name.' }),
      content: Type.String({ description: 'Updated markdown instructions.' }),
      description: Type.Optional(Type.String({ description: 'Optional updated one-line summary.' })),
    }),
    execute: async (_toolCallId: string, params: SkillUpdateParams) => {
      try {
        const updated = runtime.getStore().update({
          name: params.name,
          description: params.description,
          content: params.content,
        });
        runtime.invalidate();

        return textResult(JSON.stringify({
          action: 'updated',
          name: updated.name,
          category: updated.category,
          version: updated.version,
          createdAt: updated.createdAt,
          updatedAt: updated.updatedAt,
          path: updated.relativePath,
        }, null, 2));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return textResultWithError(`Unable to update skill: ${message}`, true);
      }
    },
  };
}
