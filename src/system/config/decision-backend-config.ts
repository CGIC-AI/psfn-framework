// settings.json `decisionBackend` (epic psfn-framework-4lf3r).
//
// Selects which backend answers typed decisions: the local background model
// (the default, and the only backend a fully local install ever needs), the
// optional remote Jev model through the OpenRouter Decisions API, or shadow
// mode (both run, the local answer is acted on, and a content-free comparison
// record is written). Per-site entries override the global mode and carry the
// knobs of opt-in sites. An absent block means every site stays local.

import {
  assertNoUnknownKeys,
  isRecord,
} from '../../shared/utils/types.js';

const DECISION_BACKEND_MODES = ['local', 'jev', 'shadow'] as const;
export type DecisionBackendMode = typeof DECISION_BACKEND_MODES[number];

const DECISION_LOCAL_QUESTION_MODES = ['combined', 'per_question'] as const;
export type DecisionLocalQuestionMode = typeof DECISION_LOCAL_QUESTION_MODES[number];

/** Stable decision-site ids. Unknown ids in settings reject (fail closed). */
export const DECISION_SITE_IDS = [
  'participation.appraise',
  // Private companion-to-companion (ICP) reply appraisal. Its state carries
  // private DM history, so it is companion_private and always answers locally.
  'participation.appraise_dm',
  'room.ambiguity',
  'memory.rerank',
  'memory.query_intent',
  'intake.l2',
  'memory.extraction_pregate',
  'intention.post_turn_pregate',
] as const;
export type DecisionSiteId = typeof DECISION_SITE_IDS[number];

/**
 * Knobs an opt-in site must declare before `enabled: true` is accepted. There
 * are no code-side defaults for them: enabling a site is an explicit owner
 * decision that states its own bounds.
 */
const REQUIRED_KNOBS_WHEN_ENABLED: Partial<Record<DecisionSiteId, readonly DecisionSiteKnob[]>> = {
  'room.ambiguity': ['threshold'],
  'memory.rerank': ['topN', 'latencyBudgetMs', 'blendWeight'],
  'memory.query_intent': ['latencyBudgetMs', 'threshold'],
  'intake.l2': ['threshold'],
  'memory.extraction_pregate': ['threshold'],
  'intention.post_turn_pregate': ['threshold'],
};

type DecisionSiteKnob = 'threshold' | 'topN' | 'latencyBudgetMs' | 'blendWeight';

export interface DecisionSiteSettings {
  /** Overrides the global mode for this site. */
  mode?: DecisionBackendMode;
  /** Opt-in sites run only when true. Existing sites ignore it. */
  enabled?: boolean;
  /** Probability threshold in [0, 1] (site-specific meaning). */
  threshold?: number;
  /** Candidate count for batched scoring sites. */
  topN?: number;
  /** Per-call latency budget for on-turn sites. */
  latencyBudgetMs?: number;
  /** Weight in [0, 1] of the decision score when blended with a local score. */
  blendWeight?: number;
}

interface JevDecisionSettings {
  /** Pinned Jev release id, e.g. `typesafe/jev-1.13`. Aliases are rejected. */
  model: string;
  /**
   * Dated snapshot the response `model` must name, e.g.
   * `typesafe/jev-1.13-20260917`. Null accepts any snapshot of `model`.
   * A mismatch is treated as drift and answered locally.
   */
  expectedSnapshot: string | null;
  /** Hard timeout for one Decisions API request. */
  timeoutMs: number;
  /** Upper bound on the serialized state plus questions (the API allows 32k tokens). */
  maxRequestChars: number;
  /**
   * Jev's per-token price and output bound. Every decision call is priced
   * before dispatch at its worst case (request bytes as input tokens plus
   * `maxOutputTokens`), so an aborted or timed-out call is never unknown cost.
   * Null means unpriced: with an enabled model budget the gateway then refuses
   * Jev calls (the site answers locally) rather than risk unknown spend.
   */
  pricing: JevDecisionPricing | null;
}

export interface JevDecisionPricing {
  inputPer1MUsd: number;
  outputPer1MUsd: number;
  /** Worst-case output tokens one decision answer can bill. */
  maxOutputTokens: number;
}

