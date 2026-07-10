// ── L1 deterministic intake scanner pipeline (htm9.4) ──
//
// The synchronous, in-process first firewall layer. htm9.2 wiring calls
// createIntakeL1Scanner() once at composition and scan() per inbound item;
// the report's riskLabels/scores map 1:1 onto the intake envelope's
// screening transition inputs (htm9.1), and sanitizedText is the
// transform-not-just-gate output (llm-guard contract).
//
// ORDERING (load-bearing, ported from the Hermes scanner):
//   0. cap input at MAX_SCAN_CHARS — BEFORE any regex or codepoint pass;
//   1. invisible/zero-width detection on the RAW capped string (NFKC can
//      alter codepoints we need to see) → strip;
//   2. datamark-marker detection/stripping on the stripped raw text;
//   3. NFKC-normalize (folds full-width homoglyphs onto ASCII keywords);
//   4. everything else — rule engine, encoding smuggling, URLs,
//      secrets/PII — runs on the normalized text, so zero-width-obfuscated
//      keywords are matched after de-obfuscation;
//   5. secrets redaction produces the final sanitized text.
//
// FAILURE POSTURE: L1 is triage, not a security boundary (Hermes
// SECURITY.md). A scanner that throws is recorded in scannerErrors and the
// rest of the report is still produced — fail OPEN-advisory, errors always
// visible, never swallowed. Construction, by contrast, fails CLOSED: a
// missing or invalid rule file throws at composition time. L1 output never
// includes a decision; quarantine/block authority belongs to the envelope
// policy and the sink gates (htm9.3).

import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { IntakeRiskLabel } from '../../../../shared/contracts/intake-envelope.js';
import {
  createIntakeRuleEngine,
  INTAKE_L1_RULES_FILE_NAME,
  INTAKE_RULE_ENGINE_SCANNER_ID,
  type IntakeRuleEngine,
  type IntakeRuleEngineStatus,
} from './rule-engine.js';
import { scanInvisibleText } from './invisible-text.js';
import { INTAKE_DATAMARK_MARKER, scanDatamark } from './datamark.js';
import { scanEncodingSmuggling } from './encoding-smuggling.js';
import { scanUrls } from './urls.js';
import { scanSecretsPii } from './secrets-pii.js';
import { scanStructure } from './structure.js';
import {
  capScanText,
  isIntakeScanScope,
  INTAKE_SCAN_SCOPES,
  type IntakeScannerResult,
  type IntakeScanScope,
} from './types.js';

export * from './types.js';
export * from './proximity.js';
export {
  compileIntakeL1RuleFile,
  createIntakeRuleEngine,
  INTAKE_L1_RULES_FILE_NAME,
  INTAKE_RULE_ENGINE_SCANNER_ID,
} from './rule-engine.js';
export type {
  IntakeL1Rule,
  IntakeL1RuleFile,
  IntakeL1RuleMatch,
  IntakeRuleEngine,
  IntakeRuleEngineOptions,
  IntakeRuleEngineStatus,
} from './rule-engine.js';
export { INVISIBLE_TEXT_SCANNER_ID, scanInvisibleText, stripInvisibleCodePoints } from './invisible-text.js';
export { DATAMARK_SCANNER_ID, INTAKE_DATAMARK_MARKER, scanDatamark } from './datamark.js';
export { ENCODING_SMUGGLING_SCANNER_ID, scanEncodingSmuggling } from './encoding-smuggling.js';
export { scanUrls, URL_SCANNER_ID } from './urls.js';
export { scanSecretsPii, SECRETS_PII_SCANNER_ID } from './secrets-pii.js';
export { scanStructure, STRUCTURE_SCANNER_ID } from './structure.js';

export interface IntakeL1ScannerConfig {
  /** Rule file path. Default: `${CONFIG_DIR ?? ./config}/intake-l1-rules.json`. */
  rulesPath?: string;
  /** See IntakeRuleEngineOptions.reloadCheckIntervalMs. Default 5000ms. */
  reloadCheckIntervalMs?: number;
  /** Default known-domain allowlist for the URL scanner. */
  knownDomains?: readonly string[];
  /** Default active datamark markers (htm9.13 hook). */
  datamarkMarkers?: readonly string[];
}

export interface IntakeL1ScanOptions {
  scope: IntakeScanScope;
  /** Per-scan override of the configured allowlist. */
  knownDomains?: readonly string[];
  /** Per-scan override of the configured markers. */
  datamarkMarkers?: readonly string[];
}

export interface IntakeL1ScannerError {
  scannerId: string;
  message: string;
}

export interface IntakeL1ScanReport {
  scope: IntakeScanScope;
  /** True when the input exceeded MAX_SCAN_CHARS and was capped pre-regex. */
  truncated: boolean;
  /** Deduplicated union across scanners — envelope riskLabels input. */
  riskLabels: readonly IntakeRiskLabel[];
  /** Per-scanner 0–1 scores keyed by scanner id — envelope scores input. */
  scores: Readonly<Record<string, number>>;
  results: readonly IntakeScannerResult[];
  /**
   * Invisible-stripped, datamark-stripped, NFKC-normalized, secret-redacted
   * text (capped). Substituting it for the raw content is a policy decision
   * (htm9.3 'sanitize'), not L1's.
   */
  sanitizedText: string;
  /** True when sanitizedText differs from the original input. */
  sanitizedDiffers: boolean;
  /** Merged scanner extractions, keyed `<scannerId>.<key>` — envelope extractedFields input. */
  extractedFields: Readonly<Record<string, string>>;
  /** Scanner failures (fail-open-advisory: visible, never swallowed). */
  scannerErrors: readonly IntakeL1ScannerError[];
  elapsedMs: number;
}

