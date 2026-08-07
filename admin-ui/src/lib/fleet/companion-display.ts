import { createCompanionDisplayIdentityResolver } from '../../../../src/shared/companion-display-identity.js';

export interface CompanionDisplayProjection {
  readonly companionId: string;
  readonly displayName: string;
}

const unknownDisplayIdentity = createCompanionDisplayIdentityResolver([]);

/**
 * Resolve the primary label from the authorized server projection. Unknown ids
 * stay explicit; this display helper never grants or implies authority.
 */
export function companionDisplayLabel(
  companions: readonly CompanionDisplayProjection[],
  companionId: string | null,
): string {
  if (!companionId) return 'Unknown companion';
  return companions.find(companion => companion.companionId === companionId)?.displayName
    ?? unknownDisplayIdentity.resolve(companionId).displayLabel;
}

/** Exact stable id for an explicit technical-details affordance. */
export function companionTechnicalLabel(companionId: string): string {
  return unknownDisplayIdentity.resolve(companionId).technicalLabel;
}
