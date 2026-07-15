import type {
  ParentTurnContinuationStopSnapshot,
} from '../../shared/contracts/runtime.js';

export const AGENT_LOOP_MAX_ASSISTANT_STEPS_PER_RUN = 36;
export const AGENT_LOOP_ASSISTANT_STEP_CHECK_IN_AT = 18;

/** Emergency parent-turn ceiling; provider/tool-specific limits remain independent. */
export const PARENT_TURN_MAX_WALL_TIME_MS = 5 * 60_000;

export interface ParentTurnContinuationFuseLimits {
  maxWallTimeMs: number;
  maxPromptEntries: number;
}

export const DEFAULT_PARENT_TURN_CONTINUATION_FUSE_LIMITS:
Readonly<ParentTurnContinuationFuseLimits> = Object.freeze({
  maxWallTimeMs: PARENT_TURN_MAX_WALL_TIME_MS,
  maxPromptEntries: AGENT_LOOP_MAX_ASSISTANT_STEPS_PER_RUN,
});

function requirePositiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function boundedElapsedMs(startedAtMs: number, nowMs: number): number {
  if (!Number.isFinite(nowMs)) return 0;
  return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(nowMs - startedAtMs)));
}

export class ParentTurnContinuationBudgetExceededError extends Error {
  readonly code = 'parent_turn_continuation_budget_exceeded';

  constructor(readonly stop: ParentTurnContinuationStopSnapshot) {
    super(`Parent turn continuation stopped: ${stop.reason}`);
    this.name = 'ParentTurnContinuationBudgetExceededError';
  }
}

/**
 * One process-local fuse for one pi Agent run. It is deliberately not a charge
 * ledger: it only counts prompt entry and captures the first terminal reason.
 */
export class ParentTurnContinuationFuse {
  readonly limits: Readonly<ParentTurnContinuationFuseLimits>;
  readonly startedAtMs: number;
  private promptEntries = 0;
  private stop: ParentTurnContinuationStopSnapshot | null = null;

  constructor(
    limits: Partial<ParentTurnContinuationFuseLimits> = {},
    startedAtMs = Date.now(),
  ) {
    this.limits = Object.freeze({
      maxWallTimeMs: requirePositiveSafeInteger(
        limits.maxWallTimeMs ?? DEFAULT_PARENT_TURN_CONTINUATION_FUSE_LIMITS.maxWallTimeMs,
        'Parent-turn maxWallTimeMs',
      ),
      maxPromptEntries: requirePositiveSafeInteger(
        limits.maxPromptEntries ?? DEFAULT_PARENT_TURN_CONTINUATION_FUSE_LIMITS.maxPromptEntries,
        'Parent-turn maxPromptEntries',
      ),
    });
    if (!Number.isFinite(startedAtMs)) {
      throw new Error('Parent-turn fuse startedAtMs must be finite');
    }
    this.startedAtMs = Math.floor(startedAtMs);
  }

  enterPrompt(nowMs = Date.now()): number {
    if (this.stop) throw new ParentTurnContinuationBudgetExceededError(this.stop);
    if (nowMs - this.startedAtMs >= this.limits.maxWallTimeMs) {
      throw this.tripWallClock(nowMs);
    }
    if (this.promptEntries >= this.limits.maxPromptEntries) {
      throw this.trip('prompt_entry_limit', nowMs);
    }
    this.promptEntries += 1;
    return this.promptEntries;
  }

  tripWallClock(nowMs = Date.now()): ParentTurnContinuationBudgetExceededError {
    return this.trip('wall_clock_limit', nowMs);
  }

  getError(): ParentTurnContinuationBudgetExceededError | null {
    return this.stop ? new ParentTurnContinuationBudgetExceededError(this.stop) : null;
  }

  private trip(
    reason: ParentTurnContinuationStopSnapshot['reason'],
    nowMs: number,
  ): ParentTurnContinuationBudgetExceededError {
    if (!this.stop) {
      this.stop = Object.freeze({
        schemaVersion: 1,
        reason,
        promptEntries: this.promptEntries,
        maxPromptEntries: this.limits.maxPromptEntries,
        elapsedMs: boundedElapsedMs(this.startedAtMs, nowMs),
        maxWallTimeMs: this.limits.maxWallTimeMs,
      });
    }
    return new ParentTurnContinuationBudgetExceededError(this.stop);
  }
}
