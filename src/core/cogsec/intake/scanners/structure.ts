// ── Size/structure caps scanner (htm9.4) ──
//
// Score-only structural signals: oversized input (truncated before any
// regex ran), single oversized lines (markdown/HTML smuggling carriers),
// and raw control characters. Contributes to the envelope score surface;
// most findings carry no taxonomy label because "big" is not an attack
// class by itself.

import {
  buildScannerResult,
  scanScopeIncludes,
  type IntakeScannerFinding,
  type IntakeScannerResult,
  type IntakeScanScope,
} from './types.js';

export const STRUCTURE_SCANNER_ID = 'l1.structure';

const OVERSIZED_LINE_CHARS = 16_384;

export function scanStructure(input: {
  /** Length of the ORIGINAL input, before capping. */
  originalLength: number;
  /** Capped raw text. */
  text: string;
  truncated: boolean;
  scope: IntakeScanScope;
}): IntakeScannerResult {
  const { originalLength, text, truncated, scope } = input;
  const candidates: IntakeScannerFinding[] = [];

  let maxLineLength = 0;
  let lineStart = 0;
  let controlCharCount = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x0A) {
      maxLineLength = Math.max(maxLineLength, index - lineStart);
      lineStart = index + 1;
      continue;
    }
    if ((code < 0x20 && code !== 0x09 && code !== 0x0D) || (code >= 0x7F && code <= 0x9F)) {
      controlCharCount += 1;
    }
  }
  maxLineLength = Math.max(maxLineLength, text.length - lineStart);

  if (truncated) {
    candidates.push({
      ruleId: 'input_truncated',
      labels: [],
      weight: 0.3,
      scope: 'all',
      detail: `input of ${String(originalLength)} chars capped before scanning`,
    });
  }
  if (maxLineLength > OVERSIZED_LINE_CHARS) {
    candidates.push({
      ruleId: 'oversized_line',
      labels: [],
      weight: 0.2,
      scope: 'context',
      detail: `longest line is ${String(maxLineLength)} chars`,
    });
  }
  if (controlCharCount > 0) {
    candidates.push({
      ruleId: 'control_characters',
      labels: ['injection/invisible_text'],
      weight: 0.5,
      scope: 'all',
      detail: `${String(controlCharCount)} raw control character(s)`,
    });
  }

  const findings = candidates.filter((finding) => scanScopeIncludes(scope, finding.scope));
  return buildScannerResult({
    scannerId: STRUCTURE_SCANNER_ID,
    findings,
    extracted: {
      total_chars: String(originalLength),
      scanned_chars: String(text.length),
      max_line_chars: String(maxLineLength),
    },
  });
}
