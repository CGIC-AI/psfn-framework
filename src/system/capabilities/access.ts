import type { CapabilityTier } from './tier-types.js';
import type { CapabilityToken } from './tokens.js';

export interface CapabilityAccess {
  getTier(): CapabilityTier;
  getGrantedTokens(): ReadonlySet<CapabilityToken>;
  has(token: CapabilityToken): boolean;
}

/**
 * Resolves capability access, optionally for a specific authenticated companion
 * (an52.3). A single-companion runtime ignores the argument; a multi-companion
 * gateway resolves the connecting companion's own capability tier.
 */
export type CapabilityAccessProvider = (companionId?: string) => CapabilityAccess;
