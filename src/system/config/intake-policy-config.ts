// ── Intake policy owner file (htm9.1) ──
//
// Canonical mutable config for the cognition intake firewall. Follows the
// standard owner-file pattern (see trust-policy-config.ts): strict fail-closed
// validation, loadRequiredJson with seed-example guidance, atomic saves.
// The firewall epic (htm9.2+) grows this file; keep additions schema-owned.

import { join } from 'node:path';
import {
  INTAKE_RISK_LABELS,
  INTAKE_SINKS,
  INTAKE_SOURCE_CLASSES,
  INTAKE_SOURCE_RISK_TIERS,
  isIntakeRiskLabel,
  isIntakeSourceRiskTier,
  type IntakeRiskLabel,
  type IntakeSink,
  type IntakeSourceClass,
  type IntakeSourceRiskTier,
} from '../../shared/contracts/intake-envelope.js';
import { loadRequiredJson } from './load-or-seed.js';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import { isRecord } from '../../shared/utils/types.js';

export const INTAKE_POLICY_FILE_NAME = 'intake-policy.json';
export const INTAKE_POLICY_SEED_FILE_NAME = 'intake-policy.seed.json';

/**
 * Firewall rollout mode:
 * - 'off': no envelope screening decisions are enforced anywhere.
 * - 'shadow': envelopes are created, screened, and journaled, but sink gates
 *   do not block (observe-only rollout posture).
 * - 'enforce': sink gates enforce envelope decisions.
 */
export const INTAKE_FIREWALL_MODES = ['off', 'shadow', 'enforce'] as const;
export type IntakeFirewallMode = typeof INTAKE_FIREWALL_MODES[number];

export interface IntakePolicyQuarantineConfig {
  /** Hours before a quarantined item auto-transitions to 'expired'. */
  itemTtlHours: number;
  /** Maximum quarantined items held before the oldest expire early. */
  maxHeldItems: number;
}

/**
 * Thresholds for the L1.5 ONNX prompt-injection classifier (htm9.5,
 * src/boundary/gateway/intake/injection-classifier.ts). The classifier emits
 * a calibrated 0-1 score into `envelope.scores`; these thresholds tell the
 * DECISION layers (htm9.2/9.3) when that score counts as a screening signal.
 * The score never hard-blocks alone — it is one weighted input (known
 * over-defense / false-positive behavior, InjecGuard arXiv 2410.22770).
 */
export interface IntakeInjectionClassifierPolicyConfig {
  /** Probability at/above which the classifier attaches its `injection/*` risk label. */
  labelThreshold: number;
  /**
   * Per-source-risk-tier score threshold for screening policy. Riskier tiers
   * get lower thresholds (more sensitive screening). Every tier must be
   * mapped explicitly — no implicit defaults.
   */
  scoreThresholdsByTier: Record<IntakeSourceRiskTier, number>;
}

/**
 * Fail-closed action for the L2 API screener (htm9.6) when its call
 * errors/times out. `quarantine` holds the item (high-risk sources);
 * `l1_labels_only` keeps the deterministic L1/L1.5 findings and drops the L2
 * contribution (trusted sources). There is no silent-pass option — every tier
 * must map to one of these.
 */
export const INTAKE_L2_FAIL_CLOSED_ACTIONS = ['quarantine', 'l1_labels_only'] as const;
export type IntakeL2FailClosedAction = typeof INTAKE_L2_FAIL_CLOSED_ACTIONS[number];

export function isIntakeL2FailClosedAction(value: unknown): value is IntakeL2FailClosedAction {
  return typeof value === 'string'
    && (INTAKE_L2_FAIL_CLOSED_ACTIONS as readonly string[]).includes(value);
}

