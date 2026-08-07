import { isRecord } from '../../../shared/utils/types.js';
import {
  toBoolean,
  toPositiveInteger,
  toUnitInterval,
} from './primitives.js';

/**
 * Nightly sleep-cycle episode consolidation tuning (rest-window scheduler
 * lane only).
 */
export interface SleepConsolidationConfig {
  /** How far back the deterministic nightly pass reviews episodes (days). */
  reviewWindowDays: number;
  /** How far back the bounded LLM cleanup reviews episodes (hours). */
  refinementWindowHours: number;
  /** Same-scope episodes closer than this are one sitting and merge (minutes). */
  adjacencyGapMinutes: number;
  /** Cap on LLM refinement calls per run. */
  maxRefinementsPerRun: number;
  /**
   * Cap on multi-candidate clusters sent through LLM thematic-grouping
   * consolidation per run. Deterministic singleton confirmations are free
   * and are not bounded by this.
   */
  maxConsolidationsPerRun: number;
  /**
   * Messages pulled per episode transcript during consolidation (zet.7).
   * Optional key with an explicit default (200, mirrors
   * DEFAULT_TRANSCRIPT_MESSAGE_LIMIT in the consolidator) so existing
   * operator files keep validating.
   */
  transcriptMessageLimit: number;
  /**
   * Per-episode transcript character cap during consolidation (zet.7).
   * Optional key with an explicit default (6000, mirrors
   * DEFAULT_MAX_TRANSCRIPT_CHARS in the consolidator) so existing
   * operator files keep validating.
   */
  maxTranscriptCharsPerEpisode: number;
}

/**
 * Deterministic gate for the nightly core-memory orientation-block rewrite
 * (jpvd.4). The orient rewrite is the heaviest nightly sleeptime LLM pass; it
 * must not fire on quiet nights when nothing has changed since the last
 * rewrite. Skipping is the common case — the gate opens only on evidence of
 * change. Rest-window scheduler lane only.
 */
export interface OrientationRewriteGateConfig {
  /**
   * New conversational turns since the last rewrite required to reorient.
   * Below this (and not stale-with-activity) the rewrite is skipped with zero
   * LLM spend.
   */
  minNewEntriesSinceRewrite: number;
  /**
   * Days since the last rewrite after which any new activity (>= 1 new turn)
   * re-opens the gate, so orientation still refreshes periodically in
   * low-volume relationships without rewriting from an empty transcript.
   */
  refreshAfterQuietDays: number;
}

export const DEFAULT_ORIENTATION_REWRITE_GATE: OrientationRewriteGateConfig = {
  minNewEntriesSinceRewrite: 4,
  refreshAfterQuietDays: 7,
};

/**
 * Deterministic novelty gate for cadence-fired reflection templates
 * (jpvd.4). A scheduled reflection must not fire when nothing new happened in
 * its scope since the last reflection run of that template — the gate skips
 * the run with zero LLM spend and typed telemetry. Manual run_template
 * invocations bypass the gate: an explicit operator/model request is its own
 * justification.
 */
export interface ReflectionNoveltyGateConfig {
  /**
   * New scope entries (user/assistant session messages) since the template's
   * last reflection required for a cadence-fired run to proceed. Below this
   * the run is skipped with telemetry.
   */
  minNewEntries: number;
}

export const DEFAULT_REFLECTION_NOVELTY_GATE: ReflectionNoveltyGateConfig = {
  minNewEntries: 1,
};

/**
 * Sleeptime wiki update pass (E8.2). A nightly rest-window lane that reviews the
 * day's newly-canonical episodes and notable durable memories for non-private
 * world knowledge worth creating/updating wiki entries. A deterministic gate
 * skips the pass with zero LLM spend on days that produced nothing wiki-shaped.
 * Optional block — conservative defaults apply when absent. Rest-window
 * scheduler lane only.
 */
