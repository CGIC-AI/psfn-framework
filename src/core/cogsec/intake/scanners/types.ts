// ── L1 deterministic intake scanners: shared scanner contract (htm9.4) ──
//
// Layer 1 of the cognition intake firewall. Pure TypeScript, in-process,
// synchronous-gate fast: these scanners sit in front of near-real-time audio
// and chat, so every primitive here is hard-bounded (input cap before any
// regex, bounded quantifiers, bounded proximity windows).
//
// Framing (Hermes SECURITY.md): an in-process scanner is a triage/advisory
// aid, NOT a security boundary. L1 contributes riskLabels/scores to the
// intake envelope (htm9.1) and fails OPEN-advisory — it must never be the
// sole gate. Enforcement lives in the envelope decision + sink gates
// (htm9.3), which fail closed.
//
// Scanner contract (llm-guard shape): scan(text) → { sanitized?, labels[],
// score }. Labels come exclusively from the closed taxonomy in
// src/shared/contracts/intake-envelope.ts — scanners never invent labels.

import type { IntakeRiskLabel } from '../../../../shared/contracts/intake-envelope.js';

/**
 * Hard cap on characters scanned by any regex or per-codepoint pass.
 * Context/tool-result strings can be arbitrarily large and L1 is an advisory
 * guard, not archival search; bounding input keeps worst-case runtime
 * predictable while preserving detections near the beginning of injected
 * content. Applied BEFORE any pattern work (Hermes MAX_SCAN_CHARS).
 */
export const MAX_SCAN_CHARS = 65_536;

// ── Scope tiers ──
//
// Ordered, cumulative (all ⊂ context ⊂ strict), mirroring the Hermes
// threat-pattern scopes:
// - 'all':     zero-false-positive classic injection/exfil — safe to apply
//              anywhere, including untrusted tool results.
// - 'context': adds promptware / C2 / role-play patterns — warn-only tier
//              for context files, memory entries, and tool results.
// - 'strict':  adds persistence / SSH / exfil-URL / hardcoded-secret
//              patterns — block-tier checks for user-mediated writes where
//              a false positive can be resolved interactively.

export const INTAKE_SCAN_SCOPES = ['all', 'context', 'strict'] as const;

export type IntakeScanScope = typeof INTAKE_SCAN_SCOPES[number];

export function isIntakeScanScope(value: unknown): value is IntakeScanScope {
  return typeof value === 'string'
    && (INTAKE_SCAN_SCOPES as readonly string[]).includes(value);
}

/**
 * True when a pattern/finding tiered at `patternScope` applies to a scan
 * running at `scanScope`. A pattern scoped 'all' applies at every scan
 * scope; a 'strict' pattern only applies to strict scans.
 */
export function scanScopeIncludes(
  scanScope: IntakeScanScope,
  patternScope: IntakeScanScope,
): boolean {
  return INTAKE_SCAN_SCOPES.indexOf(patternScope) <= INTAKE_SCAN_SCOPES.indexOf(scanScope);
}

// ── Findings and results ──

export interface IntakeScannerFinding {
  /** Rule/detector name. For rule-file rules this doubles as the audit id. */
  ruleId: string;
  /** Envelope taxonomy labels this finding contributes. May be empty for score-only structural findings. */
  labels: readonly IntakeRiskLabel[];
  /** Score contribution in (0, 1]. Combined per scanner via noisy-or. */
  weight: number;
  /** Narrowest scope tier this finding belongs to (already scope-filtered when emitted). */
  scope: IntakeScanScope;
  /** Human-auditable detail. Must never carry raw payload bytes. */
  detail?: string;
}

export interface IntakeScannerResult {
  scannerId: string;
  /** Deduplicated union of finding labels. */
  labels: readonly IntakeRiskLabel[];
  /** Calibrated 0–1 score for this scanner (envelope `scores[scannerId]`). */
  score: number;
  findings: readonly IntakeScannerFinding[];
  /** Transformed text when the scanner sanitizes (llm-guard transform contract). */
  sanitized?: string;
  /** Safe schema-extracted metadata (envelope `extractedFields` candidates). */
  extracted?: Readonly<Record<string, string>>;
}

/** Noisy-or combination: 1 - Π(1 - wᵢ), clamped to [0, 1]. */
export function combineFindingWeights(findings: readonly IntakeScannerFinding[]): number {
  let survival = 1;
  for (const finding of findings) {
    if (!Number.isFinite(finding.weight) || finding.weight < 0 || finding.weight > 1) {
      throw new Error(
        `Intake scanner finding '${finding.ruleId}' has invalid weight ${String(finding.weight)}; must be in [0, 1]`,
      );
    }
    survival *= 1 - finding.weight;
  }
  const score = 1 - survival;
  return Math.round(score * 10_000) / 10_000;
}

export function buildScannerResult(input: {
  scannerId: string;
  findings: readonly IntakeScannerFinding[];
  sanitized?: string;
  extracted?: Readonly<Record<string, string>>;
}): IntakeScannerResult {
  const labels = [...new Set(input.findings.flatMap((finding) => finding.labels))];
  const result: IntakeScannerResult = {
    scannerId: input.scannerId,
    labels,
    score: combineFindingWeights(input.findings),
    findings: input.findings,
  };
  if (input.sanitized !== undefined) result.sanitized = input.sanitized;
  if (input.extracted !== undefined) result.extracted = input.extracted;
  return result;
}

/** Caps scan input BEFORE any regex or per-codepoint pass runs. */
export function capScanText(text: string): { capped: string; truncated: boolean } {
  if (text.length <= MAX_SCAN_CHARS) {
    return { capped: text, truncated: false };
  }
  return { capped: text.slice(0, MAX_SCAN_CHARS), truncated: true };
}