/**
 * Escalation and fail-closed policy for the L2 fast API LLM screener (htm9.6,
 * src/boundary/gateway/intake/l2-screener.ts). The L2 screener is a tool-less
 * OpenRouter call (dual-LLM discipline) reached ONLY when a cheaper L1/L1.5
 * signal crosses the per-tier escalation threshold (or the tier is mandatory).
 * Below-threshold trusted-tier items skip L2 entirely — the fast path must not
 * pay this latency.
 *
 * Model choice is config, never hardcoded: pick a fast, cheap model (Gemini
 * Flash-Lite / Gemma / Qwen ~27B class, under ~50-100B); speed is the gating
 * criterion.
 */
export interface IntakeL2ScreenerPolicyConfig {
  /** OpenRouter model slug for the L2 screener (e.g. 'google/gemini-2.5-flash-lite'). */
  model: string;
  /**
   * Per-source-risk-tier prior-score threshold (max of L1/L1.5 scores) at/above
   * which an item escalates to the L2 API screener. Every tier must be mapped
   * explicitly — no implicit defaults.
   */
  escalationThresholdsByTier: Record<IntakeSourceRiskTier, number>;
  /**
   * Tiers that ALWAYS escalate to L2 regardless of prior score (mandatory deep
   * screening for the riskiest surfaces).
   */
  mandatoryTiers: IntakeSourceRiskTier[];
  /**
   * Per-tier fail-closed action when the L2 API errors/times out. High-risk
   * tiers should quarantine; trusted tiers fall back to L1 labels only. Every
   * tier must be mapped explicitly; never silent-pass.
   */
  failClosedActionByTier: Record<IntakeSourceRiskTier, IntakeL2FailClosedAction>;
  /** Per-call timeout for the L2 API screener, in milliseconds. */
  timeoutMs: number;
  /** Max characters of untrusted content sent to the L2 screener (input cap). */
  maxContentChars: number;
}

/**
 * Escalation and verdict policy for the L3 HEAVY escalation screener (htm9.7,
 * src/boundary/gateway/intake/l3-screener.ts). L3 is the deep second/third
 * pass for items the L2 screener flags — or for high-risk source tiers that
 * mandate deep screening regardless of L2's verdict. It is reached rarely and
 * may be slow: model choice is a larger open model (GLM / Kimi / MiniMax /
 * heavy Gemma / GPT-mini class), never hardcoded.
 *
 * There is NO per-tier fail-closed action for L3: anything that reached L3 is
 * already suspect, so an L3 failure always holds the item in quarantine
 * (enforce mode) — never a silent pass.
 */
export interface IntakeL3ScreenerPolicyConfig {
  /** OpenRouter model slug for the primary L3 verdict (e.g. 'z-ai/glm-4.5-air'). */
  model: string;
  /**
   * Dual-vs-single verdict knob. Default single (false): one heavy model.
   * When true, TWO different models each produce an independent verdict and
   * the aggregate flags if EITHER flags (fail-closed aggregation). Measure
   * single-model quality before enabling dual.
   */
  dualModel: boolean;
  /**
   * Second, DIFFERENT model for dual-verdict mode. Must be null when unused;
   * required (and distinct from `model`) when `dualModel` is true.
   */
  secondaryModel: string | null;
  /**
   * Per-source-risk-tier L2 injection-confidence threshold at/above which an
   * L2-classified item escalates to L3 even without a flagged risk label.
   * Every tier must be mapped explicitly — no implicit defaults.
   */
  escalationConfidenceThresholdsByTier: Record<IntakeSourceRiskTier, number>;
  /**
   * Tiers that ALWAYS escalate to L3 (mandatory deep screening for the
   * riskiest surfaces), regardless of the L2 verdict.
   */
  mandatoryTiers: IntakeSourceRiskTier[];
  /** Per-call timeout for one L3 model call, in milliseconds. */
  timeoutMs: number;
  /** Max characters of untrusted content sent to the L3 screener (input cap). */
  maxContentChars: number;
  /** Max completion tokens for one L3 verdict (output cap). */
  maxOutputTokens: number;
}

