import { isRecord } from '../../../shared/utils/types.js';
import {
  toBoolean,
  toCadenceTimezone,
  toLocalTime,
  toPositiveInteger,
  toTimeZone,
} from './primitives.js';

export interface EpisodicProcessingRestWindowConfig {
  enabled: boolean;
  startLocalTime: string;
  endLocalTime: string;
  timeZone: string;
  inactivityThresholdMinutes: number;
}

/**
 * Direct (1:1 / DM) near-turn memory cadence. Preserves the historical
 * per-N-turns posture; `cadenceTurns` is JSON-owned instead of a hardcoded
 * constant.
 */
export interface NearTurnMemoryDirectCadenceConfig {
  cadenceTurns: number;
}

/**
 * Group-scope near-turn memory cadence. Instead of firing every N turns
 * (which in a busy multi-person room is near-continuous background work),
 * group scopes use watermark/interval batching: a run is only eligible once
 * at least `minNewEntries` new conversational turns have accumulated AND at
 * least `minIntervalMinutes` of wall-clock time has elapsed since the last run.
 */
export interface NearTurnMemoryGroupCadenceConfig {
  minIntervalMinutes: number;
  minNewEntries: number;
}

/**
 * Cadence for the lightweight near-turn memory lane (extraction trigger
 * evaluation, active-memory review refresh, concern-candidate derivation).
 * This lane replaces the old turn-based "sleeptime" cadence; heavy passes
 * (sleep consolidation, arc weaving, dream meaning) are scheduler-owned and
 * run only inside the episodicProcessing rest window.
 */
export interface NearTurnMemoryCadenceConfig {
  direct: NearTurnMemoryDirectCadenceConfig;
  group: NearTurnMemoryGroupCadenceConfig;
}

/**
 * Candidate-episode synthesis lane: a resumable changed-session drain plus
 * synthesis tuning knobs. The lane fires at explicit daytime wall-clock slots
 * OR a companion-level turn threshold, whichever comes first.
 */
export interface EpisodeSynthesisLaneConfig {
  /** HH:mm wall-clock slots for the low-cadence daytime drain. */
  daytimeSlots: string[];
  /** Scheduler cadence timezone for every daytime slot. */
  timezone: 'local' | 'utc';
  /** Companion-level turn count that requests a drain before the next slot. */
  turnThreshold: number;
  /** Minimum companion-relevant turns required before synthesis runs. */
  minRelevantTurns: number;
  /** Max session entries considered per synthesis run. */
  transcriptMessageLimit: number;
  /** Max candidate episodes materialized per run. */
  maxEpisodesPerRun: number;
  /** Conversation gap that splits candidate episodes (minutes). */
  gapSplitMinutes: number;
  /** Max session entries folded into one candidate episode. */
  maxEntriesPerEpisode: number;
  /** Salience minimum: conversational entries required for a group to count. */
  minConversationalEntries: number;
  /** Salience minimum: single-entry character floor for one-entry groups. */
  minSingleEntryChars: number;
  /**
   * Contextual topic cutting (E5.4): LLM topic segmentation inside the
   * deterministic chunk bounds, with trailing holdback for unfinished topics.
   * Optional key with an explicit false default so existing operator files
   * keep validating; when false the deterministic cuts are unchanged.
   */
  topicSegmentationEnabled: boolean;
  /**
   * Cap on prior-episode candidates pulled for consolidation/dedup lookups
   * (zet.7). Optional key with an explicit default (24, mirrors
   * DEFAULT_MAX_PRIOR_CANDIDATES in the synthesizer) so existing operator
   * files keep validating.
   */
  maxPriorCandidates: number;
  /** Bounded per-session failure handling for the changed-session drain. */
  sessionFailure: EpisodeSynthesisSessionFailureConfig;
  /**
   * psfn-framework-d5e0p.2: a session below `minRelevantTurns` is held (kept
   * eligible) rather than checkpointed away; once its newest turn is this many
   * minutes old it gets a final synthesis pass, because sessions such as one
   * external conversation or a short DM never grow past the minimum.
   */
  finalPassIdleMinutes: number;
}

/**
 * psfn-framework-d5e0p.3: a session whose synthesis keeps failing must not hold
 * its claim forever. Each failure is recorded on the workset row and the claim
 * waits `retryBaseDelayMinutes * 2^(attempt-1)` before its next retry; after
 * `maxAttempts` consecutive failures the claim is quarantined (checkpoint not
 * advanced, source intact) until newer activity or an operator release.
 */
