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

import { createComponentLogger } from '../../shared/logger.js';
import type { ToolCallOutcomeCounts } from '../../shared/contracts/tool-call-outcome.js';
import {
  DEFAULT_SKILL_REUSE_CONFIG,
  type SkillReuseConfig,
} from '../../system/config/skills-config.js';
import {
  buildSkillReuseOpportunity,
  rankOwnedSkillsForCue,
  turnDemonstratedReusableValue,
  type SkillOutcomeEvidenceIndex,
} from './reuse.js';
import type { SkillEntry } from './types.js';

const log = createComponentLogger('skills.reflection-nudge');

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
  /**
   * Durable post-use outcome evidence for ranking (psfn-framework-sap72).
   * Synchronous and cache-only, like the admitted-skill index.
   */
  resolveOutcomeEvidence?: () => SkillOutcomeEvidenceIndex;
  /**
   * Attribute this completed turn's structural outcome to the skills it used.
   * Durable, so the evidence outlives the process. A throw here is contained
   * and logged: telemetry never fails a turn.
   */
  recordPostUseOutcome?: (input: { demonstratedValue: boolean }) => void;
}

export class ReflectionNudgeTracker {
  private readonly overrides: Partial<ReflectionNudgeConfig>;
  private readonly resolveOwnerConfig: (() => SkillReuseConfig) | undefined;
  private resolveAdmittedSkills: () => readonly SkillEntry[];
  private readonly resolveOutcomeEvidence: (() => SkillOutcomeEvidenceIndex) | undefined;
  private readonly recordPostUseOutcome:
    ((input: { demonstratedValue: boolean }) => void) | undefined;
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
    this.resolveOutcomeEvidence = normalized.resolveOutcomeEvidence;
    this.recordPostUseOutcome = normalized.recordPostUseOutcome;
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
    const demonstratedValue = turnDemonstratedReusableValue(summary.outcomes);
    // Record the post-use evidence for EVERY turn whose census was observed,
    // before the complexity and quietness gates (sap72): a skill used in a
    // simple turn must be answered for by THAT turn, not by the next complex
    // one. Telemetry never fails a turn — the loop is an offer, not the work.
    if (summary.outcomes && this.recordPostUseOutcome) {
      try {
        this.recordPostUseOutcome({ demonstratedValue });
      } catch (error) {
        log.warn('Skill post-use outcome evidence was not recorded', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (!this.isQualifyingTurn(summary, config)) return null;

    this.qualifyingTurnCount += 1;
    if (this.qualifyingTurnCount % config.nudgeEveryNthTurn !== 0) {
      return null;
    }

    // An unknown census is not a success. A turn whose outcomes were never
    // observed cannot demonstrate reusable value, so it stays silent.
    if (!demonstratedValue) return null;

    const candidates = summary.taskCue
      ? rankOwnedSkillsForCue({
        cue: summary.taskCue,
        entries: this.resolveAdmittedSkills(),
        config,
        ...(this.outcomeEvidence() ? { outcomeEvidence: this.outcomeEvidence()! } : {}),
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

  /**
   * Recorded evidence for ranking, or null when there is none to read. An
   * unreadable telemetry file degrades ordering to pure relevance; it never
   * fails the turn.
   */
  private outcomeEvidence(): SkillOutcomeEvidenceIndex | null {
    if (!this.resolveOutcomeEvidence) return null;
    try {
      return this.resolveOutcomeEvidence();
    } catch (error) {
      log.warn('Skill outcome evidence was unreadable; ranking on relevance alone', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
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
  return 'config' in value
    || 'resolveAdmittedSkills' in value
    || 'resolveConfig' in value
    || 'resolveOutcomeEvidence' in value
    || 'recordPostUseOutcome' in value;
}