/**
 * Enforce-mode action for content that reaches a gated sink WITHOUT an
 * envelope (legacy/unscreened paths). Shadow mode never blocks regardless;
 * this default only bites in enforce mode. Every sink must map to one of
 * these explicitly — there is no implicit fail-open.
 */
export const INTAKE_UNSCREENED_SINK_ACTIONS = ['allow', 'deny'] as const;
export type IntakeUnscreenedSinkAction = typeof INTAKE_UNSCREENED_SINK_ACTIONS[number];

export function isIntakeUnscreenedSinkAction(value: unknown): value is IntakeUnscreenedSinkAction {
  return typeof value === 'string'
    && (INTAKE_UNSCREENED_SINK_ACTIONS as readonly string[]).includes(value);
}

/**
 * Lethal-trifecta enforcement strength (htm9.3): when untrusted content,
 * private data, and egress meet in one uncontrolled path, 'hard' denies the
 * egress outright (public/untrusted sources) while 'soft' allows it but
 * flags the invocation for operator review (trusted sources —
 * release-prompt/review posture, never a silent pass).
 */
export const INTAKE_TRIFECTA_ENFORCEMENTS = ['hard', 'soft'] as const;
export type IntakeTrifectaEnforcement = typeof INTAKE_TRIFECTA_ENFORCEMENTS[number];

export function isIntakeTrifectaEnforcement(value: unknown): value is IntakeTrifectaEnforcement {
  return typeof value === 'string'
    && (INTAKE_TRIFECTA_ENFORCEMENTS as readonly string[]).includes(value);
}

/**
 * Per-sink gate rule. `maxSourceRiskTier` encodes the inform-vs-instruct
 * structural rule: content whose source risk tier exceeds the sink's cap may
 * never drive that sink (state-mutation sinks cap lower than inform sinks).
 * `denyRiskLabels` refuses specific screening findings at this sink even for
 * released content. `unscreened` is the explicit enforce-mode default for
 * non-enveloped content.
 */
export interface IntakeSinkRuleConfig {
  maxSourceRiskTier: IntakeSourceRiskTier;
  denyRiskLabels: IntakeRiskLabel[];
  unscreened: IntakeUnscreenedSinkAction;
}

export interface IntakeSinkGatesPolicyConfig {
  /** Every consequential sink must be mapped explicitly — no implicit defaults. */
  sinks: Record<IntakeSink, IntakeSinkRuleConfig>;
  trifecta: {
    /** Trifecta enforcement strength per source risk tier of the untrusted content. */
    enforcementByTier: Record<IntakeSourceRiskTier, IntakeTrifectaEnforcement>;
  };
}

export interface IntakePolicyConfig {
  schemaVersion: 1;
  mode: IntakeFirewallMode;
  /**
   * Risk tier per source class. Every class must be mapped explicitly —
   * the contract carries no defaults, so an unmapped class fails startup
   * instead of silently trusting a new surface.
   */
  sourceRiskTiers: Record<IntakeSourceClass, IntakeSourceRiskTier>;
  quarantine: IntakePolicyQuarantineConfig;
  injectionClassifier: IntakeInjectionClassifierPolicyConfig;
  l2Screener: IntakeL2ScreenerPolicyConfig;
  l3Screener: IntakeL3ScreenerPolicyConfig;
  sinkGates: IntakeSinkGatesPolicyConfig;
}

interface IntakePolicyLoadOptions {
  seedDir?: string;
}

function invalid(sourcePath: string, detail: string): Error {
  return new Error(`Invalid intake policy at ${sourcePath}: ${detail}`);
}