export interface EpisodeSynthesisSessionFailureConfig {
  maxAttempts: number;
  retryBaseDelayMinutes: number;
}

/**
 * psfn-framework-d5e0p.15: observed group-memory extraction is otherwise only
 * re-attempted when new traffic arrives, so a quiet room's failed range stayed
 * failed forever. A failed range is retried by a timed sweep (every
 * `sweepIntervalMinutes`) once `baseDelayMinutes * 2^(attempt-1)` has elapsed;
 * after `maxAttempts` consecutive failures the timed retries stop and the
 * range raises a standing incident until it succeeds or an operator backfills.
 */
export interface GroupMemoryExtractionFailureRetryConfig {
  maxAttempts: number;
  baseDelayMinutes: number;
  sweepIntervalMinutes: number;
}

export interface GroupMemoryExtractionSchedulerConfig {
  failureRetry: GroupMemoryExtractionFailureRetryConfig;
}

/**
 * Optional block (d5e0p.15): owner files written before timed group-memory
 * retries carry no `groupMemoryExtraction`, so an absent block or key takes the
 * canonical default. Defaults mirror config/scheduler.seed.json — keep in lockstep.
 */
export function validateGroupMemoryExtractionConfig(
  raw: unknown,
  sourcePath: string,
): GroupMemoryExtractionSchedulerConfig {
  const block = raw === undefined ? {} : raw;
  if (!isRecord(block)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: groupMemoryExtraction must be an object`);
  }
  const retry = block.failureRetry === undefined ? {} : block.failureRetry;
  if (!isRecord(retry)) {
    throw new Error(
      `Invalid scheduler config at ${sourcePath}: groupMemoryExtraction.failureRetry must be an object`,
    );
  }
  return {
    failureRetry: {
      maxAttempts: retry.maxAttempts === undefined
        ? 6
        : toPositiveInteger(retry.maxAttempts, 'groupMemoryExtraction.failureRetry.maxAttempts', 1),
      baseDelayMinutes: retry.baseDelayMinutes === undefined
        ? 15
        : toPositiveInteger(retry.baseDelayMinutes, 'groupMemoryExtraction.failureRetry.baseDelayMinutes', 1),
      sweepIntervalMinutes: retry.sweepIntervalMinutes === undefined
        ? 5
        : toPositiveInteger(
          retry.sweepIntervalMinutes,
          'groupMemoryExtraction.failureRetry.sweepIntervalMinutes',
          1,
        ),
    },
  };
}

export function validateEpisodicProcessingConfig(
  raw: unknown,
  sourcePath: string,
): EpisodicProcessingRestWindowConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: episodicProcessing must be an object`);
  }

  return {
    enabled: toBoolean(raw.enabled, 'episodicProcessing.enabled'),
    startLocalTime: toLocalTime(raw.startLocalTime, 'episodicProcessing.startLocalTime'),
    endLocalTime: toLocalTime(raw.endLocalTime, 'episodicProcessing.endLocalTime'),
    timeZone: toTimeZone(raw.timeZone, 'episodicProcessing.timeZone'),
    inactivityThresholdMinutes: toPositiveInteger(
      raw.inactivityThresholdMinutes,
      'episodicProcessing.inactivityThresholdMinutes',
      1,
    ),
  };
}

