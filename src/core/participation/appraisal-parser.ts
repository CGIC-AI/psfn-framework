import {
  PARTICIPATION_ACTIONS,
  type ParticipationAction,
  type ParticipationAppraisal,
} from './types.js';
import { isRecord } from '../../shared/utils/types.js';

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
  // 9z2z9: a reasoning model may think aloud (sometimes quoting the contract
  // shape) before its answer. The verdict is the LAST complete object that
  // satisfies the contract; earlier drafts and echoed shapes are skipped.
  const candidates = extractJsonObjectCandidates(raw);
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const appraisal = parseAppraisalObject(candidates[index]!);
    if (appraisal) return appraisal;
  }
  return null;
}

function parseAppraisalObject(jsonObject: string): ParticipationAppraisal | null {
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

/**
 * Collect every complete top-level JSON object in a model response, in order,
 * tolerating a ```json fence or surrounding prose the way the intention
 * appraiser's parser does. Braces inside JSON strings do not count. A
 * truncated trailing object is not complete and is never returned. Returns an
 * empty list (never throws) when no object shape is present.
 */
function extractJsonObjectCandidates(raw: string): string[] {
  if (typeof raw !== 'string') {
    return [];
  }
  const text = raw.trim();
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      if (depth > 0) inString = true;
    } else if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0) objects.push(text.slice(start, index + 1));
    }
  }
  return objects;
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