function validateSourceRiskTiers(
  raw: unknown,
  sourcePath: string,
): Record<IntakeSourceClass, IntakeSourceRiskTier> {
  if (!isRecord(raw)) {
    throw invalid(sourcePath, 'sourceRiskTiers must be an object');
  }
  const unknownKeys = Object.keys(raw)
    .filter((key) => !(INTAKE_SOURCE_CLASSES as readonly string[]).includes(key));
  if (unknownKeys.length > 0) {
    throw invalid(sourcePath, `sourceRiskTiers has unsupported source classes: ${unknownKeys.join(', ')}`);
  }
  const tiers = {} as Record<IntakeSourceClass, IntakeSourceRiskTier>;
  for (const sourceClass of INTAKE_SOURCE_CLASSES) {
    const tier = raw[sourceClass];
    if (tier === undefined) {
      throw invalid(sourcePath, `sourceRiskTiers.${sourceClass} is required (no implicit tier defaults)`);
    }
    if (!isIntakeSourceRiskTier(tier)) {
      throw invalid(
        sourcePath,
        `sourceRiskTiers.${sourceClass} must be one of: ${INTAKE_SOURCE_RISK_TIERS.join(', ')}`,
      );
    }
    tiers[sourceClass] = tier;
  }
  return tiers;
}

function validatePositiveInteger(value: unknown, sourcePath: string, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw invalid(sourcePath, `${field} must be an integer >= 1`);
  }
  return value;
}

function validateQuarantine(raw: unknown, sourcePath: string): IntakePolicyQuarantineConfig {
  if (!isRecord(raw)) {
    throw invalid(sourcePath, 'quarantine must be an object');
  }
  const unknownKeys = Object.keys(raw)
    .filter((key) => !['itemTtlHours', 'maxHeldItems'].includes(key));
  if (unknownKeys.length > 0) {
    throw invalid(sourcePath, `quarantine has unsupported keys: ${unknownKeys.join(', ')}`);
  }
  return {
    itemTtlHours: validatePositiveInteger(raw.itemTtlHours, sourcePath, 'quarantine.itemTtlHours'),
    maxHeldItems: validatePositiveInteger(raw.maxHeldItems, sourcePath, 'quarantine.maxHeldItems'),
  };
}

function validateProbability(value: unknown, sourcePath: string, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw invalid(sourcePath, `${field} must be a finite number in [0, 1]`);
  }
  return value;
}

/**
 * Validates a fully-mapped per-source-risk-tier record: every tier required
 * (no implicit defaults), no unsupported tier keys, each value run through
 * `validateValue`. Shared by the injection-classifier and L2 screener policies.
 */
function validateTierRecord<T>(
  raw: unknown,
  sourcePath: string,
  field: string,
  validateValue: (value: unknown, sourcePath: string, field: string) => T,
): Record<IntakeSourceRiskTier, T> {
  if (!isRecord(raw)) {
    throw invalid(sourcePath, `${field} must be an object`);
  }
  const unknownTiers = Object.keys(raw)
    .filter((key) => !(INTAKE_SOURCE_RISK_TIERS as readonly string[]).includes(key));
  if (unknownTiers.length > 0) {
    throw invalid(sourcePath, `${field} has unsupported tiers: ${unknownTiers.join(', ')}`);
  }
  const out = {} as Record<IntakeSourceRiskTier, T>;
  for (const tier of INTAKE_SOURCE_RISK_TIERS) {
    if (raw[tier] === undefined) {
      throw invalid(sourcePath, `${field}.${tier} is required (no implicit defaults)`);
    }
    out[tier] = validateValue(raw[tier], sourcePath, `${field}.${tier}`);
  }
  return out;
}

function validateInjectionClassifier(
  raw: unknown,
  sourcePath: string,
): IntakeInjectionClassifierPolicyConfig {
  if (!isRecord(raw)) {
    throw invalid(sourcePath, 'injectionClassifier must be an object');
  }
  const unknownKeys = Object.keys(raw)
    .filter((key) => !['labelThreshold', 'scoreThresholdsByTier'].includes(key));
  if (unknownKeys.length > 0) {
    throw invalid(sourcePath, `injectionClassifier has unsupported keys: ${unknownKeys.join(', ')}`);
  }
  return {
    labelThreshold: validateProbability(raw.labelThreshold, sourcePath, 'injectionClassifier.labelThreshold'),
    scoreThresholdsByTier: validateTierRecord(
      raw.scoreThresholdsByTier,
      sourcePath,
      'injectionClassifier.scoreThresholdsByTier',
      validateProbability,
    ),
  };
}

