// ── Companion publication choice for an exact self-nickname claim (o61vb.3) ──
//
// "The companion herself chooses which exact nicknames may become public. The
// system/operator may not invent or auto-select them." (operator refinement
// 2026-08-09). A publication choice is an EXACT digest-bound lowering grant:
// it lowers ONE normalized claim (bound to that claim's claimDigest AND its
// sourceSetDigest) to `public`. Approval of one nickname never authorizes
// another, because every nickname claim has a distinct claimDigest and the
// grant will not match a different claim's digests.
//
// The companion proposes; deterministic policy disposes. Recording a choice
// does not invent a nickname, auto-select a canonical one, or move the raw
// private source: it authorizes the already-validated structured claim to
// project into public destinations. Revoking a choice takes effect immediately
// (the claim reverts to its automatic sensitivity), and any bound source-set
// digest drift invalidates the choice without a separate revoke.

import type { SensitivityLevel } from '../../../system/trust/types.js';
import type { BiographicalSensitivityGrant } from './types.js';
import type {
  BiographicalGrantRevokeInput,
  BiographicalGrantWriteInput,
  BiographicalProfileStorePort,
} from './store-port.js';

/**
 * Authority basis stamped on every companion publication-choice grant. The
 * grant records that the companion (not the system or operator) chose to
 * publish this exact claim.
 */
export const COMPANION_PUBLICATION_AUTHORITY_BASIS = 'companion-publication-choice' as const;

export interface CompanionPublicationChoiceInput {
  /** Existing active self-nickname claim the companion chooses to publish. */
  readonly claimId: string;
  /** The companion's stated reason for publishing this exact nickname. */
  readonly reason: string;
  readonly now?: Date;
}

/**
 * Record the companion's choice to publish one exact self-nickname claim. The
 * grant is bound to the claim's current claimDigest and sourceSetDigest and
 * lowers it to `public`. Because the grant is digest-bound, it authorizes only
 * that nickname: a different nickname claim (distinct claimDigest) is
 * unaffected, and source-set drift on this claim invalidates the grant without
 * a separate revoke.
 *
 * Reads the claim first so a non-existent or non-active claim fails closed
 * rather than recording an orphan grant.
 */
export async function recordCompanionPublicationChoice(input: {
  store: BiographicalProfileStorePort;
  choice: CompanionPublicationChoiceInput;
}): Promise<BiographicalSensitivityGrant> {
  const claim = await input.store.getClaim(input.choice.claimId);
  if (claim === undefined) {
    throw new Error(`cannot publish unknown biographical claim: ${input.choice.claimId}`);
  }
  if (claim.status !== 'active') {
    throw new Error(
      `cannot publish a claim that is not active (status ${claim.status}): ${input.choice.claimId}`,
    );
  }
  const grantInput: BiographicalGrantWriteInput = {
    claimDigest: claim.claimDigest,
    sourceSetDigest: claim.sourceSetDigest,
    grantedSensitivity: 'public' satisfies SensitivityLevel,
    authorizingActor: 'companion',
    authorityBasis: COMPANION_PUBLICATION_AUTHORITY_BASIS,
    reason: input.choice.reason,
    ...(input.choice.now !== undefined ? { now: input.choice.now } : {}),
  };
  return input.store.recordGrant(grantInput);
}

/**
 * Revoke a companion publication choice. The claim reverts to its automatic
 * sensitivity immediately. Increasing restriction never requires publication
 * review.
 */
export async function revokeCompanionPublicationChoice(input: {
  store: BiographicalProfileStorePort;
  grantId: string;
  revoke: Pick<BiographicalGrantRevokeInput, 'reason'> & { now?: Date };
}): Promise<BiographicalSensitivityGrant> {
  return input.store.revokeGrant(input.grantId, {
    reason: input.revoke.reason,
    ...(input.revoke.now !== undefined ? { now: input.revoke.now } : {}),
  });
}
