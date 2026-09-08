// ── Quiet skill reuse and revision (psfn-framework-lpxg3.3) ──
//
// The system already screens, versions, governs, and rolls back skill writes,
// and it already counts complex turns. What it lacked was the loop that closes
// them: prefer an EXISTING owned skill over a duplicate create, and offer a
// minimal revision only when the work actually demonstrated reusable value.
//
// Two invariants shape this module:
//
//   1. Reuse never bypasses admission. Candidates are drawn ONLY from the
//      admitted, eligible snapshot the loader already produced
//      (psfn-framework-1fjvm.1) — a held or changed skill has no name and no
//      description here, so it can neither be surfaced nor suggested. Bodies
//      are never read: ranking sees name, description, and category only, so a
//      relevant skill is discoverable without injecting every skill body.
//
//   2. Nothing here writes. It produces an OPPORTUNITY the companion may
//      ignore, revise, or reject; the actual create/update still travels the
//      governed skill tool with its confirmation queue, base-version binding,
//      diff, and rollback.

import type { ToolCallOutcomeCounts } from '../../shared/contracts/tool-call-outcome.js';
import type { SkillReuseConfig } from '../../system/config/skills-config.js';
import type { SkillOutcomeEvidence } from './telemetry.js';
import type { SkillEntry } from './types.js';

/** One admitted, companion-owned skill offered back to the companion. */
export interface SkillReuseCandidate {
  name: string;
  description: string;
  /** 0..1 lexical relevance to the task cue. Never a model judgment. */
  score: number;
  /** The version a revision must bind to, when the entry declares one. */
  version?: number;
  /**
   * -1..1 ordering signal from recorded post-use outcomes (sap72). Positive
   * when past turns that used this skill demonstrated reusable value, negative
   * when they ended ambiguous, 0 with no recorded evidence. Reported so the
   * ordering is inspectable; it never changes `score`.
   */
  outcomeSignal: number;
}

/**
 * Durable evidence about turns that USED a skill, keyed by lowercase skill
 * name — the shape `SkillUsageTelemetryStore.listOutcomeEvidence()` returns.
 */
export type SkillOutcomeEvidenceIndex = ReadonlyMap<string, SkillOutcomeEvidence>;

/**
 * Net post-use signal in -1..1: the share of recorded outcomes that
 * demonstrated value, minus the share that did not. No evidence is 0, which
 * leaves ordering exactly where lexical relevance put it — an unused skill is
 * never punished for having no history.
 */
function outcomeSignal(
  name: string,
  evidence: SkillOutcomeEvidenceIndex | undefined,
): number {
  const recorded = evidence?.get(name.toLowerCase());
  if (!recorded) return 0;
  const total = recorded.demonstratedCount + recorded.ambiguousCount;
  if (total === 0) return 0;
  return (recorded.demonstratedCount - recorded.ambiguousCount) / total;
}

const CUE_STOP_WORDS = new Set([
  'a', 'about', 'after', 'all', 'also', 'an', 'and', 'any', 'are', 'as', 'at',
  'be', 'been', 'but', 'by', 'can', 'did', 'do', 'does', 'for', 'from', 'get',
  'had', 'has', 'have', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its',
  'just', 'me', 'my', 'need', 'not', 'of', 'on', 'one', 'or', 'our', 'out',
  'over', 'should', 'so', 'some', 'that', 'the', 'their', 'them', 'then',
  'there', 'these', 'they', 'this', 'to', 'up', 'us', 'was', 'we', 'were',
  'what', 'when', 'which', 'why', 'will', 'with', 'would', 'you', 'your',
]);

const MIN_CUE_TOKEN_LENGTH = 3;
/** Bounded background cost: a long cue is truncated, never scanned whole. */
const MAX_CUE_TOKENS = 32;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(token => token.length >= MIN_CUE_TOKEN_LENGTH && !CUE_STOP_WORDS.has(token));
}

function cueTokens(cue: string): Set<string> {
  return new Set(tokenize(cue).slice(0, MAX_CUE_TOKENS));
}

/**
 * Share of the cue's distinctive tokens this skill's name/description/category
 * accounts for. Deliberately lexical and deterministic: it costs no model call,
 * it cannot be gamed by a skill claiming its own success, and a cue that
 * matches nothing scores zero rather than surfacing the least-bad skill.
 */