function validateNonEmptyString(value: unknown, sourcePath: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalid(sourcePath, `${field} must be a non-empty string`);
  }
  return value.trim();
}

function validateFailClosedAction(
  value: unknown,
  sourcePath: string,
  field: string,
): IntakeL2FailClosedAction {
  if (!isIntakeL2FailClosedAction(value)) {
    throw invalid(sourcePath, `${field} must be one of: ${INTAKE_L2_FAIL_CLOSED_ACTIONS.join(', ')}`);
  }
  return value;
}

function validateMandatoryTiers(
  raw: unknown,
  sourcePath: string,
  field: string,
): IntakeSourceRiskTier[] {
  if (!Array.isArray(raw)) {
    throw invalid(sourcePath, `${field} must be an array`);
  }
  const tiers = new Set<IntakeSourceRiskTier>();
  for (const entry of raw) {
    if (!isIntakeSourceRiskTier(entry)) {
      throw invalid(
        sourcePath,
        `${field} contains unsupported tier '${String(entry)}' `
        + `(expected one of: ${INTAKE_SOURCE_RISK_TIERS.join(', ')})`,
      );
    }
    tiers.add(entry);
  }
  return [...tiers];
}

function validateL2Screener(raw: unknown, sourcePath: string): IntakeL2ScreenerPolicyConfig {
  if (!isRecord(raw)) {
    throw invalid(sourcePath, 'l2Screener must be an object');
  }
  const knownKeys = [
    'model', 'escalationThresholdsByTier', 'mandatoryTiers',
    'failClosedActionByTier', 'timeoutMs', 'maxContentChars',
  ];
  const unknownKeys = Object.keys(raw).filter((key) => !knownKeys.includes(key));
  if (unknownKeys.length > 0) {
    throw invalid(sourcePath, `l2Screener has unsupported keys: ${unknownKeys.join(', ')}`);
  }
  return {
    model: validateNonEmptyString(raw.model, sourcePath, 'l2Screener.model'),
    escalationThresholdsByTier: validateTierRecord(
      raw.escalationThresholdsByTier,
      sourcePath,
      'l2Screener.escalationThresholdsByTier',
      validateProbability,
    ),
    mandatoryTiers: validateMandatoryTiers(raw.mandatoryTiers, sourcePath, 'l2Screener.mandatoryTiers'),
    failClosedActionByTier: validateTierRecord(
      raw.failClosedActionByTier,
      sourcePath,
      'l2Screener.failClosedActionByTier',
      validateFailClosedAction,
    ),
    timeoutMs: validatePositiveInteger(raw.timeoutMs, sourcePath, 'l2Screener.timeoutMs'),
    maxContentChars: validatePositiveInteger(raw.maxContentChars, sourcePath, 'l2Screener.maxContentChars'),
  };
}

