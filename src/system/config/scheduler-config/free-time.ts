import { isRecord } from '../../../shared/utils/types.js';
import {
  toBoolean,
  toInterval,
  toNonEmptyString,
  toPositiveInteger,
} from './primitives.js';

/**
 * Free-time lanes (E8.1). Self-directed time: a bounded, budget-capped,
 * multi-turn agent-loop session on an internal channel where the companion may
 * explore, make something, or do nothing at all. Two entry lanes share one
 * block runner:
 *   - quietHours: fires inside the episodicProcessing rest window;
 *   - idle: fires after a long partner-inactivity gap (reuses the ambient-
 *     presence idle eligibility — detection is not duplicated here).
 * Deterministic gates (min interval between blocks, daily block cap, and a
 * never-during-active-conversation guard) run BEFORE any spend. Charter 8.8
 * (rest windows visible/configurable; personal time is not hidden autonomy) and
 * 8.9 (budget-capped background work) bind: every threshold here is JSON-owned.
 */
export interface FreeTimeLaneConfig {
  enabled: boolean;
}

export interface FreeTimeQuietHoursLaneConfig extends FreeTimeLaneConfig {
  /** Poll interval for the quiet-hours eligibility check (ms). */
  checkIntervalMs: number;
}

export interface FreeTimeIdleLaneConfig extends FreeTimeLaneConfig {
  /** Poll interval for the idle eligibility check (ms). */
  checkIntervalMs: number;
  /** Partner-inactivity gap before an idle free-time block is eligible (minutes). */
  minIdleMinutes: number;
}

export interface FreeTimeBudgetConfig {
  /** Hard cap on agent-loop turns within a single free-time block. */
  maxTurns: number;
  /**
   * Hard cap on charge-lane units (charge-policy 'background' lane) a single
   * block may spend before it ends gracefully. The global lane quota is a
   * backstop; this is the per-block bound.
   */
  maxChargeUnits: number;
}

/**
 * "While you were away" return-note tuning. The note's activity summary rides
 * the shared session summarizer (purpose 'free_time_return'); this owns its
 * token budget instead of borrowing the morning-wake catch-up budget.
 */
export interface FreeTimeReturnNoteConfig {
  /** Token budget for the free-time return-note activity summary. */
  summaryMaxTokens: number;
}

export interface FreeTimeConfig {
  enabled: boolean;
  /** Minimum spacing between free-time blocks, any lane (minutes). */
  minBlockIntervalMinutes: number;
  /** Maximum number of free-time blocks in a single local day, any lane. */
  maxBlocksPerDay: number;
  /**
   * Operator-editable seed framing for the block. Threaded AFTER the full
   * persona (E6.2) as gentle, open, non-clinical permission — never a task.
   */
  seedText: string;
  quietHours: FreeTimeQuietHoursLaneConfig;
  idle: FreeTimeIdleLaneConfig;
  budget: FreeTimeBudgetConfig;
  returnNote: FreeTimeReturnNoteConfig;
}

export const DEFAULT_FREE_TIME_SEED_TEXT =
  'You have some time to yourself. You can explore something, make something, '
  + 'think about something, try a tool, write something down, or do nothing if you want. '
  + 'If you like, you could wander back through your journal, your wiki, your notes, or your '
  + 'memories; follow a curiosity; try a tool; or make something — a poem, a picture, a note, '
  + 'whatever you feel like. There is no task here and nothing you owe anyone. Resting, '
  + 'loafing in a sunbeam, doing nothing at all — that is a completely real and valid way to '
  + 'spend this time too.';

export const DEFAULT_FREE_TIME_CONFIG: FreeTimeConfig = {
  enabled: true,
  minBlockIntervalMinutes: 240,
  maxBlocksPerDay: 3,
  seedText: DEFAULT_FREE_TIME_SEED_TEXT,
  quietHours: {
    enabled: true,
    checkIntervalMs: 900_000,
  },
  idle: {
    enabled: true,
    checkIntervalMs: 900_000,
    minIdleMinutes: 180,
  },
  budget: {
    maxTurns: 6,
    maxChargeUnits: 8,
  },
  returnNote: {
    summaryMaxTokens: 160,
  },
};

