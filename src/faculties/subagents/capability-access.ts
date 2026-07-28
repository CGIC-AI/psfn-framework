import type {
  CapabilityAccess,
  CapabilityGrantSnapshot,
} from '../../system/capabilities/access.js';
import { resolveTierCapabilityTokens } from '../../system/capabilities/tiers.js';
import {
  isCapabilityToken,
  normalizeCapabilityTokens,
  type CapabilityToken,
} from '../../system/capabilities/tokens.js';

const GENERAL_SUBAGENT_READ_TOKENS: readonly CapabilityToken[] = Object.freeze([
  'identity.read',
  'internal.read',
  'git.read',
  'issue.read',
  'world.read',
]);

export interface DerivedSubagentCapabilityGrant {
  readonly access: CapabilityAccess;
  readonly parentTier: CapabilityGrantSnapshot['tier'];
  readonly deniedExplicitTokens: readonly CapabilityToken[];
}

function assertParentSnapshotCoherent(snapshot: CapabilityGrantSnapshot): readonly CapabilityToken[] {
  const customTokens = normalizeCapabilityTokens(
    snapshot.customTokens,
    'subagent parent customTokens',
  );
  const grantedTokens = normalizeCapabilityTokens(
    snapshot.grantedTokens,
    'subagent parent grantedTokens',
  );
  const expectedTokens = resolveTierCapabilityTokens(snapshot.tier, customTokens);
  const expectedSet = new Set(expectedTokens);
  if (
    grantedTokens.length !== expectedSet.size
    || grantedTokens.some(token => !expectedSet.has(token))
  ) {
    throw new Error(
      'Automata capability derivation requires an atomic parent snapshot whose effective '
      + 'tokens match its tier and customTokens.',
    );
  }
  return grantedTokens;
}

/**
 * Derive one immutable child grant from the advertised spawn request and one
 * atomic parent-owner snapshot. `general` expands only to read capabilities;
 * explicit capability tokens remain opt-in and can never exceed the parent.
 * Non-capability routing tags stay available on the task record but grant no
 * tool authority.
 */
export function deriveSubagentCapabilityGrant(
  snapshot: CapabilityGrantSnapshot,
  advertisedCapabilities: readonly string[],
): DerivedSubagentCapabilityGrant {
  const parentTokens = assertParentSnapshotCoherent(snapshot);
  const parentTokenSet = new Set(parentTokens);
  const requestedTokens = new Set<CapabilityToken>();
  const explicitTokens = new Set<CapabilityToken>();

  if (advertisedCapabilities.includes('general')) {
    for (const token of GENERAL_SUBAGENT_READ_TOKENS) {
      requestedTokens.add(token);
    }
  }
  for (const advertised of advertisedCapabilities) {
    if (isCapabilityToken(advertised)) {
      requestedTokens.add(advertised);
      explicitTokens.add(advertised);
    }
  }

  const grantedTokens = [...requestedTokens].filter(token => parentTokenSet.has(token));
  const deniedExplicitTokens = [...explicitTokens].filter(token => !parentTokenSet.has(token));
  const grantedTokenSet: ReadonlySet<CapabilityToken> = new Set(grantedTokens);
  const access: CapabilityAccess = Object.freeze({
    getTier: () => 'custom' as const,
    getGrantedTokens: () => grantedTokenSet,
    has: (token: CapabilityToken) => grantedTokenSet.has(token),
  });

  return Object.freeze({
    access,
    parentTier: snapshot.tier,
    deniedExplicitTokens: Object.freeze(deniedExplicitTokens),
  });
}
