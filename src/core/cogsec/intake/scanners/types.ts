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

import {
  INTAKE_L1_SCAN_MAX_CHARS,
  truncateUtf16AtCodePointBoundary,
} from '../../../../shared/contracts/intake-envelope.js';
import {
  INTAKE_SCAN_SCOPES,
  type IntakeScannerFinding,
  type IntakeScannerResult,
  type IntakeScanScope,
} from '../../../../shared/contracts/intake-screening-port.js';

export {
  INTAKE_SCAN_SCOPES,
  type IntakeScannerFinding,
  type IntakeScannerResult,
  type IntakeScanScope,
};

/**
 * Hard cap on characters scanned by any regex or per-codepoint pass.
 * Context/tool-result strings can be arbitrarily large and L1 is an advisory
 * guard, not archival search; bounding input keeps worst-case runtime
 * predictable while preserving detections near the beginning of injected
 * content. Applied before raw pattern work and again after any transform that
 * may expand UTF-16 length (Hermes MAX_SCAN_CHARS).
 */
export const MAX_SCAN_CHARS = INTAKE_L1_SCAN_MAX_CHARS;

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
  return {
    capped: truncateUtf16AtCodePointBoundary(text, MAX_SCAN_CHARS),
    truncated: true,
  };
}
