// ── Stream-eligibility predicate (psfn-framework-mmo9.8.1) ──
//
// `isStreamEligible` is a PURE TOTAL function of a TurnPreparation snapshot: it
// never throws, performs no I/O, and inspects no reply content. A turn is
// stream-eligible iff ALL of E1..E6 hold. Ineligible turns fall back to the
// existing final-only voice path (unchanged).
//
// The criteria structurally exclude every whole-reply withdrawal/replacement
// gate so that a committed segment can never be withdrawn (Law 18); see the
// safety proof in working_docs/briefs/mmo9.8-plan.txt §3.

import type { EligibilityCriterion, EligibilityResult, TurnPreparation } from './types.js';

/**
 * E5: a turn is low-risk only when trust is at/above threshold, there is no
 * pending paid deliverable, and the context is a known-contact DM. Anything
 * else is high-risk (conservative / fail-closed).
 */
function isHighRisk(prep: TurnPreparation): boolean {
  const { risk } = prep;
  const lowRisk =
    risk.trustLevel >= risk.trustThreshold
    && !risk.hasPendingPaidDeliverable
    && risk.contactContext === 'dm_known_contact';
  return !lowRisk;
}

/**
 * Deterministic total predicate. Returns every failing criterion in E1..E6
 * order; `eligible` is true iff none failed.
 */
export function isStreamEligible(prep: TurnPreparation): EligibilityResult {
  const failed: EligibilityCriterion[] = [];

  // E1 — tool-free dispatch (structurally single-round).
  if (prep.toolDispatch !== 'tool_free') failed.push('E1_tool_free');

  // E2 — no vision / attachment input.
  if (prep.hasAttachmentInput || prep.isVisionTurn) failed.push('E2_no_vision_attachment');

  // E3 — not a broadcast channel.
  if (prep.broadcast) failed.push('E3_not_broadcast');

  // E4 — not fatigue-suppressed.
  if (prep.fatigueSuppressed) failed.push('E4_not_fatigue_suppressed');

  // E5 — not high-risk.
  if (isHighRisk(prep)) failed.push('E5_not_high_risk');

  // E6 — live generation (not served from dedup / in-flight cache).
  if (!prep.liveGeneration) failed.push('E6_live_generation');

  return { eligible: failed.length === 0, failed };
}
