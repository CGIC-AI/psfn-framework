// ── Skill Reflection Nudge ──
//
// After a complex multi-tool turn, offer the companion ONE opportunity to keep
// what it just worked out — and prefer revising an existing owned skill over
// creating a near-duplicate (psfn-framework-lpxg3.3).
//
// The loop is quiet by construction:
//   - it only looks at turns that were complex enough to have learned anything;
//   - it only speaks every Nth such turn (the owner-file quietness budget);
//   - it never speaks twice about the same skill;
//   - a failed, denied, or degraded-evidence turn produces nothing at all, so a
//     bad attempt can never be promoted as reusable guidance;
//   - candidates come only from the CogSec-admitted skill index, so a held or
//     changed skill is not surfaced, and no skill body is ever read here.
//
// Nothing in this file writes. The companion may ignore, revise, or reject
// every opportunity, and the actual write still travels the governed skill tool.

import type { ToolCallOutcomeCounts } from '../../shared/contracts/tool-call-outcome.js';
import {
  DEFAULT_SKILL_REUSE_CONFIG,
  type SkillReuseConfig,
} from '../../system/config/skills-config.js';
import {
  buildSkillReuseOpportunity,
  rankOwnedSkillsForCue,
  turnDemonstratedReusableValue,
} from './reuse.js';
import type { SkillEntry } from './types.js';

export interface ReflectionNudgeConfig extends SkillReuseConfig {
  /** Also qualify if the analysis workbench tool was used. Default: true. */
  nudgeOnThinkTool: boolean;
}

const DEFAULT_CONFIG: ReflectionNudgeConfig = {
  ...DEFAULT_SKILL_REUSE_CONFIG,
  nudgeOnThinkTool: true,
};

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

export interface ReflectionNudgeTrackerOptions {
  config?: Partial<ReflectionNudgeConfig>;
  /**
   * Owner-file reuse bounds, resolved per evaluation so an operator edit takes
   * effect on the next skill-cache rebuild instead of at process start. Must be
   * synchronous and I/O free.
   */
  resolveConfig?: () => SkillReuseConfig;
  /**
   * The CogSec-ADMITTED, eligible skill index as of the prompt already built
   * for this turn. Synchronous and cache-only by design: the reuse loop must
   * add no scan, no read, and no admission work of its own, and a skill that is
   * held or has changed simply is not in it.
   */
  resolveAdmittedSkills?: () => readonly SkillEntry[];
}

export class ReflectionNudgeTracker {
  private readonly overrides: Partial<ReflectionNudgeConfig>;
  private readonly resolveOwnerConfig: (() => SkillReuseConfig) | undefined;
  private resolveAdmittedSkills: () => readonly SkillEntry[];
  private qualifyingTurnCount = 0;
  /** Skills already offered for revision this process; never offered twice. */
  private offeredSkillNames = new Set<string>();

  constructor(options?: Partial<ReflectionNudgeConfig> | ReflectionNudgeTrackerOptions) {
    const normalized: ReflectionNudgeTrackerOptions = isTrackerOptions(options)
      ? options
      : { ...(options ? { config: options } : {}) };
    this.overrides = normalized.config ?? {};
    this.resolveOwnerConfig = normalized.resolveConfig;
    this.resolveAdmittedSkills = normalized.resolveAdmittedSkills ?? (() => []);
  }

  /** Explicit constructor overrides win over the owner file, which wins over defaults. */
  private get config(): ReflectionNudgeConfig {
    return {
      ...DEFAULT_CONFIG,
      ...(this.resolveOwnerConfig?.() ?? {}),
      ...this.overrides,
    };
  }

  /**
   * Evaluate the completed turn. Returns the opportunity text when this turn
   * earned one, or null — which is the ordinary answer.
   */
  evaluate(summary: TurnToolSummary): string | null {
    const config = this.config;
    if (!this.isQualifyingTurn(summary, config)) return null;

    this.qualifyingTurnCount += 1;
    if (this.qualifyingTurnCount % config.nudgeEveryNthTurn !== 0) {
      return null;
    }

    // An unknown census is not a success. A turn whose outcomes were never
    // observed cannot demonstrate reusable value, so it stays silent.
    if (!turnDemonstratedReusableValue(summary.outcomes)) return null;

    const candidates = summary.taskCue
      ? rankOwnedSkillsForCue({
        cue: summary.taskCue,
        entries: this.resolveAdmittedSkills(),
        config,
      }).filter(candidate => !this.offeredSkillNames.has(candidate.name))
      : [];

    const opportunity = buildSkillReuseOpportunity({
      candidates,
      demonstratedValue: true,
    });
    const offered = candidates[0];
    if (opportunity && offered) this.offeredSkillNames.add(offered.name);
    return opportunity;
  }

  private isQualifyingTurn(
    summary: TurnToolSummary,
    config: ReflectionNudgeConfig,
  ): boolean {
    if (summary.toolCalls >= config.minToolCalls) return true;
    if (config.nudgeOnThinkTool && summary.usedThinkTool) return true;
    return false;
  }

  /** Reset the counter and the offered-skill memory (e.g., on agent restart). */
  reset(): void {
    this.qualifyingTurnCount = 0;
    this.offeredSkillNames.clear();
  }

  /** Expose current qualifying turn count for testing. */
  get turnCount(): number {
    return this.qualifyingTurnCount;
  }
}

function isTrackerOptions(
  value: Partial<ReflectionNudgeConfig> | ReflectionNudgeTrackerOptions | undefined,
): value is ReflectionNudgeTrackerOptions {
  if (!value) return false;
  return 'config' in value || 'resolveAdmittedSkills' in value || 'resolveConfig' in value;
}
