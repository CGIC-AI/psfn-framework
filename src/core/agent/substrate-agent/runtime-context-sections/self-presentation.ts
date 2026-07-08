// ── Self-presentation section producer (E2.6) ──
// The skills index body, the appearance context body, and the self-image tool
// flag: what the companion can present about itself this turn. Tool state is
// a declared input; appearance is projected from the session template
// variables.

import type { AdaptiveLoadedExtendedToolState } from '../../adaptive-tools-telemetry.js';
import { unwrapPromptSectionBody } from './section-format.js';

const SELF_IMAGE_TOOL_NAMES = ['selfie_create'] as const;

export function resolveAppearanceContextFromTemplateVariables(
  templateVariables?: Record<string, string>,
): string {
  const promptVariables = templateVariables ?? {};
  return (
    promptVariables['character.visual_description']
    || promptVariables.extensions_visual_description
    || promptVariables.visual_description
    || ''
  ).trim();
}

function hasActiveSelfImageTool(input: {
  loadedExtended: Map<string, AdaptiveLoadedExtendedToolState>;
  promotedExtendedToolNames: Set<string>;
}): boolean {
  for (const toolName of SELF_IMAGE_TOOL_NAMES) {
    if (input.promotedExtendedToolNames.has(toolName)) return true;
    if (input.loadedExtended.has(toolName)) return true;
  }
  return false;
}

export function buildSelfPresentationPromptVariables(input: {
  internalTurn: boolean;
  templateVariables?: Record<string, string>;
  skillsContext?: string;
  loadedExtended: Map<string, AdaptiveLoadedExtendedToolState>;
  promotedExtendedToolNames: Set<string>;
}): Record<string, string> {
  const appearanceContextBody = input.internalTurn
    ? ''
    : resolveAppearanceContextFromTemplateVariables(input.templateVariables);
  return {
    runtime_skills_index_body: unwrapPromptSectionBody(input.skillsContext),
    runtime_appearance_context_body: appearanceContextBody,
    runtime_self_image_tool_active: String(hasActiveSelfImageTool({
      loadedExtended: input.loadedExtended,
      promotedExtendedToolNames: input.promotedExtendedToolNames,
    })),
  };
}
