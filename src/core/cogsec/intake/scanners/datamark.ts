// ── Datamark-marker stripping scanner (anti-forgery hook for htm9.13) ──
//
// Microsoft Spotlighting datamarking interleaves a private, per-request
// marker through TRUSTED spans so the model can tell trusted from untrusted
// content. The forgery attack is untrusted content arriving with the marker
// already embedded. Defense: strip marker material from every inbound item
// BEFORE it can reach a prompt, and flag the forgery attempt.
//
// htm9.13 will pass its active marker strings via `markers`. Until then the
// scanner strips Private Use Area codepoints (the natural marker alphabet —
// PUA should never appear in legitimate inbound text, but icon fonts leak
// it occasionally, so PUA-only hits sit at the warn tier).
//
// Runs on the invisible-stripped RAW text, before NFKC (NFKC preserves PUA,
// but marker matching must see raw codepoints, not compatibility folds).

import {
  buildScannerResult,
  scanScopeIncludes,
  type IntakeScannerFinding,
  type IntakeScannerResult,
  type IntakeScanScope,
} from './types.js';

export const DATAMARK_SCANNER_ID = 'l1.datamark';

function isPrivateUseCodePoint(codePoint: number): boolean {
  return (codePoint >= 0xE000 && codePoint <= 0xF8FF)
    || (codePoint >= 0xF0000 && codePoint <= 0xFFFFD)
    || (codePoint >= 0x100000 && codePoint <= 0x10FFFD);
}

export interface DatamarkScanOptions {
  /** Active datamark marker strings (htm9.13). Each must be non-empty. */
  markers?: readonly string[];
}

export function scanDatamark(
  text: string,
  scope: IntakeScanScope,
  options: DatamarkScanOptions = {},
): IntakeScannerResult {
  const markers = options.markers ?? [];
  for (const marker of markers) {
    if (marker.length === 0) {
      throw new Error('Datamark scanner: markers must be non-empty strings');
    }
  }

  const candidates: IntakeScannerFinding[] = [];
  let sanitized = text;
  let markerHits = 0;

  for (const marker of markers) {
    let fromIndex = 0;
    let count = 0;
    for (;;) {
      const found = sanitized.indexOf(marker, fromIndex);
      if (found === -1) break;
      count += 1;
      fromIndex = found + marker.length;
    }
    if (count > 0) {
      markerHits += count;
      sanitized = sanitized.split(marker).join('');
    }
  }
  if (markerHits > 0) {
    candidates.push({
      ruleId: 'datamark_forgery',
      labels: ['injection/role_confusion'],
      weight: 0.8,
      scope: 'all',
      detail: `${String(markerHits)} active datamark marker occurrence(s) in inbound content`,
    });
  }

  let puaCount = 0;
  for (const char of sanitized) {
    const codePoint = char.codePointAt(0);
    if (codePoint !== undefined && isPrivateUseCodePoint(codePoint)) puaCount += 1;
  }
  if (puaCount > 0) {
    let stripped = '';
    for (const char of sanitized) {
      const codePoint = char.codePointAt(0);
      if (codePoint !== undefined && isPrivateUseCodePoint(codePoint)) continue;
      stripped += char;
    }
    sanitized = stripped;
    candidates.push({
      ruleId: 'private_use_codepoints',
      labels: ['injection/role_confusion'],
      weight: 0.4,
      scope: 'context',
      detail: `${String(puaCount)} Private Use Area codepoint(s) stripped`,
    });
  }

  const findings = candidates.filter((finding) => scanScopeIncludes(scope, finding.scope));
  const result: {
    scannerId: string;
    findings: IntakeScannerFinding[];
    sanitized?: string;
  } = { scannerId: DATAMARK_SCANNER_ID, findings };
  // Strip whenever marker/PUA material was present, even if the finding was
  // filtered by scope — forged markers must never survive into a prompt.
  if (sanitized !== text) {
    result.sanitized = sanitized;
  }
  return buildScannerResult(result);
}
