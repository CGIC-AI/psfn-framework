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

// ── Source lists (htm9.13): trusted/denied sites and people ──

/**
 * Operator-curated source lists (htm9.13). A trusted-site/person hit lowers
 * the EFFECTIVE source risk tier ONE step (never below 'trusted', never
 * skipping L1 — every item is still scanned); a denied hit raises it to
 * 'hostile'. Fed by Garden flywheel decisions (htm9.11) through the
 * /api/admin/intake/source-lists routes; tuned for "your friends who happen
 * to be AI", not agency-run businesses — trusted origin != safe (npm/GitHub
 * supply-chain attacks are the counterexample), so trust only lightens the
 * escalation layers, it never waives deterministic screening.
 */
export const INTAKE_SOURCE_LIST_NAMES = [
  'trustedSites',
  'deniedSites',
  'trustedPeople',
  'deniedPeople',
] as const;
export type IntakeSourceListName = typeof INTAKE_SOURCE_LIST_NAMES[number];

export function isIntakeSourceListName(value: unknown): value is IntakeSourceListName {
  return typeof value === 'string'
    && (INTAKE_SOURCE_LIST_NAMES as readonly string[]).includes(value);
}

export interface IntakeSourceListEntry {
  /**
   * Sites: an exact lowercase host ('arxiv.org') or a registrable-domain
   * suffix ('*.arxiv.org' — matches the apex and every subdomain). No
   * schemes, ports, paths, or regex — malformed patterns fail closed at
   * validation. People: the canonical contact id, matched exactly.
   */
  pattern: string;
  /** Who added the entry ('operator', 'garden-flywheel', ...). */
  addedBy: string;
  /** Epoch milliseconds when the entry was added. */
  addedAt: number;
  note?: string;
}

export type IntakeSourceListsConfig = Record<IntakeSourceListName, IntakeSourceListEntry[]>;

const MAX_SOURCE_LIST_ENTRIES = 512;
const MAX_SOURCE_LIST_NOTE_CHARS = 512;
const MAX_SOURCE_LIST_ADDED_BY_CHARS = 128;
const MAX_SITE_PATTERN_CHARS = 255;
const MAX_PERSON_PATTERN_CHARS = 256;
const SITE_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Normalizes and validates a site pattern: exact host or `*.domain.tld`
 * suffix only. No regex from config — anything else throws (fail closed).
 */
export function normalizeIntakeSitePattern(value: unknown, context = 'site pattern'): string {
  if (typeof value !== 'string') {
    throw new Error(`${context} must be a string`);
  }
  const pattern = value.trim().toLowerCase();
  if (!pattern) {
    throw new Error(`${context} must be non-empty`);
  }
  if (pattern.length > MAX_SITE_PATTERN_CHARS) {
    throw new Error(`${context} exceeds ${String(MAX_SITE_PATTERN_CHARS)} characters`);
  }
  const host = pattern.startsWith('*.') ? pattern.slice(2) : pattern;
  if (host.includes('*')) {
    throw new Error(
      `${context} '${pattern}' is malformed: wildcard is only allowed as a leading '*.' suffix`,
    );
  }
  const labels = host.split('.');
  if (labels.length < 2) {
    throw new Error(
      `${context} '${pattern}' must include a registrable domain (e.g. 'arxiv.org' or '*.arxiv.org')`,
    );
  }
  for (const label of labels) {
    if (!SITE_LABEL_PATTERN.test(label)) {
      throw new Error(
        `${context} '${pattern}' is malformed: exact host or '*.domain.tld' suffix only `
        + '(no schemes, ports, paths, or regex)',
      );
    }
  }
  return pattern;
}

/**
 * Normalizes and validates a person pattern: a canonical contact id, matched
 * exactly. Whitespace/control characters are rejected (fail closed).
 */
export function normalizeIntakePersonPattern(value: unknown, context = 'person pattern'): string {
  if (typeof value !== 'string') {
    throw new Error(`${context} must be a string`);
  }
  const pattern = value.trim();
  if (!pattern) {
    throw new Error(`${context} must be non-empty`);
  }
  if (pattern.length > MAX_PERSON_PATTERN_CHARS) {
    throw new Error(`${context} exceeds ${String(MAX_PERSON_PATTERN_CHARS)} characters`);
  }
  if (/[\s\p{Cc}]/u.test(pattern)) {
    throw new Error(`${context} '${pattern}' must not contain whitespace or control characters`);
  }
  return pattern;
}