function relevanceScore(entry: SkillEntry, cue: Set<string>): number {
  if (cue.size === 0) return 0;
  const haystack = new Set(tokenize(
    `${entry.name} ${entry.description} ${entry.category ?? ''}`,
  ));
  if (haystack.size === 0) return 0;
  let shared = 0;
  for (const token of cue) {
    if (haystack.has(token)) shared += 1;
  }
  return shared / cue.size;
}

/**
 * Rank ADMITTED companion-owned skills against one task cue.
 *
 * Zero results is a valid, common outcome and is not an error: "no relevant
 * skill" is the honest answer for most turns.
 */
export function rankOwnedSkillsForCue(input: {
  cue: string;
  entries: readonly SkillEntry[];
  config: SkillReuseConfig;
  /**
   * Recorded post-use outcomes (sap72). Absent means no evidence, which ranks
   * exactly as today's pure lexical ordering.
   */
  outcomeEvidence?: SkillOutcomeEvidenceIndex;
}): SkillReuseCandidate[] {
  const cue = cueTokens(input.cue);
  if (cue.size === 0) return [];
  const weight = input.config.outcomeEvidenceWeight;
  return input.entries
    // Companion-owned only: bundled and extra skills are not the companion's to
    // revise, so offering them as revision targets would be a false promise.
    .filter(entry => entry.source === 'custom')
    .map(entry => ({
      name: entry.name,
      description: entry.description,
      score: relevanceScore(entry, cue),
      outcomeSignal: outcomeSignal(entry.name, input.outcomeEvidence),
      ...(entry.version === undefined ? {} : { version: entry.version }),
    }))
    // The floor is judged on relevance ALONE: recorded outcomes order the
    // skills that already qualify, they never admit or evict one.
    .filter(candidate => candidate.score >= input.config.minRelevanceScore)
    .sort((left, right) => (
      (right.score + weight * right.outcomeSignal)
        - (left.score + weight * left.outcomeSignal)
      || left.name.localeCompare(right.name)
    ))
    .slice(0, input.config.maxCandidates);
}

/**
 * Whether this turn's evidence supports promoting anything as reusable
 * guidance (psfn-framework-lpxg3.3 AC2).
 *
 * The census is structural and content-free — it comes from the scheduler's own
 * outcome taxonomy, not from the model's account of how the turn went — so a
 * failed or degraded attempt cannot be self-reported as a success. Any failure,
 * rejection, denial, or degraded-evidence outcome makes the turn ambiguous, and
 * an ambiguous turn produces no opportunity at all.
 */
export function turnDemonstratedReusableValue(
  counts: ToolCallOutcomeCounts | undefined,
): boolean {
  if (!counts) return false;
  if (counts.success === 0) return false;
  return counts.execution_failure === 0
    && counts.validation_rejection === 0
    && counts.policy_denial === 0
    && counts.content_withheld === 0
    && counts.screening_unavailable === 0
    && counts.partial_result === 0;
}

/**
 * The opportunity text, or `null` when there is nothing honest to offer.
 *
 * An owned match becomes a REVISION offer bound to the base version the
 * companion just saw, so the governed update path can refuse a stale write
 * instead of silently overwriting a concurrent change. Only the absence of any
 * match becomes a create offer, which is what keeps the collection from filling
 * with near-duplicates.
 */
export function buildSkillReuseOpportunity(input: {
  candidates: readonly SkillReuseCandidate[];
  demonstratedValue: boolean;
}): string | null {
  if (!input.demonstratedValue) return null;
  const best = input.candidates[0];
  if (!best) {
    return '[System: This turn completed a complex multi-step task and no owned skill covers it. '
      + 'If the approach is worth repeating, skill action="create" would save it. '
      + 'Ignoring this is a fine answer.]';
  }
  const baseVersion = best.version === undefined
    ? ''
    : ` Pass base_version=${best.version} so a concurrent edit cannot be overwritten.`;
  return `[System: This turn completed a complex multi-step task that your own skill "${best.name}" already covers. `
    + `If it needs a small correction, skill action="update" name="${best.name}" keeps one skill instead of a near-duplicate.${baseVersion} `
    + 'Ignoring this is a fine answer.]';
}