function validateL3Screener(raw: unknown, sourcePath: string): IntakeL3ScreenerPolicyConfig {
  if (!isRecord(raw)) {
    throw invalid(sourcePath, 'l3Screener must be an object');
  }
  const knownKeys = [
    'model', 'dualModel', 'secondaryModel', 'escalationConfidenceThresholdsByTier',
    'mandatoryTiers', 'timeoutMs', 'maxContentChars', 'maxOutputTokens',
  ];
  const unknownKeys = Object.keys(raw).filter((key) => !knownKeys.includes(key));
  if (unknownKeys.length > 0) {
    throw invalid(sourcePath, `l3Screener has unsupported keys: ${unknownKeys.join(', ')}`);
  }
  const model = validateNonEmptyString(raw.model, sourcePath, 'l3Screener.model');
  if (typeof raw.dualModel !== 'boolean') {
    throw invalid(sourcePath, 'l3Screener.dualModel must be a boolean (no implicit default)');
  }
  if (raw.secondaryModel === undefined) {
    throw invalid(sourcePath, 'l3Screener.secondaryModel is required (use null for single-verdict mode)');
  }
  let secondaryModel: string | null = null;
  if (raw.secondaryModel !== null) {
    secondaryModel = validateNonEmptyString(raw.secondaryModel, sourcePath, 'l3Screener.secondaryModel');
    if (secondaryModel === model) {
      throw invalid(
        sourcePath,
        'l3Screener.secondaryModel must be a DIFFERENT model than l3Screener.model '
        + '(dual mode exists for independent perspectives)',
      );
    }
  }
  if (raw.dualModel && secondaryModel === null) {
    throw invalid(sourcePath, 'l3Screener.dualModel=true requires a non-null l3Screener.secondaryModel');
  }
  return {
    model,
    dualModel: raw.dualModel,
    secondaryModel,
    escalationConfidenceThresholdsByTier: validateTierRecord(
      raw.escalationConfidenceThresholdsByTier,
      sourcePath,
      'l3Screener.escalationConfidenceThresholdsByTier',
      validateProbability,
    ),
    mandatoryTiers: validateMandatoryTiers(raw.mandatoryTiers, sourcePath, 'l3Screener.mandatoryTiers'),
    timeoutMs: validatePositiveInteger(raw.timeoutMs, sourcePath, 'l3Screener.timeoutMs'),
    maxContentChars: validatePositiveInteger(raw.maxContentChars, sourcePath, 'l3Screener.maxContentChars'),
    maxOutputTokens: validatePositiveInteger(raw.maxOutputTokens, sourcePath, 'l3Screener.maxOutputTokens'),
  };
}

function validateDenyRiskLabels(
  raw: unknown,
  sourcePath: string,
  field: string,
): IntakeRiskLabel[] {
  if (!Array.isArray(raw)) {
    throw invalid(sourcePath, `${field} must be an array`);
  }
  const labels = new Set<IntakeRiskLabel>();
  for (const label of raw) {
    if (!isIntakeRiskLabel(label)) {
      throw invalid(
        sourcePath,
        `${field} contains unsupported risk label '${String(label)}' `
        + `(expected labels from the intake-envelope contract: ${INTAKE_RISK_LABELS.join(', ')})`,
      );
    }
    labels.add(label);
  }
  return [...labels];
}

function validateSinkRule(raw: unknown, sourcePath: string, field: string): IntakeSinkRuleConfig {
  if (!isRecord(raw)) {
    throw invalid(sourcePath, `${field} must be an object`);
  }
  const unknownKeys = Object.keys(raw)
    .filter((key) => !['maxSourceRiskTier', 'denyRiskLabels', 'unscreened'].includes(key));
  if (unknownKeys.length > 0) {
    throw invalid(sourcePath, `${field} has unsupported keys: ${unknownKeys.join(', ')}`);
  }
  if (!isIntakeSourceRiskTier(raw.maxSourceRiskTier)) {
    throw invalid(
      sourcePath,
      `${field}.maxSourceRiskTier must be one of: ${INTAKE_SOURCE_RISK_TIERS.join(', ')}`,
    );
  }
  if (!isIntakeUnscreenedSinkAction(raw.unscreened)) {
    throw invalid(
      sourcePath,
      `${field}.unscreened must be one of: ${INTAKE_UNSCREENED_SINK_ACTIONS.join(', ')} (no implicit fail-open)`,
    );
  }
  return {
    maxSourceRiskTier: raw.maxSourceRiskTier,
    denyRiskLabels: validateDenyRiskLabels(raw.denyRiskLabels, sourcePath, `${field}.denyRiskLabels`),
    unscreened: raw.unscreened,
  };
}

