// ── Skills runtime prompt & turn-summary port (psfn-framework-kbdvl.1) ──
//
// Core-owned contracts for the optional skills prompt index read and per-turn
// tool-call summary consumed by prompt assembly and turn records without
// pulling the host `faculties/skills/` implementation into core.

import type { ToolCallOutcomeCounts } from './tool-call-outcome.js';

export interface TurnToolSummary {
  toolCalls: number;
  usedThinkTool: boolean;
  /**
   * Bounded task cue — the participant's framing for this turn. Absent means
   * "no cue", which yields no candidates and therefore only ever a create
   * opportunity.
   */
  taskCue?: string;
  /**
   * Structural, content-free census of what the turn's tool calls returned
   * (psfn-framework-lpxg3.2). Absent means the outcome is unknown, and an
   * unknown outcome is not evidence of success.
   */
  outcomes?: ToolCallOutcomeCounts;
}

/** Narrow prompt-index read facet satisfied by `SkillsRuntime`. */
export interface SkillsRuntimePromptPort {
  getPromptXml(): Promise<string>;
  getCachedPromptXml(): string;
}