export interface IntakeL1Scanner {
  scan(text: string, options: IntakeL1ScanOptions): IntakeL1ScanReport;
  /** Explicit hot reload of the rule file; throws on an invalid file. */
  reloadRules(): void;
  rulesStatus(): IntakeRuleEngineStatus;
}

export function defaultIntakeL1RulesPath(): string {
  return join(process.env.CONFIG_DIR ?? './config', INTAKE_L1_RULES_FILE_NAME);
}

const MAX_EXTRACTED_FIELDS = 64;
const MAX_EXTRACTED_KEY_CHARS = 128;
const MAX_EXTRACTED_VALUE_CHARS = 4_096;

export function createIntakeL1Scanner(config: IntakeL1ScannerConfig = {}): IntakeL1Scanner {
  const engineOptions: Parameters<typeof createIntakeRuleEngine>[0] = {
    rulesPath: config.rulesPath ?? defaultIntakeL1RulesPath(),
  };
  if (config.reloadCheckIntervalMs !== undefined) {
    engineOptions.reloadCheckIntervalMs = config.reloadCheckIntervalMs;
  }
  // Fails closed here if the rule file is missing or invalid.
  const ruleEngine: IntakeRuleEngine = createIntakeRuleEngine(engineOptions);

  function scan(text: string, options: IntakeL1ScanOptions): IntakeL1ScanReport {
    if (typeof text !== 'string') {
      throw new Error('Intake L1 scan input must be a string');
    }
    if (!isIntakeScanScope(options.scope)) {
      throw new Error(
        `Intake L1 scan scope must be one of: ${INTAKE_SCAN_SCOPES.join(', ')} (got '${String(options.scope)}')`,
      );
    }
    const scope = options.scope;
    const startedMs = performance.now();
    const results: IntakeScannerResult[] = [];
    const scannerErrors: IntakeL1ScannerError[] = [];

    function run(scannerId: string, step: () => IntakeScannerResult): IntakeScannerResult | null {
      try {
        const result = step();
        results.push(result);
        return result;
      } catch (error) {
        scannerErrors.push({
          scannerId,
          message: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    }

    // 0. Cap before ANY pattern work.
    const { capped, truncated } = capScanText(text);

    // 1. Invisible/zero-width detection on the RAW capped string.
    const invisibleResult = run('l1.invisible_text', () => scanInvisibleText(capped, scope));
    const afterInvisible = invisibleResult?.sanitized ?? capped;

    // 2. Datamark forgery stripping on the stripped raw text. The active
    //    marker (htm9.13) is always in scope: inbound occurrences are forged
    //    by definition, since the renderer marks only AFTER screening.
    const markers = options.datamarkMarkers
      ?? config.datamarkMarkers
      ?? [INTAKE_DATAMARK_MARKER];
    const datamarkResult = run('l1.datamark', () => scanDatamark(
      afterInvisible,
      scope,
      { markers },
    ));
    const afterDatamark = datamarkResult?.sanitized ?? afterInvisible;

    // 3. NFKC-normalize (AFTER raw invisible detection).
    const normalized = afterDatamark.normalize('NFKC');

    // 4. Structure + rule engine + encoding + URLs + secrets on normalized.
    run('l1.structure', () => scanStructure({
      originalLength: text.length,
      text: capped,
      truncated,
      scope,
    }));
    const ruleResult = run(INTAKE_RULE_ENGINE_SCANNER_ID, () => ruleEngine.scan(normalized, scope));
    run('l1.encoding', () => scanEncodingSmuggling(normalized, scope));
    const knownDomains = options.knownDomains ?? config.knownDomains;
    run('l1.urls', () => scanUrls(
      normalized,
      scope,
      knownDomains === undefined ? {} : { knownDomains },
    ));
    const secretsResult = run('l1.secrets_pii', () => scanSecretsPii(normalized, scope));

    // A failed lazy rule reload must be visible on every report until fixed.
    if (ruleResult !== null) {
      const reloadError = ruleEngine.status().lastReloadError;
      if (reloadError !== undefined) {
        scannerErrors.push({
          scannerId: INTAKE_RULE_ENGINE_SCANNER_ID,
          message: `rule file reload failed; scanning with last-good rules: ${reloadError}`,
        });
      }
    }

    // 5. Final sanitized text.
    const sanitizedText = secretsResult?.sanitized ?? normalized;

    const riskLabels = [...new Set(results.flatMap((result) => result.labels))];
    const scores: Record<string, number> = {};
    for (const result of results) {
      scores[result.scannerId] = result.score;
    }
    const extractedFields: Record<string, string> = {};
    for (const result of results) {
      if (result.extracted === undefined) continue;
      for (const [key, value] of Object.entries(result.extracted)) {
        if (Object.keys(extractedFields).length >= MAX_EXTRACTED_FIELDS) break;
        const namespacedKey = `${result.scannerId}.${key}`.slice(0, MAX_EXTRACTED_KEY_CHARS);
        extractedFields[namespacedKey] = value.slice(0, MAX_EXTRACTED_VALUE_CHARS);
      }
    }

    return {
      scope,
      truncated,
      riskLabels,
      scores,
      results,
      sanitizedText,
      sanitizedDiffers: sanitizedText !== text,
      extractedFields,
      scannerErrors,
      elapsedMs: performance.now() - startedMs,
    };
  }

  return {
    scan,
    reloadRules(): void {
      ruleEngine.reload();
    },
    rulesStatus(): IntakeRuleEngineStatus {
      return ruleEngine.status();
    },
  };
}