export interface SleeptimeWikiPassConfig {
  enabled: boolean;
  /** How far back the pass looks for new canonical episodes / durable memories (hours). */
  reviewWindowHours: number;
  /** Gate: new canonical episodes since the watermark required to open the pass. */
  minNewCanonicalEpisodes: number;
  /** Gate: new durable (semantic/procedural) memories since the watermark required to open the pass. */
  minNewDurableMemories: number;
  /** Cap on wiki entries created/updated per run. */
  maxEntriesPerRun: number;
  /** Cap on canonical episodes fed into the proposal prompt. */
  maxSourceEpisodes: number;
  /** Cap on durable memories fed into the proposal prompt. */
  maxSourceMemories: number;
}

export const DEFAULT_SLEEPTIME_WIKI_PASS: SleeptimeWikiPassConfig = {
  enabled: true,
  reviewWindowHours: 36,
  minNewCanonicalEpisodes: 1,
  minNewDurableMemories: 3,
  maxEntriesPerRun: 3,
  maxSourceEpisodes: 12,
  maxSourceMemories: 30,
};

/**
 * Cross-day arc weaving tuning (rest-window scheduler lane only).
 */
export interface ArcFormationConfig {
  /** Minimum time between arc-formation passes (days). */
  passIntervalDays: number;
  /** How far back the pass looks for related episodes (days). */
  reviewWindowDays: number;
  /** Confidence floor below which proposed arcs are rejected (0..1). */
  minConfidence: number;
  /** Cap on arcs written per pass. */
  maxArcsPerRun: number;
  /** Cap on canonical episodes included in the LLM judgment prompt. */
  maxEpisodesPerRun: number;
}

export function validateSleepConsolidationConfig(
  raw: unknown,
  sourcePath: string,
): SleepConsolidationConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: sleepConsolidation must be an object`);
  }
  return {
    reviewWindowDays: toPositiveInteger(raw.reviewWindowDays, 'sleepConsolidation.reviewWindowDays', 1),
    refinementWindowHours: toPositiveInteger(raw.refinementWindowHours, 'sleepConsolidation.refinementWindowHours', 1),
    adjacencyGapMinutes: toPositiveInteger(raw.adjacencyGapMinutes, 'sleepConsolidation.adjacencyGapMinutes', 1),
    maxRefinementsPerRun: toPositiveInteger(raw.maxRefinementsPerRun, 'sleepConsolidation.maxRefinementsPerRun', 1),
    maxConsolidationsPerRun: toPositiveInteger(
      raw.maxConsolidationsPerRun,
      'sleepConsolidation.maxConsolidationsPerRun',
      1,
    ),
    // zet.7: optional keys, defaults mirror DEFAULT_TRANSCRIPT_MESSAGE_LIMIT
    // (200) and DEFAULT_MAX_TRANSCRIPT_CHARS (6000) in
    // src/faculties/memory/episodic/sleep-consolidation.ts — keep in lockstep.
    transcriptMessageLimit: raw.transcriptMessageLimit === undefined
      ? 200
      : toPositiveInteger(raw.transcriptMessageLimit, 'sleepConsolidation.transcriptMessageLimit', 1),
    maxTranscriptCharsPerEpisode: raw.maxTranscriptCharsPerEpisode === undefined
      ? 6000
      : toPositiveInteger(raw.maxTranscriptCharsPerEpisode, 'sleepConsolidation.maxTranscriptCharsPerEpisode', 1),
  };
}

export function validateOrientationRewriteGateConfig(
  raw: unknown,
  sourcePath: string,
): OrientationRewriteGateConfig {
  if (raw === undefined) {
    return { ...DEFAULT_ORIENTATION_REWRITE_GATE };
  }
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: orientationRewrite must be an object`);
  }
  return {
    minNewEntriesSinceRewrite: toPositiveInteger(
      raw.minNewEntriesSinceRewrite ?? DEFAULT_ORIENTATION_REWRITE_GATE.minNewEntriesSinceRewrite,
      'orientationRewrite.minNewEntriesSinceRewrite',
      1,
    ),
    refreshAfterQuietDays: toPositiveInteger(
      raw.refreshAfterQuietDays ?? DEFAULT_ORIENTATION_REWRITE_GATE.refreshAfterQuietDays,
      'orientationRewrite.refreshAfterQuietDays',
      1,
    ),
  };
}

