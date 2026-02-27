// ── Skill Reflection Nudge ──
// After complex multi-tool turns, nudge the agent to consider saving
// the successful approach as a skill via skill_create.

export interface ReflectionNudgeConfig {
  /** Minimum tool calls in a turn to qualify as "complex". Default: 3. */
  minToolCalls: number;
  /** Also qualify if the `think` (RLM) tool was used. Default: true. */
  nudgeOnThinkTool: boolean;
  /** Only nudge every Nth qualifying turn to avoid nagging. Default: 3. */
  nudgeEveryNthTurn: number;
}

const DEFAULT_CONFIG: ReflectionNudgeConfig = {
  minToolCalls: 3,
  nudgeOnThinkTool: true,
  nudgeEveryNthTurn: 3,
};

export interface TurnToolSummary {
  toolCalls: number;
  usedThinkTool: boolean;
}

export class ReflectionNudgeTracker {
  private config: ReflectionNudgeConfig;
  private qualifyingTurnCount = 0;

  constructor(config?: Partial<ReflectionNudgeConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Evaluate whether the completed turn qualifies for a reflection nudge.
   * Returns the nudge message if conditions are met, or null otherwise.
   */
  evaluate(summary: TurnToolSummary): string | null {
    const qualifies = this.isQualifyingTurn(summary);
    if (!qualifies) return null;

    this.qualifyingTurnCount += 1;

    if (this.qualifyingTurnCount % this.config.nudgeEveryNthTurn !== 0) {
      return null;
    }

    return (
      '[System: This turn involved complex multi-step work. ' +
      'Consider using skill_create to save this approach for future reference ' +
      'if it was successful.]'
    );
  }

  private isQualifyingTurn(summary: TurnToolSummary): boolean {
    if (summary.toolCalls >= this.config.minToolCalls) return true;
    if (this.config.nudgeOnThinkTool && summary.usedThinkTool) return true;
    return false;
  }

  /** Reset the counter (e.g., on agent restart). */
  reset(): void {
    this.qualifyingTurnCount = 0;
  }

  /** Expose current qualifying turn count for testing. */
  get turnCount(): number {
    return this.qualifyingTurnCount;
  }
}
