// ── Hot-reloadable L1 rule engine (htm9.4) ──
//
// vigil-llm YARA pattern without the YARA dependency: rules live in a
// checked-in plain-text (JSON) rule file, each rule names the envelope risk
// labels it asserts, and the file reloads without a process restart.
//
// Rule matches are built exclusively from the bounded primitives in
// proximity.ts ('phrase', 'near') plus a linted 'regex' escape hatch that
// rejects every unbounded quantifier. Scope tiers follow the Hermes model:
// 'all' rules apply everywhere, 'context' adds warn-only promptware/C2
// detection, 'strict' adds block-tier persistence/exfil checks.
//
// Reload semantics (fail-open-advisory, no swallowed errors):
// - construction and explicit reload() fail CLOSED — an invalid rule file
//   throws to the caller;
// - the lazy staleness check inside scan() keeps the last-good rule set on
//   failure and records the error in status().lastReloadError, which the
//   pipeline surfaces in the scan report's scannerErrors. Scanning is never
//   taken down by a bad hot edit; the failure is always visible.

import * as fs from 'node:fs';
import {
  isIntakeRiskLabel,
  INTAKE_RISK_LABELS,
  type IntakeRiskLabel,
} from '../../../../shared/contracts/intake-envelope.js';
import {
  buildBoundedFillerPattern,
  buildCharWindowPattern,
  compileBuiltPattern,
  compileRulePattern,
  DEFAULT_FILLER_WORDS,
  DEFAULT_PROXIMITY_GAP_CHARS,
} from './proximity.js';
import {
  buildScannerResult,
  isIntakeScanScope,
  INTAKE_SCAN_SCOPES,
  scanScopeIncludes,
  type IntakeScannerFinding,
  type IntakeScannerResult,
  type IntakeScanScope,
} from './types.js';

export const INTAKE_L1_RULES_FILE_NAME = 'intake-l1-rules.json';
export const INTAKE_RULE_ENGINE_SCANNER_ID = 'l1.rules';

const MAX_RULES = 512;
const RULE_ID_PATTERN = /^[a-z0-9][a-z0-9_.-]{1,63}$/;

// ── Rule file schema ──

export interface IntakeL1RuleMatchPhrase {
  kind: 'phrase';
  /** Regex fragments; joined with the bounded filler primitive. */
  anchors: readonly string[];
  /** Max filler words between anchors (default 8, cap 16). */
  maxFillerWords?: number;
}

export interface IntakeL1RuleMatchNear {
  kind: 'near';
  left: string;
  right: string;
  /** Max chars between left and right (default 2048, cap 4096). */
  maxGapChars?: number;
  /** Window stays on one line (default true). */
  sameLine?: boolean;
}

export interface IntakeL1RuleMatchRegex {
  kind: 'regex';
  /** Raw pattern; linted — unbounded quantifiers are rejected. */
  pattern: string;
}

export type IntakeL1RuleMatch =
  | IntakeL1RuleMatchPhrase
  | IntakeL1RuleMatchNear
  | IntakeL1RuleMatchRegex;

export interface IntakeL1Rule {
  /** Rule name; doubles as the finding's audit id. */
  id: string;
  /** Envelope taxonomy labels this rule asserts (rule name = risk label pattern). */
  labels: readonly IntakeRiskLabel[];
  scope: IntakeScanScope;
  /** Score contribution in (0, 1]. */
  weight: number;
  match: IntakeL1RuleMatch;
  /** Free-form rationale; not used at runtime. */
  note?: string;
}

export interface IntakeL1RuleFile {
  schemaVersion: 1;
  rules: readonly IntakeL1Rule[];
}

interface CompiledIntakeRule {
  id: string;
  labels: readonly IntakeRiskLabel[];
  scope: IntakeScanScope;
  weight: number;
  regex: RegExp;
}

