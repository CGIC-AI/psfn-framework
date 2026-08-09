import type { BiographicalClaim, BiographicalSensitivityGrant } from './types.js';
import {
  assertClaimTransition,
  deserializeClaim,
  finalizeBiographicalClaim,
  prepareBiographicalClaim,
  prepareBiographicalGrant,
  reevaluateClaimEffective,
  serializeClaim,
  type BiographicalClaimListOptions,
  type BiographicalClaimWriteInput,
  type BiographicalGrantRevokeInput,
  type BiographicalGrantWriteInput,
  type BiographicalProfileStorePort,
  type BiographicalSupersessionInput,
  type BiographicalSupersessionResult,
  type BiographicalTransitionInput,
  type PreparedBiographicalClaim,
} from './store-port.js';
import { BiographicalLifecycleError } from './kernel.js';
import { assertKnownClaimKind } from './claim-kinds.js';
import type { BiographicalSubjectRef } from './types.js';

interface StoredClaimRow {
  readonly id: string;
  readonly claimJson: string;
}

interface StoredGrantRow {
  readonly grant: BiographicalSensitivityGrant;
}

function matchesSubject(
  subject: BiographicalSubjectRef | undefined,
  candidate: BiographicalClaim,
): boolean {
  if (subject === undefined) return true;
  if (subject.kind !== candidate.subject.kind) return false;
  return subject.kind === 'companion'
    ? candidate.subject.kind === 'companion' && subject.companionId === candidate.subject.companionId
    : candidate.subject.kind === 'contact' && subject.contactId === candidate.subject.contactId;
}

/**
 * In-memory adapter for {@link BiographicalProfileStorePort}. Used by tests and
 * as the parity reference for the Postgres adapter. All deterministic behavior
 * lives in the shared store-port helpers, so this class is storage only.
 */
export class InMemoryBiographicalProfileStore implements BiographicalProfileStorePort {
  private readonly claims = new Map<string, StoredClaimRow>();
  private readonly grants = new Map<string, StoredGrantRow>();
  private claimInsertionOrder = 0;
  private readonly orderById = new Map<string, number>();

  private readClaim(id: string): BiographicalClaim {
    const row = this.claims.get(id);
    if (!row) throw new Error(`biographical claim not found: ${id}`);
    return deserializeClaim(row.claimJson);
  }

  private storeClaim(claim: BiographicalClaim): void {
    this.claims.set(claim.id, { id: claim.id, claimJson: serializeClaim(claim) });
    if (!this.orderById.has(claim.id)) {
      this.orderById.set(claim.id, this.claimInsertionOrder++);
    }
  }

  private grantsByDigests(
    claimDigest: string,
    sourceSetDigest: string,
  ): BiographicalSensitivityGrant[] {
    return [...this.grants.values()]
      .map(row => row.grant)
      .filter(
        grant => grant.claimDigest === claimDigest && grant.sourceSetDigest === sourceSetDigest,
      );
  }

  private reevaluateClaimsForDigests(
    claimDigest: string,
    sourceSetDigest: string,
    now: Date,
  ): void {
    for (const row of this.claims.values()) {
      const claim = deserializeClaim(row.claimJson);
      if (claim.claimDigest !== claimDigest || claim.sourceSetDigest !== sourceSetDigest) continue;
      const grants = this.grantsByDigests(claimDigest, sourceSetDigest);
      const updated = reevaluateClaimEffective(claim, grants, now);
      this.storeClaim(updated);
    }
  }

  async writeClaim(input: BiographicalClaimWriteInput): Promise<BiographicalClaim> {
    const now = input.now ?? new Date();
    const prepared: PreparedBiographicalClaim = prepareBiographicalClaim(input);
    const grants = this.grantsByDigests(prepared.claimDigest, prepared.sourceSetDigest);
    const claim = finalizeBiographicalClaim(prepared, grants, now);
    this.storeClaim(claim);
    return claim;
  }

  async getClaim(id: string): Promise<BiographicalClaim | undefined> {
    const row = this.claims.get(id);
    return row ? deserializeClaim(row.claimJson) : undefined;
  }