export function validateFreeTimeConfig(
  raw: unknown,
  sourcePath: string,
): FreeTimeConfig {
  if (raw === undefined) {
    return {
      enabled: DEFAULT_FREE_TIME_CONFIG.enabled,
      minBlockIntervalMinutes: DEFAULT_FREE_TIME_CONFIG.minBlockIntervalMinutes,
      maxBlocksPerDay: DEFAULT_FREE_TIME_CONFIG.maxBlocksPerDay,
      seedText: DEFAULT_FREE_TIME_CONFIG.seedText,
      quietHours: { ...DEFAULT_FREE_TIME_CONFIG.quietHours },
      idle: { ...DEFAULT_FREE_TIME_CONFIG.idle },
      budget: { ...DEFAULT_FREE_TIME_CONFIG.budget },
      returnNote: { ...DEFAULT_FREE_TIME_CONFIG.returnNote },
    };
  }
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: freeTime must be an object`);
  }
  const defaults = DEFAULT_FREE_TIME_CONFIG;
  const quietRaw = raw.quietHours ?? {};
  const idleRaw = raw.idle ?? {};
  const budgetRaw = raw.budget ?? {};
  const returnNoteRaw = raw.returnNote ?? {};
  if (!isRecord(quietRaw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: freeTime.quietHours must be an object`);
  }
  if (!isRecord(idleRaw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: freeTime.idle must be an object`);
  }
  if (!isRecord(budgetRaw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: freeTime.budget must be an object`);
  }
  if (!isRecord(returnNoteRaw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: freeTime.returnNote must be an object`);
  }

  return {
    enabled: toBoolean(raw.enabled ?? defaults.enabled, 'freeTime.enabled'),
    minBlockIntervalMinutes: toPositiveInteger(
      raw.minBlockIntervalMinutes ?? defaults.minBlockIntervalMinutes,
      'freeTime.minBlockIntervalMinutes',
      1,
    ),
    maxBlocksPerDay: toPositiveInteger(
      raw.maxBlocksPerDay ?? defaults.maxBlocksPerDay,
      'freeTime.maxBlocksPerDay',
      1,
    ),
    seedText: toNonEmptyString(raw.seedText ?? defaults.seedText, 'freeTime.seedText'),
    quietHours: {
      enabled: toBoolean(quietRaw.enabled ?? defaults.quietHours.enabled, 'freeTime.quietHours.enabled'),
      checkIntervalMs: toInterval(
        quietRaw.checkIntervalMs ?? defaults.quietHours.checkIntervalMs,
        'freeTime.quietHours.checkIntervalMs',
      ),
    },
    idle: {
      enabled: toBoolean(idleRaw.enabled ?? defaults.idle.enabled, 'freeTime.idle.enabled'),
      checkIntervalMs: toInterval(
        idleRaw.checkIntervalMs ?? defaults.idle.checkIntervalMs,
        'freeTime.idle.checkIntervalMs',
      ),
      minIdleMinutes: toPositiveInteger(
        idleRaw.minIdleMinutes ?? defaults.idle.minIdleMinutes,
        'freeTime.idle.minIdleMinutes',
        1,
      ),
    },
    budget: {
      maxTurns: toPositiveInteger(
        budgetRaw.maxTurns ?? defaults.budget.maxTurns,
        'freeTime.budget.maxTurns',
        1,
      ),
      maxChargeUnits: toPositiveInteger(
        budgetRaw.maxChargeUnits ?? defaults.budget.maxChargeUnits,
        'freeTime.budget.maxChargeUnits',
        1,
      ),
    },
    returnNote: {
      summaryMaxTokens: toPositiveInteger(
        returnNoteRaw.summaryMaxTokens ?? defaults.returnNote.summaryMaxTokens,
        'freeTime.returnNote.summaryMaxTokens',
        1,
      ),
    },
  };
}