function normalizeSourceListPattern(
  list: IntakeSourceListName,
  value: unknown,
  context: string,
): string {
  return list === 'trustedSites' || list === 'deniedSites'
    ? normalizeIntakeSitePattern(value, context)
    : normalizeIntakePersonPattern(value, context);
}

function validateSourceListEntry(
  raw: unknown,
  sourcePath: string,
  field: string,
  list: IntakeSourceListName,
): IntakeSourceListEntry {
  if (!isRecord(raw)) {
    throw invalid(sourcePath, `${field} must be an object`);
  }
  const unknownKeys = Object.keys(raw)
    .filter((key) => !['pattern', 'addedBy', 'addedAt', 'note'].includes(key));
  if (unknownKeys.length > 0) {
    throw invalid(sourcePath, `${field} has unsupported keys: ${unknownKeys.join(', ')}`);
  }
  let pattern: string;
  try {
    pattern = normalizeSourceListPattern(list, raw.pattern, `${field}.pattern`);
  } catch (error) {
    throw invalid(sourcePath, error instanceof Error ? error.message : String(error));
  }
  const addedBy = raw.addedBy;
  if (typeof addedBy !== 'string' || !addedBy.trim()
    || addedBy.trim().length > MAX_SOURCE_LIST_ADDED_BY_CHARS) {
    throw invalid(
      sourcePath,
      `${field}.addedBy must be a non-empty string of at most ${String(MAX_SOURCE_LIST_ADDED_BY_CHARS)} characters`,
    );
  }
  if (typeof raw.addedAt !== 'number' || !Number.isFinite(raw.addedAt) || raw.addedAt <= 0) {
    throw invalid(sourcePath, `${field}.addedAt must be a positive epoch-milliseconds number`);
  }
  const entry: IntakeSourceListEntry = {
    pattern,
    addedBy: addedBy.trim(),
    addedAt: raw.addedAt,
  };
  if (raw.note !== undefined) {
    if (typeof raw.note !== 'string' || raw.note.length > MAX_SOURCE_LIST_NOTE_CHARS) {
      throw invalid(
        sourcePath,
        `${field}.note must be a string of at most ${String(MAX_SOURCE_LIST_NOTE_CHARS)} characters`,
      );
    }
    entry.note = raw.note;
  }
  return entry;
}

function validateSourceLists(raw: unknown, sourcePath: string): IntakeSourceListsConfig {
  if (!isRecord(raw)) {
    throw invalid(sourcePath, 'sourceLists must be an object');
  }
  const unknownKeys = Object.keys(raw)
    .filter((key) => !(INTAKE_SOURCE_LIST_NAMES as readonly string[]).includes(key));
  if (unknownKeys.length > 0) {
    throw invalid(sourcePath, `sourceLists has unsupported keys: ${unknownKeys.join(', ')}`);
  }
  const lists = {} as IntakeSourceListsConfig;
  for (const list of INTAKE_SOURCE_LIST_NAMES) {
    const entries = raw[list];
    if (entries === undefined) {
      throw invalid(sourcePath, `sourceLists.${list} is required (use an empty array)`);
    }
    if (!Array.isArray(entries)) {
      throw invalid(sourcePath, `sourceLists.${list} must be an array`);
    }
    if (entries.length > MAX_SOURCE_LIST_ENTRIES) {
      throw invalid(sourcePath, `sourceLists.${list} exceeds ${String(MAX_SOURCE_LIST_ENTRIES)} entries`);
    }
    const seen = new Set<string>();
    lists[list] = entries.map((entry, index) => {
      const validated = validateSourceListEntry(
        entry,
        sourcePath,
        `sourceLists.${list}[${String(index)}]`,
        list,
      );
      if (seen.has(validated.pattern)) {
        throw invalid(sourcePath, `sourceLists.${list} has a duplicate pattern '${validated.pattern}'`);
      }
      seen.add(validated.pattern);
      return validated;
    });
  }
  // A pattern in BOTH the trusted and denied list of the same domain is an
  // operator contradiction — fail closed instead of silently letting the
  // denied hit win at runtime.
  for (const [trustedName, deniedName] of [
    ['trustedSites', 'deniedSites'],
    ['trustedPeople', 'deniedPeople'],
  ] as const) {
    const denied = new Set(lists[deniedName].map((entry) => entry.pattern));
    for (const entry of lists[trustedName]) {
      if (denied.has(entry.pattern)) {
        throw invalid(
          sourcePath,
          `sourceLists pattern '${entry.pattern}' appears in both ${trustedName} and ${deniedName}`,
        );
      }
    }
  }
  return lists;
}

