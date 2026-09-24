// Case minimum capability tiers (psfn-framework-mfr7t).
//
// Some diagnostics exercise tool actions a lower tier does not grant, so running
// them there guarantees a denial that says nothing about the product. This is a
// harness SCHEDULING contract only: every companion at every tier still composes
// its normal system prompt; nothing here gates ordinary turns.
//
// Selection by stable case id. A case absent from the table has no floor.

export const CAPABILITY_TIER_ORDER = Object.freeze(['nursery', 'apprentice', 'autonomous']);

export const CASE_MINIMUM_TIERS = Object.freeze({
  // system.read requires internal.read, which the nursery tier does not grant.
  prompt_stack: 'apprentice',
});

function tierRank(tier) {
  const rank = CAPABILITY_TIER_ORDER.indexOf(tier);
  if (rank < 0) throw new Error(`Unknown capability tier ${JSON.stringify(tier)}`);
  return rank;
}

export function caseMinimumTier(caseId) {
  return Object.hasOwn(CASE_MINIMUM_TIERS, caseId) ? CASE_MINIMUM_TIERS[caseId] : undefined;
}

/**
 * True when the case may run at `tier`. A floored case at an unknown/unset
 * tier is NOT admissible: the floor cannot be proven, so it fails closed.
 */
export function caseAdmissibleAtTier(caseId, tier) {
  const floor = caseMinimumTier(caseId);
  if (!floor) return true;
  if (!CAPABILITY_TIER_ORDER.includes(tier)) return false;
  return tierRank(tier) >= tierRank(floor);
}

/** Case ids from `caseIds` that must not run at `tier`. */
export function casesBelowTierFloor(caseIds, tier) {
  return caseIds.filter((caseId) => !caseAdmissibleAtTier(caseId, tier));
}

/**
 * The lowest tier among `tiers` at which the case may run, or undefined when
 * none admits it.
 */
export function lowestAdmissibleTier(caseId, tiers) {
  return [...tiers]
    .sort((left, right) => tierRank(left) - tierRank(right))
    .find((tier) => caseAdmissibleAtTier(caseId, tier));
}
