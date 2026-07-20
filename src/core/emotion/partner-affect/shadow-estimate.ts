// Shadow-only Partner Affect Estimate projection (docs/partner-affect.md,
// slice 1).
//
// Deterministic and model-free: the same accepted observations and policy
// always produce the same estimate and explanation. The projection summarizes
// evidence health per Signal Family — freshness, coverage, missingness,
// confidence, cross-source conflict — and answers only `unknown` vs
// `ordinary`. Insufficient, stale, low-confidence, or conflicting evidence is
// `unknown`; it is never promoted to an ordinary/healthy claim. There is no
// posture, score, or directional deviation in this slice, and the output is
// unreachable as behavioral authority (Garden inspection only).

import {
  PARTNER_AFFECT_SCHEMA_VERSION,
  PARTNER_AFFECT_SIGNAL_FAMILIES,
  type PartnerAffectAssertionBasis,
  type PartnerAffectEstimateReason,
  type PartnerAffectFamilyEvidence,
  type PartnerAffectObservation,
  type PartnerAffectShadowEstimate,
  type PartnerAffectShadowPolicy,
  type PartnerAffectSignalFamily,
} from '../../../shared/contracts/partner-affect.js';

export interface PartnerAffectShadowEstimateInput {
  observations: readonly PartnerAffectObservation[];
  policy: PartnerAffectShadowPolicy;
  nowMs: number;
}

/**
 * Two fresh values for the same family+metric from different sources conflict
 * when they disagree beyond the configured tolerance, scaled by magnitude so
 * the same policy value works across units: |a - b| > tol * max(1, |a|, |b|).
 * Conflicts stay explicit in the family record and block `ordinary`; they are
 * never averaged away and never declare either source false.
 */
function valuesConflict(a: number, b: number, tolerance: number): boolean {
  return Math.abs(a - b) > tolerance * Math.max(1, Math.abs(a), Math.abs(b));
}

function familyEvidence(
  family: PartnerAffectSignalFamily,
  observations: readonly PartnerAffectObservation[],
  policy: PartnerAffectShadowPolicy,
  nowMs: number,
): PartnerAffectFamilyEvidence {
  const familyObservations = observations.filter(observation => observation.signalFamily === family);
  const fresh = familyObservations.filter(
    observation => nowMs - observation.observedAtMs <= policy.evidenceWindowMs,
  );
  const latestObservedAtMs = familyObservations.length > 0
    ? Math.max(...familyObservations.map(observation => observation.observedAtMs))
    : null;

  let conflict = false;
  const byMetric = new Map<string, PartnerAffectObservation[]>();
  for (const observation of fresh) {
    const bucket = byMetric.get(observation.metricName) ?? [];
    bucket.push(observation);
    byMetric.set(observation.metricName, bucket);
  }
  for (const bucket of byMetric.values()) {
    for (let left = 0; left < bucket.length && !conflict; left += 1) {
      for (let right = left + 1; right < bucket.length; right += 1) {
        if (bucket[left].sourceId === bucket[right].sourceId) continue;
        if (valuesConflict(bucket[left].value, bucket[right].value, policy.conflictValueTolerance)) {
          conflict = true;
          break;
        }
      }
    }
  }

  const assertionBases = [...new Set(fresh.map(observation => observation.assertion))]
    .sort() as PartnerAffectAssertionBasis[];
  return {
    family,
    freshObservationCount: fresh.length,
    latestObservedAtMs,
    freshness: fresh.length > 0 ? 'fresh' : familyObservations.length > 0 ? 'stale' : 'missing',
    confidence: fresh.length > 0 ? Math.max(...fresh.map(observation => observation.confidence)) : 0,
    coverage: fresh.length > 0 ? Math.max(...fresh.map(observation => observation.coverage)) : 0,
    missingness: fresh.length > 0 ? Math.min(...fresh.map(observation => observation.missingness)) : 1,
    conflict,
    contributingSourceIds: [...new Set(fresh.map(observation => observation.sourceId))].sort(),
    assertionBases,
  };
}

/**
 * Compute the slice-1 shadow estimate from accepted observations. The family
 * list always covers every policy-allowed Signal Family so missing evidence
 * stays explicit rather than disappearing from the explanation.
 */
export function computePartnerAffectShadowEstimate(
  input: PartnerAffectShadowEstimateInput,
): PartnerAffectShadowEstimate {
  const { policy } = input;
  const nowMs = Math.floor(input.nowMs);
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new Error('computePartnerAffectShadowEstimate requires a finite non-negative nowMs');
  }

  // Defensive partner scoping: only observations bound to the configured
  // canonical partner may contribute, even if the store handed back more.
  const observations = policy.partnerContactId === null
    ? []
    : input.observations.filter(observation => observation.partnerContactId === policy.partnerContactId);

  const families = PARTNER_AFFECT_SIGNAL_FAMILIES
    .filter(family => policy.allowedSignalFamilies.includes(family))
    .map(family => familyEvidence(family, observations, policy, nowMs));

  const reasons: PartnerAffectEstimateReason[] = [];
  if (policy.partnerContactId === null) {
    reasons.push('partner_unbound');
  }
  const freshFamilies = families.filter(family => family.freshness === 'fresh');
  if (freshFamilies.length === 0) {
    reasons.push('no_fresh_evidence');
  } else if (freshFamilies.length < policy.minIndependentFamilies) {
    reasons.push('insufficient_family_quorum');
  }
  if (freshFamilies.some(family => family.conflict)) {
    reasons.push('conflicting_evidence');
  }
  if (freshFamilies.length > 0 && freshFamilies.some(family => family.confidence < policy.minConfidence)) {
    reasons.push('low_confidence_evidence');
  }

  const status = reasons.length === 0 ? 'ordinary' : 'unknown';
  if (status === 'ordinary') {
    reasons.push('quorum_met');
  }

  return {
    schemaVersion: PARTNER_AFFECT_SCHEMA_VERSION,
    partnerContactId: policy.partnerContactId,
    computedAtMs: nowMs,
    evidenceWindowMs: policy.evidenceWindowMs,
    status,
    reasons,
    families,
    derivation: 'deterministic_shadow_v1',
    policyRevision: policy.policyRevision,
  };
}
