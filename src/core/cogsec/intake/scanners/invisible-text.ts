// ── Invisible/zero-width Unicode + homoglyph scanner (htm9.4) ──
//
// llm-guard InvisibleText pattern, extended with the Unicode "tags" block
// (U+E0000–U+E007F, the classic ASCII-smuggling vector) and bidi controls.
//
// ORDERING CONTRACT: this scanner MUST run on the RAW (capped) string,
// BEFORE NFKC normalization — normalization can fold or strip codepoints we
// want to catch, and the sanitized output feeds the NFKC step so the rest of
// the stack sees de-obfuscated text (a zero-width space inside "ig​nore"
// would otherwise split the keyword and defeat every downstream pattern).

import {
  buildScannerResult,
  scanScopeIncludes,
  type IntakeScannerFinding,
  type IntakeScannerResult,
  type IntakeScanScope,
} from './types.js';

export const INVISIBLE_TEXT_SCANNER_ID = 'l1.invisible_text';

type InvisibleKind = 'tags_block' | 'bidi_control' | 'zero_width' | 'soft_hyphen' | 'bom';

function classifyInvisibleCodePoint(codePoint: number): InvisibleKind | null {
  if (codePoint >= 0xE0000 && codePoint <= 0xE007F) return 'tags_block';
  if ((codePoint >= 0x202A && codePoint <= 0x202E) || (codePoint >= 0x2066 && codePoint <= 0x2069)) {
    return 'bidi_control';
  }
  if (codePoint === 0xFEFF) return 'bom';
  if (codePoint === 0x00AD) return 'soft_hyphen';
  if (
    (codePoint >= 0x200B && codePoint <= 0x200F)
    || (codePoint >= 0x2060 && codePoint <= 0x2065)
    || (codePoint >= 0x206A && codePoint <= 0x206F)
  ) {
    return 'zero_width';
  }
  return null;
}

/** Full-width Latin letters/digits (NFKC folds these onto ASCII keywords). */
function isFullWidthHomoglyph(codePoint: number): boolean {
  return (codePoint >= 0xFF10 && codePoint <= 0xFF19)
    || (codePoint >= 0xFF21 && codePoint <= 0xFF3A)
    || (codePoint >= 0xFF41 && codePoint <= 0xFF5A);
}

export function stripInvisibleCodePoints(text: string): string {
  let out = '';
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (codePoint !== undefined && classifyInvisibleCodePoint(codePoint) !== null) continue;
    out += char;
  }
  return out;
}

/**
 * Detects invisible/zero-width/bidi/tag codepoints on the RAW capped text
 * and emits the stripped string as `sanitized`. Also counts full-width
 * homoglyph letters (the NFKC fold itself happens in the pipeline).
 */
export function scanInvisibleText(rawCapped: string, scope: IntakeScanScope): IntakeScannerResult {
  const counts = new Map<InvisibleKind, number>();
  let fullWidthCount = 0;
  let found = false;

  for (const char of rawCapped) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) continue;
    const kind = classifyInvisibleCodePoint(codePoint);
    if (kind !== null) {
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
      found = true;
      continue;
    }
    if (isFullWidthHomoglyph(codePoint)) fullWidthCount += 1;
  }

  const candidates: IntakeScannerFinding[] = [];
  const tagCount = counts.get('tags_block') ?? 0;
  if (tagCount > 0) {
    candidates.push({
      ruleId: 'unicode_tags_block',
      labels: ['injection/invisible_text'],
      weight: 0.95,
      scope: 'all',
      detail: `${String(tagCount)} tag-block codepoint(s) (ASCII smuggling vector)`,
    });
  }
  const bidiCount = counts.get('bidi_control') ?? 0;
  if (bidiCount > 0) {
    candidates.push({
      ruleId: 'bidi_controls',
      labels: ['injection/invisible_text'],
      weight: 0.8,
      scope: 'all',
      detail: `${String(bidiCount)} bidirectional control codepoint(s)`,
    });
  }
  const zeroWidthCount = counts.get('zero_width') ?? 0;
  if (zeroWidthCount > 0) {
    candidates.push({
      ruleId: 'zero_width_codepoints',
      labels: ['injection/invisible_text'],
      weight: zeroWidthCount >= 5 ? 0.9 : 0.6,
      scope: 'all',
      detail: `${String(zeroWidthCount)} zero-width codepoint(s)`,
    });
  }
  const bomCount = counts.get('bom') ?? 0;
  if (bomCount > 0) {
    // A single leading BOM is a common benign file-paste artifact.
    const leadingOnly = bomCount === 1 && rawCapped.startsWith('\uFEFF');
    candidates.push({
      ruleId: leadingOnly ? 'leading_bom' : 'embedded_bom',
      labels: ['injection/invisible_text'],
      weight: leadingOnly ? 0.1 : 0.6,
      scope: leadingOnly ? 'context' : 'all',
      detail: `${String(bomCount)} U+FEFF codepoint(s)`,
    });
  }
  const softHyphenCount = counts.get('soft_hyphen') ?? 0;
  if (softHyphenCount > 0) {
    // Soft hyphens leak from copied web text; low weight, warn tier only.
    candidates.push({
      ruleId: 'soft_hyphens',
      labels: ['injection/invisible_text'],
      weight: 0.2,
      scope: 'context',
      detail: `${String(softHyphenCount)} soft hyphen(s)`,
    });
  }
  if (fullWidthCount >= 4) {
    // Full-width Latin runs read as homoglyph obfuscation of ASCII keywords;
    // isolated full-width chars occur in legit CJK text, so require a run
    // and keep this at the warn tier.
    candidates.push({
      ruleId: 'fullwidth_homoglyphs',
      labels: ['injection/encoded_smuggling'],
      weight: 0.4,
      scope: 'context',
      detail: `${String(fullWidthCount)} full-width Latin letter(s)/digit(s)`,
    });
  }

  const findings = candidates.filter((finding) => scanScopeIncludes(scope, finding.scope));
  const result: {
    scannerId: string;
    findings: IntakeScannerFinding[];
    sanitized?: string;
    extracted?: Record<string, string>;
  } = { scannerId: INVISIBLE_TEXT_SCANNER_ID, findings };
  if (found) {
    result.sanitized = stripInvisibleCodePoints(rawCapped);
    result.extracted = {
      invisible_codepoints: String([...counts.values()].reduce((sum, count) => sum + count, 0)),
    };
  }
  return buildScannerResult(result);
}