export interface DecisionBackendSettings {
  mode: DecisionBackendMode;
  localQuestionMode: DecisionLocalQuestionMode;
  jev: JevDecisionSettings;
  sites: Partial<Record<DecisionSiteId, DecisionSiteSettings>>;
}

const DECISION_BACKEND_KEYS = ['mode', 'localQuestionMode', 'jev', 'sites'] as const;
const JEV_KEYS = ['model', 'expectedSnapshot', 'timeoutMs', 'maxRequestChars', 'pricing'] as const;
const JEV_PRICING_KEYS = ['inputPer1MUsd', 'outputPer1MUsd', 'maxOutputTokens'] as const;
const SITE_KEYS = ['mode', 'enabled', 'threshold', 'topN', 'latencyBudgetMs', 'blendWeight'] as const;

const DECISION_BACKEND_RANGES = {
  timeoutMs: { min: 50, max: 30_000 },
  maxRequestChars: { min: 1_000, max: 120_000 },
  pricingMaxOutputTokens: { min: 1, max: 32_000 },
  topN: { min: 1, max: 500 },
  latencyBudgetMs: { min: 10, max: 30_000 },
} as const;

/** A pinned Jev release (`typesafe/jev-1.13`) — never `~...` aliases or `latest`. */
const JEV_MODEL_PATTERN = /^typesafe\/jev-\d+\.\d+$/u;
/** A dated snapshot of a pinned release (`typesafe/jev-1.13-20260917`). */
const JEV_SNAPSHOT_PATTERN = /^typesafe\/jev-\d+\.\d+-\d{8}$/u;

export function createDefaultDecisionBackendSettings(): DecisionBackendSettings {
  return {
    mode: 'local',
    localQuestionMode: 'combined',
    jev: {
      model: 'typesafe/jev-1.13',
      expectedSnapshot: null,
      timeoutMs: 1_500,
      maxRequestChars: 96_000,
      pricing: null,
    },
    sites: {},
  };
}

function fail(fieldPath: string, expectation: string): never {
  throw new Error(`Invalid settings at ${fieldPath}: ${expectation}`);
}

