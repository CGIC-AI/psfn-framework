import type { CapabilityTier } from './tier-types.js';
import type { CapabilityToken } from './tokens.js';

export interface CapabilityAccess {
  getTier(): CapabilityTier;
  getGrantedTokens(): ReadonlySet<CapabilityToken>;
  has(token: CapabilityToken): boolean;
}

export type CapabilityAccessProvider = () => CapabilityAccess;