// ── Source list mutation (Garden admin routes; htm9.11 UI builds on this) ──

export interface IntakeSourceListMutation {
  action: 'add' | 'remove';
  list: IntakeSourceListName;
  pattern: string;
  note?: string;
  /** Acting principal recorded on added entries. */
  addedBy: string;
  atMs: number;
}

/**
 * Applies one add/remove mutation to the source lists and returns a fully
 * re-validated config (fail closed: malformed patterns, duplicates, and
 * trusted/denied contradictions all throw). Pure — the caller persists.
 */
export function applyIntakeSourceListMutation(
  config: IntakePolicyConfig,
  mutation: IntakeSourceListMutation,
): IntakePolicyConfig {
  if (!isIntakeSourceListName(mutation.list)) {
    throw new Error(
      `Intake source list mutation list must be one of: ${INTAKE_SOURCE_LIST_NAMES.join(', ')}`,
    );
  }
  const pattern = normalizeSourceListPattern(
    mutation.list,
    mutation.pattern,
    `sourceLists.${mutation.list} pattern`,
  );
  const current = config.sourceLists[mutation.list];
  let nextEntries: IntakeSourceListEntry[];
  if (mutation.action === 'add') {
    if (current.some((entry) => entry.pattern === pattern)) {
      throw new Error(`sourceLists.${mutation.list} already contains '${pattern}'`);
    }
    const addedBy = mutation.addedBy.trim();
    if (!addedBy) {
      throw new Error('Intake source list mutation addedBy must be non-empty');
    }
    const entry: IntakeSourceListEntry = { pattern, addedBy, addedAt: mutation.atMs };
    if (mutation.note !== undefined && mutation.note.trim().length > 0) {
      entry.note = mutation.note.trim();
    }
    nextEntries = [...current, entry];
  } else {
    if (!current.some((entry) => entry.pattern === pattern)) {
      throw new Error(`sourceLists.${mutation.list} does not contain '${pattern}'`);
    }
    nextEntries = current.filter((entry) => entry.pattern !== pattern);
  }
  return validateIntakePolicy(
    {
      ...config,
      sourceLists: { ...config.sourceLists, [mutation.list]: nextEntries },
    },
    `${INTAKE_POLICY_FILE_NAME} (source list mutation)`,
  );
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

/**
 * Slow-poisoning drift-velocity detection (htm9.14,
 * src/core/cogsec/drift/). Deterministic nightly aggregation over persisted
 * evidence — zero LLM calls, zero synchronous-turn latency. Each block tunes
 * one of the four scored signals; the lane raises an operator review card in
 * the Garden Cognitive Security tab and NEVER mutates memories/trust/emotion.
 */
export interface IntakeDriftDetectionPolicyConfig {
  /** Master switch for the nightly drift-velocity review lane. */
  enabled: boolean;
  /** Emotional-valence trajectory velocity per contact. */
  valenceVelocity: {
    /** Recent points compared against the baseline (the "short window"). */
    shortWindowPoints: number;
    /** Minimum baseline points required before the signal can evaluate. */
    minLongWindowPoints: number;
    /**
     * K: the short-window mean must shift at least K x the contact's own
     * long-window standard deviation to count as drift velocity.
     */
    velocitySigmaThreshold: number;
    /** Fraction of short-window steps that must move WITH the shift (0-1). */
    monotonicityMin: number;
    /** Volatility floor so ultra-stable baselines don't divide toward infinity. */
    minBaselineStd: number;
    /** Time-series points below this classifier confidence are ignored (0-1). */
    minPointConfidence: number;
  };
  /** Memory-write rate per source vs its own baseline rate. */
  memoryWriteRate: {
    recentWindowHours: number;
    baselineWindowDays: number;
    /** Recent daily rate must exceed baseline daily rate by this multiple. */
    burstMultiplier: number;
    /** Absolute floor of recent writes before the signal can trigger. */
    minRecentWrites: number;
  };
  /** Trust-lobbying envelope-label recurrence (poisoning/*, persona pressure). */
  labelFrequency: {
    windowDays: number;
    /** Trust-lobbying labels observed in the window before triggering. */
    minCount: number;
  };
  /** Retrieval share of low-trust sources in the working belief base. */
  retrievalShare: {
    windowHours: number;
    /** Absolute floor of recent retrievals before the signal can trigger. */
    minRetrievals: number;
    /** Share (0-1) of recent retrievals from one low-trust source to trigger. */
    maxLowTrustShare: number;
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
  /** Operator-curated trusted/denied sites and people (htm9.13). */
  sourceLists: IntakeSourceListsConfig;
  quarantine: IntakePolicyQuarantineConfig;
  injectionClassifier: IntakeInjectionClassifierPolicyConfig;
  l2Screener: IntakeL2ScreenerPolicyConfig;
  l3Screener: IntakeL3ScreenerPolicyConfig;
  sinkGates: IntakeSinkGatesPolicyConfig;
  driftDetection: IntakeDriftDetectionPolicyConfig;
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

function validatePositiveNumber(value: unknown, sourcePath: string, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw invalid(sourcePath, `${field} must be a finite number > 0`);
  }
  return value;
}

function validateDriftDetection(
  raw: unknown,
  sourcePath: string,
): IntakeDriftDetectionPolicyConfig {
  if (!isRecord(raw)) {
    throw invalid(sourcePath, 'driftDetection must be an object');
  }
  const knownKeys = ['enabled', 'valenceVelocity', 'memoryWriteRate', 'labelFrequency', 'retrievalShare'];
  const unknownKeys = Object.keys(raw).filter((key) => !knownKeys.includes(key));
  if (unknownKeys.length > 0) {
    throw invalid(sourcePath, `driftDetection has unsupported keys: ${unknownKeys.join(', ')}`);
  }
  if (typeof raw.enabled !== 'boolean') {
    throw invalid(sourcePath, 'driftDetection.enabled must be a boolean (no implicit default)');
  }

  const valence = raw.valenceVelocity;
  if (!isRecord(valence)) {
    throw invalid(sourcePath, 'driftDetection.valenceVelocity must be an object');
  }
  const valenceKeys = [
    'shortWindowPoints', 'minLongWindowPoints', 'velocitySigmaThreshold',
    'monotonicityMin', 'minBaselineStd', 'minPointConfidence',
  ];
  const unknownValenceKeys = Object.keys(valence).filter((key) => !valenceKeys.includes(key));
  if (unknownValenceKeys.length > 0) {
    throw invalid(sourcePath, `driftDetection.valenceVelocity has unsupported keys: ${unknownValenceKeys.join(', ')}`);
  }

  const writeRate = raw.memoryWriteRate;
  if (!isRecord(writeRate)) {
    throw invalid(sourcePath, 'driftDetection.memoryWriteRate must be an object');
  }
  const writeRateKeys = ['recentWindowHours', 'baselineWindowDays', 'burstMultiplier', 'minRecentWrites'];
  const unknownWriteRateKeys = Object.keys(writeRate).filter((key) => !writeRateKeys.includes(key));
  if (unknownWriteRateKeys.length > 0) {
    throw invalid(sourcePath, `driftDetection.memoryWriteRate has unsupported keys: ${unknownWriteRateKeys.join(', ')}`);
  }

  const labels = raw.labelFrequency;
  if (!isRecord(labels)) {
    throw invalid(sourcePath, 'driftDetection.labelFrequency must be an object');
  }
  const labelKeys = ['windowDays', 'minCount'];
  const unknownLabelKeys = Object.keys(labels).filter((key) => !labelKeys.includes(key));
  if (unknownLabelKeys.length > 0) {
    throw invalid(sourcePath, `driftDetection.labelFrequency has unsupported keys: ${unknownLabelKeys.join(', ')}`);
  }

  const retrieval = raw.retrievalShare;
  if (!isRecord(retrieval)) {
    throw invalid(sourcePath, 'driftDetection.retrievalShare must be an object');
  }
  const retrievalKeys = ['windowHours', 'minRetrievals', 'maxLowTrustShare'];
  const unknownRetrievalKeys = Object.keys(retrieval).filter((key) => !retrievalKeys.includes(key));
  if (unknownRetrievalKeys.length > 0) {
    throw invalid(sourcePath, `driftDetection.retrievalShare has unsupported keys: ${unknownRetrievalKeys.join(', ')}`);
  }

  return {
    enabled: raw.enabled,
    valenceVelocity: {
      shortWindowPoints: validatePositiveInteger(
        valence.shortWindowPoints, sourcePath, 'driftDetection.valenceVelocity.shortWindowPoints',
      ),
      minLongWindowPoints: validatePositiveInteger(
        valence.minLongWindowPoints, sourcePath, 'driftDetection.valenceVelocity.minLongWindowPoints',
      ),
      velocitySigmaThreshold: validatePositiveNumber(
        valence.velocitySigmaThreshold, sourcePath, 'driftDetection.valenceVelocity.velocitySigmaThreshold',
      ),
      monotonicityMin: validateProbability(
        valence.monotonicityMin, sourcePath, 'driftDetection.valenceVelocity.monotonicityMin',
      ),
      minBaselineStd: validatePositiveNumber(
        valence.minBaselineStd, sourcePath, 'driftDetection.valenceVelocity.minBaselineStd',
      ),
      minPointConfidence: validateProbability(
        valence.minPointConfidence, sourcePath, 'driftDetection.valenceVelocity.minPointConfidence',
      ),
    },
    memoryWriteRate: {
      recentWindowHours: validatePositiveInteger(
        writeRate.recentWindowHours, sourcePath, 'driftDetection.memoryWriteRate.recentWindowHours',
      ),
      baselineWindowDays: validatePositiveInteger(
        writeRate.baselineWindowDays, sourcePath, 'driftDetection.memoryWriteRate.baselineWindowDays',
      ),
      burstMultiplier: validatePositiveNumber(
        writeRate.burstMultiplier, sourcePath, 'driftDetection.memoryWriteRate.burstMultiplier',
      ),
      minRecentWrites: validatePositiveInteger(
        writeRate.minRecentWrites, sourcePath, 'driftDetection.memoryWriteRate.minRecentWrites',
      ),
    },
    labelFrequency: {
      windowDays: validatePositiveInteger(
        labels.windowDays, sourcePath, 'driftDetection.labelFrequency.windowDays',
      ),
      minCount: validatePositiveInteger(
        labels.minCount, sourcePath, 'driftDetection.labelFrequency.minCount',
      ),
    },
    retrievalShare: {
      windowHours: validatePositiveInteger(
        retrieval.windowHours, sourcePath, 'driftDetection.retrievalShare.windowHours',
      ),
      minRetrievals: validatePositiveInteger(
        retrieval.minRetrievals, sourcePath, 'driftDetection.retrievalShare.minRetrievals',
      ),
      maxLowTrustShare: validateProbability(
        retrieval.maxLowTrustShare, sourcePath, 'driftDetection.retrievalShare.maxLowTrustShare',
      ),
    },
  };
}

export function validateIntakePolicy(raw: unknown, sourcePath: string): IntakePolicyConfig {
  if (!isRecord(raw)) {
    throw invalid(sourcePath, 'expected object');
  }
  const knownKeys = [
    'schemaVersion', 'mode', 'sourceRiskTiers', 'sourceLists', 'quarantine',
    'injectionClassifier', 'l2Screener', 'l3Screener', 'sinkGates', 'driftDetection',
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
    sourceLists: validateSourceLists(raw.sourceLists, sourcePath),
    quarantine: validateQuarantine(raw.quarantine, sourcePath),
    injectionClassifier: validateInjectionClassifier(raw.injectionClassifier, sourcePath),
    l2Screener: validateL2Screener(raw.l2Screener, sourcePath),
    l3Screener: validateL3Screener(raw.l3Screener, sourcePath),
    sinkGates: validateSinkGates(raw.sinkGates, sourcePath),
    driftDetection: validateDriftDetection(raw.driftDetection, sourcePath),
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
