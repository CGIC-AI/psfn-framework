import type { CapabilityTier } from './tier-types.js';
import type { CapabilityToken } from './tokens.js';

export interface CapabilityAccess {
  getTier(): CapabilityTier;
  getGrantedTokens(): ReadonlySet<CapabilityToken>;
  has(token: CapabilityToken): boolean;
  /**
   * Optional per-companion tool exclusion set from `capability-tier.json`
   * (`disabledTools`). Omitted on minimal test doubles, which treat no tools
   * as overridden.
   */
  getDisabledTools?(): ReadonlySet<string>;
  isToolDisabled?(toolName: string): boolean;
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
 * owner's authoritative custom token list (canonical order), `grantedTokens`
 * is the effective grant resolved from that same content, and `disabledTools`
 * lists any per-companion excluded tool names in canonical order.
 */
export interface CapabilityGrantSnapshot {
  readonly tier: CapabilityTier;
  readonly customTokens: readonly CapabilityToken[];
  readonly grantedTokens: readonly CapabilityToken[];
  readonly disabledTools?: readonly string[];
}
