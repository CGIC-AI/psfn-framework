import type { CapabilityGrantSnapshot } from '../../system/capabilities/access.js';
import {
  canonicalizeCapabilityTokens,
  deriveShardCapabilityGrant,
  type DerivedShardCapabilityGrant,
} from '../../system/capabilities/shard-derivation.js';
import type { CompanionId } from '../../shared/routing/companion-id.js';
import type { ShardCapabilityGrantEvidence } from './types.js';
import { CompanionVisibleOperationalError } from '../../core/tools/results.js';

/** One atomic authoritative capability-owner read for each shard launch. */
export type ParentCapabilityGrantSnapshotProvider = () => CapabilityGrantSnapshot;

/**
 * Resolve and validate one digest-bound shard grant before any launch side
 * effect. The effective snapshot tokens must agree with the same owner
 * content used by the canonical derivation primitive.
 */
export function resolveShardLaunchCapabilityGrant(
  parentCompanionId: CompanionId,
  snapshotParentCapabilityGrant: ParentCapabilityGrantSnapshotProvider,
): DerivedShardCapabilityGrant {
  const snapshot = snapshotParentCapabilityGrant();
  const capabilityGrant = deriveShardCapabilityGrant({
    companionId: parentCompanionId,
    tier: snapshot.tier,
    customTokens: snapshot.customTokens,
  });
  const snapshotTokens = canonicalizeCapabilityTokens(
    snapshot.grantedTokens,
    'snapshot.grantedTokens',
  );
  if (
    snapshotTokens.length !== capabilityGrant.parent.tokens.length
    || snapshotTokens.some((token, index) => token !== capabilityGrant.parent.tokens[index])
  ) {
    throw new Error(
      'Shard capability derivation: atomic parent snapshot grant does not match its owner content',
    );
  }
  if (!capabilityGrant.parent.tokens.includes('shard.spawn')) {
    throw new CompanionVisibleOperationalError({
      companionMessage: 'Shard launch denied: the parent capability grant does not include shard.spawn.',
      errorClass: 'policy_blocked',
      retryHint: 'try_alternative_input',
      operatorDiagnostic:
        `Shard launch denied: parent companion "${parentCompanionId}" does not grant shard.spawn`,
    });
  }
  return capabilityGrant;
}

export function toShardCapabilityGrantEvidence(
  capabilityGrant: DerivedShardCapabilityGrant,
): ShardCapabilityGrantEvidence {
  return Object.freeze({
    parentTier: capabilityGrant.parent.tier,
    derivedTier: 'custom',
    tokens: capabilityGrant.tokens,
    ownerVersion: capabilityGrant.ownerVersion,
    grantDigest: capabilityGrant.grantDigest,
    denialMask: capabilityGrant.denialMask,
    derivationVersion: capabilityGrant.derivationVersion,
  });
}

export function cloneShardCapabilityGrantEvidence(
  evidence: ShardCapabilityGrantEvidence,
): ShardCapabilityGrantEvidence {
  return Object.freeze({
    ...evidence,
    tokens: Object.freeze([...evidence.tokens]),
    denialMask: Object.freeze([...evidence.denialMask]),
  });
}
