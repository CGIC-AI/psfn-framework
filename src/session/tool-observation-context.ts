export type ToolObservationContextDisplayMode = 'full' | 'summary';

export interface ToolObservationContextShape {
  summary: string;
  displayMode: ToolObservationContextDisplayMode;
}

const MAX_INLINE_TOOL_CONTEXT_CHARS = 280;
const MAX_INLINE_TOOL_CONTEXT_LINES = 2;
const MAX_CONTEXT_SUMMARY_CHARS = 240;
const MAX_JSON_SUMMARY_PARTS = 4;
const MAX_JSON_KEY_SUMMARY = 5;
const SAFE_SCALAR_TEXT_PATTERN = /^[A-Za-z0-9 _./:-]+$/;
const SECRET_LIKE_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{12,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:eyJ[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{16,})\b/,
];
const MACHINE_TEXT_MARKERS = [
  'stdout:',
  'stderr:',
  'exitcode',
  'traceback',
  'exception',
  'stack trace',
  'stacktrace',
];
const LOG_LINE_PATTERNS = [
  /^\d{4}-\d{2}-\d{2}[ t]/i,
  /^\[[A-Z0-9:_ -]{2,}\]/,
  /^\s*at\s+\S+/,
  /^traceback\b/i,
  /^(?:stdout|stderr):/i,
];
const PRIORITY_SCALAR_KEYS = [
  'status',
  'ok',
  'success',
  'error',
  'reason',
  'message',
  'count',
  'total',
  'matched',
  'found',
  'updated',
  'created',
  'deleted',
] as const;

export function deriveToolObservationContextShape(content: string): ToolObservationContextShape {
  const normalized = normalizeSummaryWhitespace(content);
  if (!normalized) {
    return {
      summary: '(no text tool output)',
      displayMode: 'full',
    };
  }

  if (shouldInlineToolObservation(normalized)) {
    return {
      summary: normalized,
      displayMode: 'full',
    };
  }

  const structuredSummary = summarizeStructuredPayload(normalized);
  if (structuredSummary) {
    return {
      summary: truncateSummary(structuredSummary),
      displayMode: 'summary',
    };
  }

  const narrativeSummary = summarizeSafeNarrativeLines(normalized);
  if (narrativeSummary) {
    return {
      summary: truncateSummary(narrativeSummary),
      displayMode: 'summary',
    };
  }

  return {
    summary: truncateSummary(buildGenericToolOutputSummary(normalized)),
    displayMode: 'summary',
  };
}

function shouldInlineToolObservation(content: string): boolean {
  return (
    countContentLines(content) <= MAX_INLINE_TOOL_CONTEXT_LINES
    && content.length <= MAX_INLINE_TOOL_CONTEXT_CHARS
    && !looksLikeStructuredPayload(content)
    && !looksLikeMachineText(content)
    && !containsSecretLikeValue(content)
    && !hasOversizedToken(content)
  );
}

function summarizeStructuredPayload(content: string): string | null {
  const trimmed = content.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed = tryParseJson(trimmed);
    if (parsed !== null) {
      return summarizeJsonValue(parsed);
    }
  }

  if (trimmed.startsWith('<')) {
    return 'Returned markup payload. Raw output omitted from chat context.';
  }

  return null;
}

function summarizeJsonValue(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return 'Returned empty JSON array.';
    }

    const firstRecord = value.find(isRecord);
    const fieldSummary = firstRecord
      ? summarizeObjectKeys(firstRecord, 'fields')
      : null;
    return fieldSummary
      ? `Returned JSON array (${value.length} items) with ${fieldSummary}.`
      : `Returned JSON array (${value.length} items).`;
  }

  if (!isRecord(value)) {
    const primitive = summarizePrimitive(value);
    return primitive
      ? `Returned JSON value ${primitive}.`
      : 'Returned JSON payload. Raw output omitted from chat context.';
  }

  const parts = [
    ...summarizePriorityScalars(value),
    ...summarizeCollectionCounts(value),
  ].slice(0, MAX_JSON_SUMMARY_PARTS);

  if (parts.length > 0) {
    return `Returned JSON object: ${parts.join('; ')}.`;
  }

  const keySummary = summarizeObjectKeys(value, 'keys');
  return keySummary
    ? `Returned JSON object with ${keySummary}.`
    : 'Returned empty JSON object.';
}