export function validateReflectionNoveltyGateConfig(
  raw: unknown,
  sourcePath: string,
): ReflectionNoveltyGateConfig {
  if (raw === undefined) {
    return { ...DEFAULT_REFLECTION_NOVELTY_GATE };
  }
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: reflectionNovelty must be an object`);
  }
  return {
    minNewEntries: toPositiveInteger(
      raw.minNewEntries ?? DEFAULT_REFLECTION_NOVELTY_GATE.minNewEntries,
      'reflectionNovelty.minNewEntries',
      1,
    ),
  };
}

export function validateSleeptimeWikiPassConfig(
  raw: unknown,
  sourcePath: string,
): SleeptimeWikiPassConfig {
  if (raw === undefined) {
    return { ...DEFAULT_SLEEPTIME_WIKI_PASS };
  }
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: wikiPass must be an object`);
  }
  return {
    enabled: toBoolean(raw.enabled ?? DEFAULT_SLEEPTIME_WIKI_PASS.enabled, 'wikiPass.enabled'),
    reviewWindowHours: toPositiveInteger(
      raw.reviewWindowHours ?? DEFAULT_SLEEPTIME_WIKI_PASS.reviewWindowHours,
      'wikiPass.reviewWindowHours',
      1,
    ),
    minNewCanonicalEpisodes: toPositiveInteger(
      raw.minNewCanonicalEpisodes ?? DEFAULT_SLEEPTIME_WIKI_PASS.minNewCanonicalEpisodes,
      'wikiPass.minNewCanonicalEpisodes',
      1,
    ),
    minNewDurableMemories: toPositiveInteger(
      raw.minNewDurableMemories ?? DEFAULT_SLEEPTIME_WIKI_PASS.minNewDurableMemories,
      'wikiPass.minNewDurableMemories',
      1,
    ),
    maxEntriesPerRun: toPositiveInteger(
      raw.maxEntriesPerRun ?? DEFAULT_SLEEPTIME_WIKI_PASS.maxEntriesPerRun,
      'wikiPass.maxEntriesPerRun',
      1,
    ),
    maxSourceEpisodes: toPositiveInteger(
      raw.maxSourceEpisodes ?? DEFAULT_SLEEPTIME_WIKI_PASS.maxSourceEpisodes,
      'wikiPass.maxSourceEpisodes',
      1,
    ),
    maxSourceMemories: toPositiveInteger(
      raw.maxSourceMemories ?? DEFAULT_SLEEPTIME_WIKI_PASS.maxSourceMemories,
      'wikiPass.maxSourceMemories',
      1,
    ),
  };
}

export function validateArcFormationConfig(
  raw: unknown,
  sourcePath: string,
): ArcFormationConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: arcFormation must be an object`);
  }
  return {
    passIntervalDays: toPositiveInteger(raw.passIntervalDays, 'arcFormation.passIntervalDays', 1),
    reviewWindowDays: toPositiveInteger(raw.reviewWindowDays, 'arcFormation.reviewWindowDays', 1),
    minConfidence: toUnitInterval(raw.minConfidence, 'arcFormation.minConfidence'),
    maxArcsPerRun: toPositiveInteger(raw.maxArcsPerRun, 'arcFormation.maxArcsPerRun', 1),
    maxEpisodesPerRun: toPositiveInteger(raw.maxEpisodesPerRun, 'arcFormation.maxEpisodesPerRun', 1),
  };
}