  async listClaims(options: BiographicalClaimListOptions = {}): Promise<BiographicalClaim[]> {
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    const results: BiographicalClaim[] = [];
    const ordered = [...this.claims.values()].sort(
      (left, right) => (this.orderById.get(left.id) ?? 0) - (this.orderById.get(right.id) ?? 0),
    );
    for (const row of ordered) {
      const claim = deserializeClaim(row.claimJson);
      if (options.subject !== undefined && !matchesSubject(options.subject, claim)) continue;
      if (options.kind !== undefined && claim.kind !== options.kind) continue;
      if (options.status !== undefined && claim.status !== options.status) continue;
      if (
        options.includeTerminal !== true
        && (claim.status === 'superseded' || claim.status === 'revoked')
      ) {
        continue;
      }
      results.push(claim);
      if (results.length >= limit) break;
    }
    return results;
  }

  async supersedeClaim(
    input: BiographicalSupersessionInput,
  ): Promise<BiographicalSupersessionResult> {
    const now = input.now ?? new Date();
    const prior = this.readClaim(input.supersededClaimId);
    if (prior.status === 'superseded' || prior.status === 'revoked') {
      throw new BiographicalLifecycleError(
        `claim ${input.supersededClaimId} is already terminal (${prior.status})`,
      );
    }
    const prepared = prepareBiographicalClaim(
      {
        id: undefined,
        subject: input.subject,
        ...(input.relatedSubject !== undefined ? { relatedSubject: input.relatedSubject } : {}),
        kind: input.kind,
        value: input.value,
        basis: input.basis,
        ...(input.proposedSensitivity !== undefined
          ? { proposedSensitivity: input.proposedSensitivity }
          : {}),
        confidence: input.confidence,
        sources: input.sources,
        ...(input.validFrom !== undefined ? { validFrom: input.validFrom } : {}),
        ...(input.validTo !== undefined ? { validTo: input.validTo } : {}),
        ...(input.depthDecision !== undefined ? { depthDecision: input.depthDecision } : {}),
        status: 'candidate',
        supersedesClaimId: input.supersededClaimId,
        now,
      },
    );
    const grants = this.grantsByDigests(prepared.claimDigest, prepared.sourceSetDigest);
    const superseding = finalizeBiographicalClaim(prepared, grants, now);
    assertKnownClaimKind(prior.kind);
    const superseded: BiographicalClaim = {
      ...prior,
      status: 'superseded',
      lastSourceValidatedAt: now.toISOString(),
    };
    this.storeClaim(superseded);
    this.storeClaim(superseding);
    return { superseded, superseding };
  }

  async transitionClaim(input: BiographicalTransitionInput): Promise<BiographicalClaim> {
    const now = input.now ?? new Date();
    const claim = this.readClaim(input.claimId);
    assertClaimTransition(claim, input.to, now);
    const updated: BiographicalClaim = {
      ...claim,
      status: input.to,
      lastSourceValidatedAt: now.toISOString(),
    };
    this.storeClaim(updated);
    return updated;
  }

  async recordGrant(input: BiographicalGrantWriteInput): Promise<BiographicalSensitivityGrant> {
    const { id, grant } = prepareBiographicalGrant(input);
    const fullGrant: BiographicalSensitivityGrant = { id, ...grant };
    this.grants.set(id, { grant: fullGrant });
    this.reevaluateClaimsForDigests(grant.claimDigest, grant.sourceSetDigest, new Date());
    return fullGrant;
  }

  async listGrantsForClaim(claimId: string): Promise<BiographicalSensitivityGrant[]> {
    const claim = this.readClaim(claimId);
    return this.grantsByDigests(claim.claimDigest, claim.sourceSetDigest);
  }

  async revokeGrant(
    grantId: string,
    input: BiographicalGrantRevokeInput,
  ): Promise<BiographicalSensitivityGrant> {
    const reason = input.reason.trim();
    if (reason.length === 0) throw new Error('revoke reason must be non-empty');
    const now = input.now ?? new Date();
    const row = this.grants.get(grantId);
    if (!row) throw new Error(`biographical grant not found: ${grantId}`);
    if (row.grant.revokedAt !== undefined) {
      throw new Error(`biographical grant ${grantId} is already revoked`);
    }
    const revoked: BiographicalSensitivityGrant = {
      ...row.grant,
      revokedAt: now.toISOString(),
      revokedReason: reason,
    };
    this.grants.set(grantId, { grant: revoked });
    this.reevaluateClaimsForDigests(revoked.claimDigest, revoked.sourceSetDigest, now);
    return revoked;
  }

  async getGrant(grantId: string): Promise<BiographicalSensitivityGrant | undefined> {
    return this.grants.get(grantId)?.grant;
  }
}