function summarizePriorityScalars(value: Record<string, unknown>): string[] {
  const summaries: string[] = [];
  for (const key of PRIORITY_SCALAR_KEYS) {
    if (!(key in value)) continue;
    const primitive = summarizePrimitive(value[key]);
    if (!primitive) continue;
    summaries.push(`${key}=${primitive}`);
  }
  return summaries;
}

function summarizeCollectionCounts(value: Record<string, unknown>): string[] {
  const summaries: string[] = [];
  for (const [key, candidate] of Object.entries(value)) {
    if (!Array.isArray(candidate)) continue;
    summaries.push(`${key}=${candidate.length}`);
    if (summaries.length >= MAX_JSON_SUMMARY_PARTS) {
      break;
    }
  }
  return summaries;
}

function summarizeObjectKeys(value: Record<string, unknown>, label: 'keys' | 'fields'): string | null {
  const keys = Object.keys(value)
    .filter(key => key.trim().length > 0)
    .slice(0, MAX_JSON_KEY_SUMMARY);
  if (keys.length === 0) {
    return null;
  }
  return `${label}: ${keys.join(', ')}`;
}

function summarizePrimitive(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(Math.trunc(value) === value ? Math.trunc(value) : value);
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = normalizeSummaryWhitespace(value);
  if (
    !normalized
    || normalized.length > 48
    || containsSecretLikeValue(normalized)
    || !SAFE_SCALAR_TEXT_PATTERN.test(normalized)
  ) {
    return null;
  }

  return normalized;
}

function summarizeSafeNarrativeLines(content: string): string | null {
  const candidates = content
    .split('\n')
    .map(line => normalizeSummaryWhitespace(line))
    .filter(line => line.length > 0)
    .filter(line => isSafeNarrativeLine(line))
    .slice(0, 2);

  if (candidates.length === 0) {
    return null;
  }

  return candidates.join(' ');
}

function isSafeNarrativeLine(line: string): boolean {
  return (
    line.length <= MAX_CONTEXT_SUMMARY_CHARS
    && !looksLikeStructuredPayload(line)
    && !looksLikeMachineText(line)
    && !containsSecretLikeValue(line)
    && !hasOversizedToken(line)
  );
}

function buildGenericToolOutputSummary(content: string): string {
  const lineCount = Math.max(1, countContentLines(content));
  const lineLabel = lineCount === 1 ? 'line' : 'lines';
  const hasCredentialLikeValue = containsSecretLikeValue(content);
  const hasWarnings = /\bwarning\b/i.test(content);
  const hasErrors = /\b(error|failed|exception|denied|timeout)\b/i.test(content);

  if (hasCredentialLikeValue) {
    return `Captured ${lineCount} ${lineLabel} of text output with credential-like values omitted.`;
  }
  if (hasErrors) {
    return `Captured ${lineCount} ${lineLabel} of error output.`;
  }
  if (hasWarnings) {
    return `Captured ${lineCount} ${lineLabel} of tool output with warnings.`;
  }
  return `Captured ${lineCount} ${lineLabel} of text output.`;
}

function looksLikeStructuredPayload(content: string): boolean {
  const trimmed = content.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('<');
}

function looksLikeMachineText(content: string): boolean {
  const normalized = content.toLowerCase();
  if (MACHINE_TEXT_MARKERS.some(marker => normalized.includes(marker))) {
    return true;
  }

  const lines = content.split('\n');
  if (lines.length >= 3 && lines.some(line => LOG_LINE_PATTERNS.some(pattern => pattern.test(line)))) {
    return true;
  }

  return false;
}

function containsSecretLikeValue(content: string): boolean {
  return SECRET_LIKE_PATTERNS.some(pattern => pattern.test(content));
}

function hasOversizedToken(content: string): boolean {
  return /\S{48,}/.test(content);
}

function countContentLines(content: string): number {
  return content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .length;
}

function truncateSummary(summary: string): string {
  const normalized = normalizeSummaryWhitespace(summary);
  if (normalized.length <= MAX_CONTEXT_SUMMARY_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_CONTEXT_SUMMARY_CHARS - 3)}...`;
}

function normalizeSummaryWhitespace(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

function tryParseJson(content: string): unknown | null {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
