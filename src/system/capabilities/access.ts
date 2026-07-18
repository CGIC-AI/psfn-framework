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

/**
 * One coherent tier+token snapshot of the authoritative capability owner
 * (mus2.1). Every field is resolved from the SAME validated owner read —
 * unlike sequenced `getTier()`/`getGrantedTokens()` calls, which may each
 * refresh and therefore mix two owner-file versions. `customTokens` is the
 * owner's authoritative custom token list (canonical order) and
 * `grantedTokens` is the effective grant resolved from that same content.
 */
export interface CapabilityGrantSnapshot {
  readonly tier: CapabilityTier;
  readonly customTokens: readonly CapabilityToken[];
  readonly grantedTokens: readonly CapabilityToken[];
}