function invalid(sourcePath: string, detail: string): Error {
  return new Error(`Invalid intake L1 rule file at ${sourcePath}: ${detail}`);
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compileMatch(match: unknown, ruleId: string, sourcePath: string): RegExp {
  if (!isRecordValue(match)) {
    throw invalid(sourcePath, `rule '${ruleId}' match must be an object`);
  }
  const field = `rule '${ruleId}' match`;
  const kind = match.kind;
  if (kind === 'phrase') {
    const anchors = match.anchors;
    if (!Array.isArray(anchors) || anchors.some((anchor) => typeof anchor !== 'string')) {
      throw invalid(sourcePath, `${field}.anchors must be an array of strings`);
    }
    const maxFillerWords = match.maxFillerWords ?? DEFAULT_FILLER_WORDS;
    if (typeof maxFillerWords !== 'number') {
      throw invalid(sourcePath, `${field}.maxFillerWords must be a number`);
    }
    const pattern = buildBoundedFillerPattern(anchors as string[], maxFillerWords, field);
    return compileBuiltPattern(pattern, field);
  }
  if (kind === 'near') {
    const left = match.left;
    const right = match.right;
    if (typeof left !== 'string' || typeof right !== 'string') {
      throw invalid(sourcePath, `${field}.left and .right must be strings`);
    }
    const maxGapChars = match.maxGapChars ?? DEFAULT_PROXIMITY_GAP_CHARS;
    if (typeof maxGapChars !== 'number') {
      throw invalid(sourcePath, `${field}.maxGapChars must be a number`);
    }
    const sameLine = match.sameLine ?? true;
    if (typeof sameLine !== 'boolean') {
      throw invalid(sourcePath, `${field}.sameLine must be a boolean`);
    }
    const pattern = buildCharWindowPattern({ left, right, maxGapChars, sameLine, field });
    return compileBuiltPattern(pattern, field);
  }
  if (kind === 'regex') {
    const pattern = match.pattern;
    if (typeof pattern !== 'string') {
      throw invalid(sourcePath, `${field}.pattern must be a string`);
    }
    return compileRulePattern(pattern, field);
  }
  throw invalid(
    sourcePath,
    `${field}.kind must be one of: phrase, near, regex (got '${String(kind)}')`,
  );
}

/** Fail-closed parse + compile of a rule file's JSON text. */
export function compileIntakeL1RuleFile(
  jsonText: string,
  sourcePath: string,
): CompiledIntakeRule[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw invalid(sourcePath, `not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecordValue(parsed)) {
    throw invalid(sourcePath, 'root must be an object');
  }
  if (parsed.schemaVersion !== 1) {
    throw invalid(sourcePath, 'schemaVersion must be 1');
  }
  const unknownKeys = Object.keys(parsed).filter((key) => !['schemaVersion', 'rules'].includes(key));
  if (unknownKeys.length > 0) {
    throw invalid(sourcePath, `has unsupported keys: ${unknownKeys.join(', ')}`);
  }
  if (!Array.isArray(parsed.rules)) {
    throw invalid(sourcePath, 'rules must be an array');
  }
  if (parsed.rules.length === 0) {
    throw invalid(sourcePath, 'rules must not be empty');
  }
  if (parsed.rules.length > MAX_RULES) {
    throw invalid(sourcePath, `rules exceed the ${String(MAX_RULES)}-rule cap`);
  }

  const seenIds = new Set<string>();
  const compiled: CompiledIntakeRule[] = [];
  for (const [index, ruleValue] of parsed.rules.entries()) {
    const at = `rules[${String(index)}]`;
    if (!isRecordValue(ruleValue)) {
      throw invalid(sourcePath, `${at} must be an object`);
    }
    const ruleUnknown = Object.keys(ruleValue)
      .filter((key) => !['id', 'labels', 'scope', 'weight', 'match', 'note'].includes(key));
    if (ruleUnknown.length > 0) {
      throw invalid(sourcePath, `${at} has unsupported keys: ${ruleUnknown.join(', ')}`);
    }
    const id = ruleValue.id;
    if (typeof id !== 'string' || !RULE_ID_PATTERN.test(id)) {
      throw invalid(sourcePath, `${at}.id must match ${RULE_ID_PATTERN.source}`);
    }
    if (seenIds.has(id)) {
      throw invalid(sourcePath, `duplicate rule id '${id}'`);
    }
    seenIds.add(id);
    if (!Array.isArray(ruleValue.labels) || ruleValue.labels.length === 0) {
      throw invalid(sourcePath, `rule '${id}' labels must be a non-empty array`);
    }
    const labels: IntakeRiskLabel[] = [];
    for (const label of ruleValue.labels) {
      if (!isIntakeRiskLabel(label)) {
        throw invalid(
          sourcePath,
          `rule '${id}' label '${String(label)}' is not in the envelope taxonomy `
          + `(${INTAKE_RISK_LABELS.join(', ')})`,
        );
      }
      labels.push(label);
    }
    if (!isIntakeScanScope(ruleValue.scope)) {
      throw invalid(sourcePath, `rule '${id}' scope must be one of: ${INTAKE_SCAN_SCOPES.join(', ')}`);
    }
    const weight = ruleValue.weight;
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0 || weight > 1) {
      throw invalid(sourcePath, `rule '${id}' weight must be a finite number in (0, 1]`);
    }
    if (ruleValue.note !== undefined && typeof ruleValue.note !== 'string') {
      throw invalid(sourcePath, `rule '${id}' note must be a string`);
    }
    compiled.push({
      id,
      labels,
      scope: ruleValue.scope,
      weight,
      regex: compileMatch(ruleValue.match, id, sourcePath),
    });
  }
  return compiled;
}

// ── Engine ──

export interface IntakeRuleEngineStatus {
  rulesPath: string;
  ruleCount: number;
  loadedAtMs: number;
  /** mtimeNs:size:ino of the loaded file (staleness fingerprint). */
  fingerprint: string;
  /** Set when the last lazy staleness reload failed; cleared on success. */
  lastReloadError?: string;
}

export interface IntakeRuleEngineOptions {
  rulesPath: string;
  /**
   * How often scan() re-checks the rule file's fingerprint. 0 = check on
   * every scan; a negative value disables lazy reload (explicit reload()
   * still works). Default 5000ms.
   */
  reloadCheckIntervalMs?: number;
  /** Clock override for tests. */
  now?: () => number;
}

export interface IntakeRuleEngine {
  readonly scannerId: typeof INTAKE_RULE_ENGINE_SCANNER_ID;
  /** Matches the (NFKC-normalized, capped) text against the loaded rules. */
  scan(normalizedText: string, scope: IntakeScanScope): IntakeScannerResult;
  /** Explicit reload; throws on an invalid file (fail closed for the caller). */
  reload(): void;
  status(): IntakeRuleEngineStatus;
}

function readFingerprint(rulesPath: string): string {
  const stats = fs.statSync(rulesPath, { bigint: true });
  return `${String(stats.mtimeNs)}:${String(stats.size)}:${String(stats.ino)}`;
}

export function createIntakeRuleEngine(options: IntakeRuleEngineOptions): IntakeRuleEngine {
  const rulesPath = options.rulesPath;
  const reloadCheckIntervalMs = options.reloadCheckIntervalMs ?? 5_000;
  const now = options.now ?? Date.now;

  let rules: CompiledIntakeRule[];
  let fingerprint: string;
  let loadedAtMs: number;
  let lastReloadError: string | undefined;
  let lastStalenessCheckMs: number;

  function load(): void {
    const nextFingerprint = readFingerprint(rulesPath);
    const jsonText = fs.readFileSync(rulesPath, 'utf8');
    rules = compileIntakeL1RuleFile(jsonText, rulesPath);
    fingerprint = nextFingerprint;
    loadedAtMs = now();
    lastReloadError = undefined;
  }

  // Fail closed at construction: a missing/invalid rule file is a deploy
  // error, not something to limp past silently.
  load();
  lastStalenessCheckMs = now();

  function maybeLazyReload(): void {
    if (reloadCheckIntervalMs < 0) return;
    const currentMs = now();
    if (currentMs - lastStalenessCheckMs < reloadCheckIntervalMs) return;
    lastStalenessCheckMs = currentMs;
    try {
      if (readFingerprint(rulesPath) === fingerprint) return;
      load();
    } catch (error) {
      // Fail open-advisory: keep the last-good rule set, record the error.
      // The pipeline copies status().lastReloadError into scannerErrors so
      // the failure is visible on every report until the file is fixed.
      lastReloadError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    scannerId: INTAKE_RULE_ENGINE_SCANNER_ID,
    scan(normalizedText: string, scope: IntakeScanScope): IntakeScannerResult {
      if (!isIntakeScanScope(scope)) {
        throw new Error(`Unknown intake scan scope '${String(scope)}'`);
      }
      maybeLazyReload();
      const findings: IntakeScannerFinding[] = [];
      for (const rule of rules) {
        if (!scanScopeIncludes(scope, rule.scope)) continue;
        if (!rule.regex.test(normalizedText)) continue;
        findings.push({
          ruleId: rule.id,
          labels: rule.labels,
          weight: rule.weight,
          scope: rule.scope,
        });
      }
      return buildScannerResult({ scannerId: INTAKE_RULE_ENGINE_SCANNER_ID, findings });
    },
    reload(): void {
      load();
      lastStalenessCheckMs = now();
    },
    status(): IntakeRuleEngineStatus {
      const status: IntakeRuleEngineStatus = {
        rulesPath,
        ruleCount: rules.length,
        loadedAtMs,
        fingerprint,
      };
      if (lastReloadError !== undefined) status.lastReloadError = lastReloadError;
      return status;
    },
  };
}
