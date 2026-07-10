export function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function escapeXmlAttributeWithApostrophe(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&#39;');
}

// ── Prompt-embedded free-text sanitizer (S10 cogsec: C2/H6/05-M1/03-L1) ──
//
// `sanitizePromptEmbeddedText` neutralizes external free-text (display names,
// place labels, descriptions, presence labels) BEFORE it is interpolated into
// prompt structure: `[SYSTEM: …]` context notes, `<runtime_*>…</runtime_*>`
// XML-framed sections, and durable situated-location labels. It is NOT a
// general XML escaper — it targets exactly the sequences that let a value
// break out of, or impersonate, a prompt frame, while leaving ordinary
// names/descriptions readable and unchanged.
//
// Deterministic transformation, in order:
//   1. Remove invisible/format characters (zero-width, bidi controls, BOM).
//   2. Replace control characters (C0/C1 incl. \n \r \t) and Unicode
//      line/paragraph separators with a single space.
//   3. Neutralize XML/HTML tag-shaped sequences (`<tag …>`, `</tag>`,
//      `<tag/>`) by swapping their angle brackets for the visually similar
//      but frame-inert `‹` / `›`.
//   4. Neutralize bracket-frame sequences whose leading keyword impersonates
//      a runtime frame (`[SYSTEM …]`, `[Presence] …`, `[INSTRUCTIONS] …`,
//      closed or unclosed) by swapping the square brackets for parentheses.
//      Benign bracket text (`Lab [East Wing]`) is untouched.
//   5. Collapse whitespace runs to a single space and trim.
//   6. Cap length (default 256 chars); truncation appends `…`.

export interface SanitizePromptEmbeddedTextOptions {
  /** Maximum length of the sanitized result. Must be a positive integer. */
  maxLength?: number;
}

export const PROMPT_EMBEDDED_TEXT_DEFAULT_MAX_LENGTH = 256;

/** Zero-width / bidi-control / BOM characters — removed entirely. */
const INVISIBLE_CHAR_PATTERN = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/** C0 + C1 control characters and Unicode line/paragraph separators — become spaces. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_PATTERN = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;

/**
 * XML/HTML tag-shaped sequences: `<tag>`, `</tag>`, `<tag attr="x">`,
 * `<tag/>`. Requires a tag-name character immediately after `<` (or `</`)
 * so comparisons like "5 < x" are left alone.
 */
const TAG_SEQUENCE_PATTERN = /<\/?[a-z][a-z0-9_.:-]*(?:[\s/][^<>]*)?>/gi;

/**
 * Leading keywords that make a `[…]` group read as a runtime frame. Matches
 * the `[SYSTEM: …]` context-note wrapper, the `[Presence]` note tag, and the
 * common instruction-impersonation variants. Deliberately NOT `\[.*\]` — a
 * benign bracketed name must survive unchanged.
 */
const BRACKET_FRAME_KEYWORDS =
  'system|assistant|user|operator|admin|presence|instruction|instructions|important|note|context|tool|function';

/** Closed (`[SYSTEM …]`) or unclosed (`[SYSTEM …`) bracket-frame sequences. */
const BRACKET_FRAME_PATTERN = new RegExp(
  `\\[(\\s*(?:${BRACKET_FRAME_KEYWORDS})\\b[^\\]]*)(\\]?)`,
  'gi',
);

function neutralizeTagSequences(value: string): string {
  return value.replace(TAG_SEQUENCE_PATTERN, (match) =>
    match.replaceAll('<', '‹').replaceAll('>', '›'));
}

function neutralizeBracketFrames(value: string): string {
  return value.replace(BRACKET_FRAME_PATTERN, (_match, body: string, close: string) =>
    `(${body}${close ? ')' : ''}`);
}

/**
 * Sanitize external free-text for safe interpolation into prompt structure
 * (system-attributed notes, XML-framed runtime sections, durable labels).
 * See the module comment above for the exact transformation. Returns '' for
 * empty/whitespace-only input; callers keep their own fail-closed fallbacks.
 */
export function sanitizePromptEmbeddedText(
  value: string,
  options?: SanitizePromptEmbeddedTextOptions,
): string {
  const maxLength = options?.maxLength ?? PROMPT_EMBEDDED_TEXT_DEFAULT_MAX_LENGTH;
  if (!Number.isInteger(maxLength) || maxLength <= 0) {
    throw new Error(`sanitizePromptEmbeddedText: maxLength must be a positive integer, got ${String(options?.maxLength)}`);
  }

  let sanitized = value
    .replace(INVISIBLE_CHAR_PATTERN, '')
    .replace(CONTROL_CHAR_PATTERN, ' ');
  sanitized = neutralizeTagSequences(sanitized);
  sanitized = neutralizeBracketFrames(sanitized);
  sanitized = sanitized.replace(/\s+/g, ' ').trim();

  if (sanitized.length > maxLength) {
    sanitized = `${sanitized.slice(0, maxLength - 1).trimEnd()}…`;
  }
  return sanitized;
}