export function validateNearTurnMemoryConfig(
  raw: unknown,
  sourcePath: string,
): NearTurnMemoryCadenceConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: nearTurnMemory must be an object`);
  }
  if (!isRecord(raw.direct)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: nearTurnMemory.direct must be an object`);
  }
  if (!isRecord(raw.group)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: nearTurnMemory.group must be an object`);
  }

  return {
    direct: {
      cadenceTurns: toPositiveInteger(raw.direct.cadenceTurns, 'nearTurnMemory.direct.cadenceTurns', 1),
    },
    group: {
      minIntervalMinutes: toPositiveInteger(
        raw.group.minIntervalMinutes,
        'nearTurnMemory.group.minIntervalMinutes',
        1,
      ),
      minNewEntries: toPositiveInteger(
        raw.group.minNewEntries,
        'nearTurnMemory.group.minNewEntries',
        1,
      ),
    },
  };
}

/**
 * Canonical daytime cadence seeded into an episodeSynthesis owner block written
 * before `daytimeSlots`/`timezone` existed. Mirrors config/scheduler.seed.json.
 */
export const DEFAULT_EPISODE_SYNTHESIS_CADENCE: Readonly<
  Pick<EpisodeSynthesisLaneConfig, 'daytimeSlots' | 'timezone'>
> = {
  daytimeSlots: ['09:00', '12:00', '15:00', '18:00'],
  timezone: 'local',
};

/**
 * Optional block (d5e0p.3): an owner file written before bounded failure
 * handling carries no `sessionFailure`, so an absent block or key takes the
 * canonical default. Defaults mirror config/scheduler.seed.json
 * `episodeSynthesis.sessionFailure` — keep in lockstep.
 */
function validateEpisodeSynthesisSessionFailure(raw: unknown): EpisodeSynthesisSessionFailureConfig {
  const block = raw === undefined ? {} : raw;
  if (!isRecord(block)) {
    throw new Error('Invalid scheduler config: episodeSynthesis.sessionFailure must be an object');
  }
  return {
    maxAttempts: block.maxAttempts === undefined
      ? 5
      : toPositiveInteger(block.maxAttempts, 'episodeSynthesis.sessionFailure.maxAttempts', 1),
    retryBaseDelayMinutes: block.retryBaseDelayMinutes === undefined
      ? 60
      : toPositiveInteger(
        block.retryBaseDelayMinutes,
        'episodeSynthesis.sessionFailure.retryBaseDelayMinutes',
        1,
      ),
  };
}

export function validateEpisodeSynthesisConfig(
  raw: unknown,
  sourcePath: string,
): EpisodeSynthesisLaneConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: episodeSynthesis must be an object`);
  }
  if (!Array.isArray(raw.daytimeSlots) || raw.daytimeSlots.length === 0) {
    throw new Error('Invalid scheduler config: episodeSynthesis.daytimeSlots must be a non-empty array');
  }
  const daytimeSlots = raw.daytimeSlots.map((value, index) => (
    toLocalTime(value, `episodeSynthesis.daytimeSlots[${index}]`)
  ));
  if (new Set(daytimeSlots).size !== daytimeSlots.length) {
    throw new Error(
      'Invalid scheduler config: episodeSynthesis.daytimeSlots must contain unique HH:mm local times',
    );
  }
  return {
    daytimeSlots,
    timezone: toCadenceTimezone(raw.timezone, 'episodeSynthesis.timezone'),
    turnThreshold: toPositiveInteger(raw.turnThreshold, 'episodeSynthesis.turnThreshold', 1),
    minRelevantTurns: toPositiveInteger(raw.minRelevantTurns, 'episodeSynthesis.minRelevantTurns', 1),
    transcriptMessageLimit: toPositiveInteger(raw.transcriptMessageLimit, 'episodeSynthesis.transcriptMessageLimit', 1),
    maxEpisodesPerRun: toPositiveInteger(raw.maxEpisodesPerRun, 'episodeSynthesis.maxEpisodesPerRun', 1),
    gapSplitMinutes: toPositiveInteger(raw.gapSplitMinutes, 'episodeSynthesis.gapSplitMinutes', 1),
    maxEntriesPerEpisode: toPositiveInteger(raw.maxEntriesPerEpisode, 'episodeSynthesis.maxEntriesPerEpisode', 1),
    minConversationalEntries: toPositiveInteger(
      raw.minConversationalEntries,
      'episodeSynthesis.minConversationalEntries',
      1,
    ),
    minSingleEntryChars: toPositiveInteger(raw.minSingleEntryChars, 'episodeSynthesis.minSingleEntryChars', 1),
    topicSegmentationEnabled: raw.topicSegmentationEnabled === undefined
      ? false
      : toBoolean(raw.topicSegmentationEnabled, 'episodeSynthesis.topicSegmentationEnabled'),
    // zet.7: optional key, default mirrors DEFAULT_MAX_PRIOR_CANDIDATES (24)
    // in src/faculties/memory/episodic/synthesis.ts — keep in lockstep.
    maxPriorCandidates: raw.maxPriorCandidates === undefined
      ? 24
      : toPositiveInteger(raw.maxPriorCandidates, 'episodeSynthesis.maxPriorCandidates', 1),
    sessionFailure: validateEpisodeSynthesisSessionFailure(raw.sessionFailure),
    // d5e0p.2: optional key, default mirrors config/scheduler.seed.json.
    finalPassIdleMinutes: raw.finalPassIdleMinutes === undefined
      ? 180
      : toPositiveInteger(raw.finalPassIdleMinutes, 'episodeSynthesis.finalPassIdleMinutes', 1),
  };
}