function expectEnum<T extends string>(value: unknown, fieldPath: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    fail(fieldPath, `expected one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function expectInteger(value: unknown, fieldPath: string, range: { min: number; max: number }): number {
  if (!Number.isSafeInteger(value) || Number(value) < range.min || Number(value) > range.max) {
    fail(fieldPath, `expected integer ${range.min}-${range.max}`);
  }
  return Number(value);
}

function expectUnitNumber(value: unknown, fieldPath: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    fail(fieldPath, 'expected number 0-1');
  }
  return value;
}

function normalizeJevSettings(value: unknown, fieldPath: string): JevDecisionSettings {
  if (!isRecord(value)) fail(fieldPath, 'expected object');
  assertNoUnknownKeys(value, JEV_KEYS, fieldPath, { errorPrefix: 'Invalid settings' });
  if (typeof value.model !== 'string' || !JEV_MODEL_PATTERN.test(value.model)) {
    fail(`${fieldPath}.model`, 'expected a pinned Jev release id such as typesafe/jev-1.13 (aliases are rejected)');
  }
  let expectedSnapshot: string | null = null;
  if (value.expectedSnapshot !== null && value.expectedSnapshot !== undefined) {
    if (typeof value.expectedSnapshot !== 'string'
      || !JEV_SNAPSHOT_PATTERN.test(value.expectedSnapshot)
      || !value.expectedSnapshot.startsWith(`${value.model}-`)) {
      fail(`${fieldPath}.expectedSnapshot`, `expected a dated snapshot of ${value.model} or null`);
    }
    expectedSnapshot = value.expectedSnapshot;
  }
  return {
    model: value.model,
    expectedSnapshot,
    timeoutMs: expectInteger(value.timeoutMs, `${fieldPath}.timeoutMs`, DECISION_BACKEND_RANGES.timeoutMs),
    maxRequestChars: expectInteger(
      value.maxRequestChars,
      `${fieldPath}.maxRequestChars`,
      DECISION_BACKEND_RANGES.maxRequestChars,
    ),
    pricing: normalizeJevPricing(value.pricing, `${fieldPath}.pricing`),
  };
}

function expectRate(value: unknown, fieldPath: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(fieldPath, 'expected a finite USD rate per million tokens >= 0');
  }
  return value;
}

function normalizeJevPricing(value: unknown, fieldPath: string): JevDecisionPricing | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) fail(fieldPath, 'expected object or null');
  assertNoUnknownKeys(value, JEV_PRICING_KEYS, fieldPath, { errorPrefix: 'Invalid settings' });
  return {
    inputPer1MUsd: expectRate(value.inputPer1MUsd, `${fieldPath}.inputPer1MUsd`),
    outputPer1MUsd: expectRate(value.outputPer1MUsd, `${fieldPath}.outputPer1MUsd`),
    maxOutputTokens: expectInteger(
      value.maxOutputTokens,
      `${fieldPath}.maxOutputTokens`,
      DECISION_BACKEND_RANGES.pricingMaxOutputTokens,
    ),
  };
}

function normalizeSiteSettings(siteId: DecisionSiteId, value: unknown, fieldPath: string): DecisionSiteSettings {
  if (!isRecord(value)) fail(fieldPath, 'expected object');
  assertNoUnknownKeys(value, SITE_KEYS, fieldPath, { errorPrefix: 'Invalid settings' });
  const site: DecisionSiteSettings = {};
  if (value.mode !== undefined) site.mode = expectEnum(value.mode, `${fieldPath}.mode`, DECISION_BACKEND_MODES);
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== 'boolean') fail(`${fieldPath}.enabled`, 'expected boolean');
    site.enabled = value.enabled;
  }
  if (value.threshold !== undefined) site.threshold = expectUnitNumber(value.threshold, `${fieldPath}.threshold`);
  if (value.blendWeight !== undefined) site.blendWeight = expectUnitNumber(value.blendWeight, `${fieldPath}.blendWeight`);
  if (value.topN !== undefined) site.topN = expectInteger(value.topN, `${fieldPath}.topN`, DECISION_BACKEND_RANGES.topN);
  if (value.latencyBudgetMs !== undefined) {
    site.latencyBudgetMs = expectInteger(
      value.latencyBudgetMs,
      `${fieldPath}.latencyBudgetMs`,
      DECISION_BACKEND_RANGES.latencyBudgetMs,
    );
  }
  if (site.enabled === true) {
    for (const knob of REQUIRED_KNOBS_WHEN_ENABLED[siteId] ?? []) {
      if (site[knob] === undefined) fail(`${fieldPath}.${knob}`, 'required when enabled is true');
    }
  }
  return site;
}

export function normalizeDecisionBackendSettings(
  value: unknown,
  fieldPath = 'decisionBackend',
): DecisionBackendSettings {
  if (!isRecord(value)) fail(fieldPath, 'expected object');
  assertNoUnknownKeys(value, DECISION_BACKEND_KEYS, fieldPath, { errorPrefix: 'Invalid settings' });
  const sitesRaw = value.sites ?? {};
  if (!isRecord(sitesRaw)) fail(`${fieldPath}.sites`, 'expected object');
  const sites: Partial<Record<DecisionSiteId, DecisionSiteSettings>> = {};
  for (const [siteId, siteValue] of Object.entries(sitesRaw)) {
    const known = expectEnum(siteId, `${fieldPath}.sites.${siteId}`, DECISION_SITE_IDS);
    sites[known] = normalizeSiteSettings(known, siteValue, `${fieldPath}.sites.${siteId}`);
  }
  return {
    mode: expectEnum(value.mode, `${fieldPath}.mode`, DECISION_BACKEND_MODES),
    localQuestionMode: expectEnum(
      value.localQuestionMode,
      `${fieldPath}.localQuestionMode`,
      DECISION_LOCAL_QUESTION_MODES,
    ),
    jev: normalizeJevSettings(value.jev, `${fieldPath}.jev`),
    sites,
  };
}

/** Configured mode for a site: the per-site override wins over the global mode. */
export function resolveDecisionSiteMode(
  settings: DecisionBackendSettings | undefined,
  siteId: DecisionSiteId,
): DecisionBackendMode {
  if (!settings) return 'local';
  return settings.sites[siteId]?.mode ?? settings.mode;
}