function validateTrifectaEnforcement(
  value: unknown,
  sourcePath: string,
  field: string,
): IntakeTrifectaEnforcement {
  if (!isIntakeTrifectaEnforcement(value)) {
    throw invalid(sourcePath, `${field} must be one of: ${INTAKE_TRIFECTA_ENFORCEMENTS.join(', ')}`);
  }
  return value;
}

function validateSinkGates(raw: unknown, sourcePath: string): IntakeSinkGatesPolicyConfig {
  if (!isRecord(raw)) {
    throw invalid(sourcePath, 'sinkGates must be an object');
  }
  const unknownKeys = Object.keys(raw).filter((key) => !['sinks', 'trifecta'].includes(key));
  if (unknownKeys.length > 0) {
    throw invalid(sourcePath, `sinkGates has unsupported keys: ${unknownKeys.join(', ')}`);
  }
  if (!isRecord(raw.sinks)) {
    throw invalid(sourcePath, 'sinkGates.sinks must be an object');
  }
  const unknownSinks = Object.keys(raw.sinks)
    .filter((key) => !(INTAKE_SINKS as readonly string[]).includes(key));
  if (unknownSinks.length > 0) {
    throw invalid(sourcePath, `sinkGates.sinks has unsupported sinks: ${unknownSinks.join(', ')}`);
  }
  const sinks = {} as Record<IntakeSink, IntakeSinkRuleConfig>;
  for (const sink of INTAKE_SINKS) {
    const rule = raw.sinks[sink];
    if (rule === undefined) {
      throw invalid(sourcePath, `sinkGates.sinks.${sink} is required (every consequential sink must be mapped)`);
    }
    sinks[sink] = validateSinkRule(rule, sourcePath, `sinkGates.sinks.${sink}`);
  }
  if (!isRecord(raw.trifecta)) {
    throw invalid(sourcePath, 'sinkGates.trifecta must be an object');
  }
  const unknownTrifectaKeys = Object.keys(raw.trifecta)
    .filter((key) => !['enforcementByTier'].includes(key));
  if (unknownTrifectaKeys.length > 0) {
    throw invalid(sourcePath, `sinkGates.trifecta has unsupported keys: ${unknownTrifectaKeys.join(', ')}`);
  }
  return {
    sinks,
    trifecta: {
      enforcementByTier: validateTierRecord(
        raw.trifecta.enforcementByTier,
        sourcePath,
        'sinkGates.trifecta.enforcementByTier',
        validateTrifectaEnforcement,
      ),
    },
  };
}

/** Gate rule for one consequential sink. */
export function sinkRuleForSink(
  config: IntakePolicyConfig,
  sink: IntakeSink,
): IntakeSinkRuleConfig {
  return config.sinkGates.sinks[sink];
}

/** Trifecta enforcement strength for untrusted content at a given source risk tier. */
export function trifectaEnforcementForTier(
  config: IntakePolicyConfig,
  tier: IntakeSourceRiskTier,
): IntakeTrifectaEnforcement {
  return config.sinkGates.trifecta.enforcementByTier[tier];
}

/** Screening threshold for the injection-classifier score at a given source risk tier. */
export function injectionScoreThresholdForTier(
  config: IntakePolicyConfig,
  tier: IntakeSourceRiskTier,
): number {
  return config.injectionClassifier.scoreThresholdsByTier[tier];
}

/** Prior-score escalation threshold for the L2 API screener at a given source risk tier. */
export function l2EscalationThresholdForTier(
  config: IntakePolicyConfig,
  tier: IntakeSourceRiskTier,
): number {
  return config.l2Screener.escalationThresholdsByTier[tier];
}

