import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import { textResult } from '../tools/results.js';
import type { SkillsRuntime } from './runtime.js';

interface SkillListParams {
  includeSkipped?: boolean;
  includeContent?: boolean;
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
      const includeSkipped = params.includeSkipped ?? true;
      const includeContent = params.includeContent ?? false;

      const payload = {
        generatedAt: snapshot.generatedAt,
        signature: snapshot.signature,
        configEnabled: snapshot.configEnabled,
        budget: snapshot.budget,
        scannedFiles: snapshot.scannedFiles,
        loadedSkills: snapshot.loadedSkills,
        includedSkills: snapshot.includedSkills.map(skill => ({
          name: skill.name,
          description: skill.description,
          always: skill.always,
          source: skill.source,
          path: skill.relativePath,
          requires: skill.requires,
          ...(includeContent ? { content: skill.content } : {}),
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
