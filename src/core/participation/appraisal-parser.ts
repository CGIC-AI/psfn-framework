import {
  PARTICIPATION_ACTIONS,
  type ParticipationAction,
  type ParticipationAppraisal,
} from './types.js';

/**
 * Strict parser for the participation appraiser's ternary output contract
 * (bible §8.2). The appraiser is tool-less and its ONLY authority is to pick
 * one of ignore/react/reply, so this parser is deliberately narrow:
 *
 * - The `action` is validated against the closed enum — anything else (an
 *   injected instruction, a fourth "action", prose) yields `null`, which the
 *   caller maps to a fail-closed `ignore`.
 * - `react` REQUIRES a bounded `reactionClass`; a `react` without one is
 *   rejected (fail closed to ignore) rather than promoted to a wordless action
 *   on malformed output.
 * - `reasonCode`/`confidence` are coerced defensively (they are advisory
 *   telemetry, not security-load-bearing): a missing/oversized reason collapses
 *   to a safe placeholder, and confidence is clamped to [0, 1].
 *
 * Returning `null` (not throwing) keeps the hot observe path allocation-cheap;
 * the caller owns the fail-closed decision and its telemetry.
 */
export function parseParticipationAppraisal(raw: string): ParticipationAppraisal | null {
  const jsonObject = extractJsonObject(raw);
  if (jsonObject === null) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonObject);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }

  const action = parseAction(parsed.action);
  if (action === null) {
    return null;
  }

  const reasonCode = normalizeReasonCode(parsed.reasonCode);
  const confidence = normalizeConfidence(parsed.confidence);

  if (action === 'react') {
    const reactionClass = normalizeReactionClass(parsed.reactionClass);
    if (reactionClass === null) {
      // A reaction with no class is malformed; fail closed rather than react.
      return null;
    }
    return { action, reasonCode, confidence, reactionClass };
  }

  return { action, reasonCode, confidence };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Pull the first balanced-looking JSON object out of a model response,
 * tolerating a ```json fence or leading/trailing prose the way the intention
 * appraiser's parser does. Returns `null` (never throws) when no object shape
 * is present.
 */
function extractJsonObject(raw: string): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(trimmed);
  if (fenced?.[1]) {
    const body = fenced[1].trim();
    if (body.startsWith('{') && body.endsWith('}')) {
      return body;
    }
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return null;
}

function parseAction(value: unknown): ParticipationAction | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return (PARTICIPATION_ACTIONS as readonly string[]).includes(normalized)
    ? (normalized as ParticipationAction)
    : null;
}

function normalizeReasonCode(value: unknown): string {
  const reasonCharCap = 64;
  if (typeof value !== 'string') {
    return 'unspecified';
  }
  const cleaned = value.replace(/\s+/gu, '_').replace(/[^\w.-]/gu, '').trim();
  if (cleaned.length === 0) {
    return 'unspecified';
  }
  return cleaned.slice(0, reasonCharCap);
}

function normalizeConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

function normalizeReactionClass(value: unknown): string | null {
  const reactionClassCharCap = 48;
  if (typeof value !== 'string') {
    return null;
  }
  const cleaned = value.replace(/\s+/gu, '_').replace(/[^\w.-]/gu, '').trim();
  if (cleaned.length === 0) {
    return null;
  }
  return cleaned.slice(0, reactionClassCharCap);
}