/** Fail-closed action for the L2 API screener at a given source risk tier. */
export function l2FailClosedActionForTier(
  config: IntakePolicyConfig,
  tier: IntakeSourceRiskTier,
): IntakeL2FailClosedAction {
  return config.l2Screener.failClosedActionByTier[tier];
}

/**
 * L2 escalation gate: an item escalates to the L2 API screener when its tier is
 * mandatory OR its prior (max L1/L1.5) score meets the tier's escalation
 * threshold. Below-threshold, non-mandatory items skip L2 entirely — this is
 * the trusted-tier fast path.
 */
export function shouldEscalateToL2(
  config: IntakePolicyConfig,
  tier: IntakeSourceRiskTier,
  priorScore: number,
): boolean {
  if (config.l2Screener.mandatoryTiers.includes(tier)) {
    return true;
  }
  return priorScore >= config.l2Screener.escalationThresholdsByTier[tier];
}

/** L2-confidence threshold at/above which an L2-classified item escalates to L3. */
export function l3EscalationConfidenceThresholdForTier(
  config: IntakePolicyConfig,
  tier: IntakeSourceRiskTier,
): number {
  return config.l3Screener.escalationConfidenceThresholdsByTier[tier];
}

/** True when the tier mandates L3 deep screening regardless of the L2 verdict. */
export function isL3MandatoryTier(
  config: IntakePolicyConfig,
  tier: IntakeSourceRiskTier,
): boolean {
  return config.l3Screener.mandatoryTiers.includes(tier);
}

export function validateIntakePolicy(raw: unknown, sourcePath: string): IntakePolicyConfig {
  if (!isRecord(raw)) {
    throw invalid(sourcePath, 'expected object');
  }
  const knownKeys = [
    'schemaVersion', 'mode', 'sourceRiskTiers', 'quarantine', 'injectionClassifier',
    'l2Screener', 'l3Screener', 'sinkGates',
  ];
  const unknownKeys = Object.keys(raw).filter((key) => !knownKeys.includes(key));
  if (unknownKeys.length > 0) {
    throw invalid(sourcePath, `has unsupported keys: ${unknownKeys.join(', ')}`);
  }
  if (raw.schemaVersion !== 1) {
    throw invalid(sourcePath, 'schemaVersion must be 1');
  }
  const mode = raw.mode;
  if (typeof mode !== 'string' || !(INTAKE_FIREWALL_MODES as readonly string[]).includes(mode)) {
    throw invalid(sourcePath, `mode must be one of: ${INTAKE_FIREWALL_MODES.join(', ')}`);
  }
  return {
    schemaVersion: 1,
    mode: mode as IntakeFirewallMode,
    sourceRiskTiers: validateSourceRiskTiers(raw.sourceRiskTiers, sourcePath),
    quarantine: validateQuarantine(raw.quarantine, sourcePath),
    injectionClassifier: validateInjectionClassifier(raw.injectionClassifier, sourcePath),
    l2Screener: validateL2Screener(raw.l2Screener, sourcePath),
    l3Screener: validateL3Screener(raw.l3Screener, sourcePath),
    sinkGates: validateSinkGates(raw.sinkGates, sourcePath),
  };
}

export function loadIntakePolicyConfig(
  dataDir: string,
  options: IntakePolicyLoadOptions = {},
): IntakePolicyConfig {
  const seedDir = options.seedDir ?? process.env.CONFIG_DIR ?? './config';
  return loadRequiredJson({
    dataPath: join(dataDir, INTAKE_POLICY_FILE_NAME),
    examplePath: join(seedDir, INTAKE_POLICY_SEED_FILE_NAME),
    validate: validateIntakePolicy,
  });
}

export function saveIntakePolicyConfig(
  dataDir: string,
  nextConfig: unknown,
): IntakePolicyConfig {
  const validated = validateIntakePolicy(nextConfig, INTAKE_POLICY_FILE_NAME);
  writeJsonAtomic(join(dataDir, INTAKE_POLICY_FILE_NAME), validated);
  return validated;
}
