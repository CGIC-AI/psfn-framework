// ── Behavioral-notes and skills section producers (E2.6) ──
// Count/body variables over the pre-fetched behavioral-notes block and the
// pre-rendered skills context. Both blocks are declared inputs; fetching them
// (provider calls, error policy) stays with the orchestration layer.

import { countNonEmptyLines, unwrapPromptSectionBody } from './section-format.js';

const SKILL_TAG_PATTERN = /<skill\b/gi;

export function buildBehavioralNotesPromptVariables(behavioralNotesBlock: string | null | undefined): Record<string, string> {
  const body = unwrapPromptSectionBody(behavioralNotesBlock);
  return {
    runtime_behavioral_notes_count: body ? String(countNonEmptyLines(body)) : '0',
    runtime_behavioral_notes_body: body,
  };
}

export function buildSkillsPromptVariables(skillsContext: string | null | undefined): Record<string, string> {
  const count = skillsContext?.match(SKILL_TAG_PATTERN)?.length ?? 0;
  return {
    runtime_skills_count: String(count),
  };
}
