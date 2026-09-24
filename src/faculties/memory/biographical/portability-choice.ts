// ── Companion portability choice (psfn-framework-uz787) ──
//
// The companion may choose that one of her own reviewed baseline claims travels
// everywhere (`universal` portability) while KEEPING its sensitivity. This is
// the policy-gated sibling of the publication choice (publication.ts), which
// lowers sensitivity to `public` and grants universal reach together.
//
// Gates, all fail closed:
//   * the owner-file policy `biographicalCandidatePolicy.companionPortabilityChoice`
//     must be present and enabled (absent means off);
//   * the claim must be active and companion-self: no related subject, no
//     participants, so no human is ever carried everywhere by her choice;
//   * its effective sensitivity must be at or below the policy ceiling, which
//     the policy itself caps at `personal`; the store re-runs the kernel's
//     portability invariant on write.
//
// There is no grant: grants only ever lower sensitivity, and this choice does
// not. The durable record is the claim's portability column. Revoking a
// publication choice on the same claim also returns it to `origin_only`.

import type { BiographicalCandidatePolicy } from '../../../system/config/biographical-candidate-policy.js';
import type { SensitivityLevel } from '../../../system/trust/types.js';
import type { BiographicalProfileStorePort } from './store-port.js';
import type { BiographicalClaim } from './types.js';

const SENSITIVITY_ORDER: readonly SensitivityLevel[] = ['public', 'personal', 'intimate', 'confidential'];

type BiographicalPortabilityChoiceRefusal =
  | 'policy_disabled'
  | 'claim_not_found'
  | 'claim_not_active'
  | 'claim_names_a_person'
  | 'sensitivity_above_ceiling';

export class BiographicalPortabilityChoiceRefusedError extends Error {
  constructor(readonly reason: BiographicalPortabilityChoiceRefusal, claimId: string) {
    super(`companion portability choice refused (${reason}): ${claimId}`);
    this.name = 'BiographicalPortabilityChoiceRefusedError';
  }
}

export async function recordCompanionPortabilityChoice(input: {
  readonly store: BiographicalProfileStorePort;
  readonly policy: BiographicalCandidatePolicy;
  readonly claimId: string;
  readonly now?: Date;
}): Promise<BiographicalClaim> {
  const choicePolicy = input.policy.companionPortabilityChoice;
  if (choicePolicy?.enabled !== true) {
    throw new BiographicalPortabilityChoiceRefusedError('policy_disabled', input.claimId);
  }
  const claim = await input.store.getClaim(input.claimId);
  if (claim === undefined) {
    throw new BiographicalPortabilityChoiceRefusedError('claim_not_found', input.claimId);
  }
  if (claim.status !== 'active') {
    throw new BiographicalPortabilityChoiceRefusedError('claim_not_active', input.claimId);
  }
  if (claim.subject.kind !== 'companion'
    || claim.relatedSubject !== undefined
    || claim.participants !== undefined) {
    throw new BiographicalPortabilityChoiceRefusedError('claim_names_a_person', input.claimId);
  }
  if (SENSITIVITY_ORDER.indexOf(claim.effectiveSensitivity)
    > SENSITIVITY_ORDER.indexOf(choicePolicy.maximumSensitivity)) {
    throw new BiographicalPortabilityChoiceRefusedError('sensitivity_above_ceiling', input.claimId);
  }
  return await input.store.setClaimPortability({
    claimId: claim.id,
    portabilityScope: 'universal',
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
}

/** Withdraw the choice: the claim returns to its origin room immediately. */
export async function revokeCompanionPortabilityChoice(input: {
  readonly store: BiographicalProfileStorePort;
  readonly claimId: string;
  readonly now?: Date;
}): Promise<BiographicalClaim> {
  return await input.store.setClaimPortability({
    claimId: input.claimId,
    portabilityScope: 'origin_only',
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
}
