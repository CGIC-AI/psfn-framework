import type { BiographicalClaim, BiographicalSensitivityGrant } from './types.js';
import {
  computeBiographicalRebuildId,
  deserializeBiographicalRebuildRequest,
  type BiographicalRebuildEnqueueInput,
  type BiographicalRebuildEnqueueResult,
  type BiographicalRebuildListOptions,
  type BiographicalRebuildRequest,
} from './lifecycle.js';
import {
  assertClaimTransition,
  assertCompatibleSupersession,
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
import { assertGrantRecord, BiographicalLifecycleError } from './kernel.js';
import { assertKnownClaimKind } from './claim-kinds.js';
import type { BiographicalSubjectRef } from './types.js';

interface StoredClaimRow {
  readonly id: string;
  readonly claimJson: string;
}

interface StoredGrantRow {
  readonly grantJson: string;
}

interface StoredRebuildRow {
  readonly rebuildJson: string;
}

function deserializeGrant(grantJson: string): BiographicalSensitivityGrant {
  return assertGrantRecord(JSON.parse(grantJson) as unknown);
}

function matchesSubject(
  subject: BiographicalSubjectRef | undefined,
  candidate: BiographicalClaim,
): boolean {
  if (subject === undefined) return true;
  if (subject.kind !== candidate.subject.kind) return false;
  return subject.kind === 'companion'
    ? candidate.subject.kind === 'companion'
      && subject.companionId === candidate.subject.companionId
      && subject.subjectVersion === candidate.subject.subjectVersion
    : candidate.subject.kind === 'contact'
      && subject.contactId === candidate.subject.contactId
      && subject.subjectVersion === candidate.subject.subjectVersion;
}

function sameSubjectRef(
  expected: BiographicalSubjectRef,
  actual: BiographicalSubjectRef | undefined,
): boolean {
  if (actual === undefined || expected.kind !== actual.kind) return false;
  return expected.kind === 'companion'
    ? actual.kind === 'companion'
      && expected.companionId === actual.companionId
      && expected.subjectVersion === actual.subjectVersion
    : actual.kind === 'contact'
      && expected.contactId === actual.contactId
      && expected.subjectVersion === actual.subjectVersion;
}

/**
 * In-memory adapter for {@link BiographicalProfileStorePort}. Used by tests and
 * as the parity reference for the Postgres adapter. All deterministic behavior
 * lives in the shared store-port helpers, so this class is storage only.
 */
export class InMemoryBiographicalProfileStore implements BiographicalProfileStorePort {
  private readonly claims = new Map<string, StoredClaimRow>();
  private readonly grants = new Map<string, StoredGrantRow>();
  private readonly rebuilds = new Map<string, StoredRebuildRow>();
  private transactionTail: Promise<void> = Promise.resolve();

  constructor(private readonly now: () => Date = () => new Date()) {}

  private readClaim(id: string): BiographicalClaim {
    const row = this.claims.get(id);
    if (!row) throw new Error(`biographical claim not found: ${id}`);
    return deserializeClaim(row.claimJson);
  }

  private storeClaim(claim: BiographicalClaim): void {
    this.claims.set(claim.id, { id: claim.id, claimJson: serializeClaim(claim) });
  }

  private grantsByDigests(
    claimDigest: string,
    sourceSetDigest: string,
  ): BiographicalSensitivityGrant[] {
    return [...this.grants.values()]
      .map(row => deserializeGrant(row.grantJson))
      .filter(
        grant => grant.claimDigest === claimDigest && grant.sourceSetDigest === sourceSetDigest,
      );
  }

  private projectClaimAtReadTime(claim: BiographicalClaim, now: Date): BiographicalClaim {
    return reevaluateClaimEffective(
      claim,
      this.grantsByDigests(claim.claimDigest, claim.sourceSetDigest),
      now,
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
    if (this.claims.has(claim.id)) {
      throw new Error(`biographical claim already exists: ${claim.id}`);
    }
    this.storeClaim(claim);
    return claim;
  }

  async getClaim(id: string): Promise<BiographicalClaim | undefined> {
    const row = this.claims.get(id);
    return row
      ? this.projectClaimAtReadTime(deserializeClaim(row.claimJson), this.now())
      : undefined;
  }

  async listClaims(options: BiographicalClaimListOptions = {}): Promise<BiographicalClaim[]> {
    if (
      options.limit !== undefined
      && (!Number.isSafeInteger(options.limit) || options.limit < 1)
    ) {
      throw new Error('biographical claim list limit must be a positive integer');
    }
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    const results: BiographicalClaim[] = [];
    const readAt = this.now();
    const ordered = [...this.claims.values()]
      .map(row => deserializeClaim(row.claimJson))
      .sort((left, right) => {
        const timestampOrder = left.synthesizedAt.localeCompare(right.synthesizedAt);
        return timestampOrder !== 0 ? timestampOrder : left.id.localeCompare(right.id);
      });
    for (const storedClaim of ordered) {
      const claim = this.projectClaimAtReadTime(storedClaim, readAt);
      if (options.subject !== undefined && !matchesSubject(options.subject, claim)) continue;
      if (
        options.relatedSubject !== undefined
        && !sameSubjectRef(options.relatedSubject, claim.relatedSubject)
      ) continue;
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
    assertCompatibleSupersession(prior, prepared);
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
    this.grants.set(id, { grantJson: JSON.stringify(fullGrant) });
    this.reevaluateClaimsForDigests(
      grant.claimDigest,
      grant.sourceSetDigest,
      input.now ?? new Date(),
    );
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
    const grant = deserializeGrant(row.grantJson);
    if (grant.revokedAt !== undefined) {
      throw new Error(`biographical grant ${grantId} is already revoked`);
    }
    const revoked: BiographicalSensitivityGrant = {
      ...grant,
      revokedAt: now.toISOString(),
      revokedReason: reason,
    };
    this.grants.set(grantId, { grantJson: JSON.stringify(revoked) });
    this.reevaluateClaimsForDigests(revoked.claimDigest, revoked.sourceSetDigest, now);
    return revoked;
  }

  async getGrant(grantId: string): Promise<BiographicalSensitivityGrant | undefined> {
    const row = this.grants.get(grantId);
    return row ? deserializeGrant(row.grantJson) : undefined;
  }

  async enqueueRebuild(
    input: BiographicalRebuildEnqueueInput,
  ): Promise<BiographicalRebuildEnqueueResult> {
    if (!Number.isSafeInteger(input.maxPending) || input.maxPending < 1) {
      throw new Error('biographical rebuild maxPending must be a positive integer');
    }
    const id = computeBiographicalRebuildId({
      claimId: input.claim.id,
      reason: input.reason,
      ...(input.sourceRef !== undefined ? { sourceRef: input.sourceRef } : {}),
      priorSourceSetDigest: input.claim.sourceSetDigest,
      ...(input.currentSourceSetDigest !== undefined
        ? { currentSourceSetDigest: input.currentSourceSetDigest }
        : {}),
      ...(input.targetSubject !== undefined ? { targetSubject: input.targetSubject } : {}),
    });
    const existing = this.rebuilds.get(id);
    if (existing !== undefined) {
      return {
        status: 'coalesced',
        request: deserializeBiographicalRebuildRequest(JSON.parse(existing.rebuildJson) as unknown),
      };
    }
    const pending = [...this.rebuilds.values()].filter(row =>
      deserializeBiographicalRebuildRequest(JSON.parse(row.rebuildJson) as unknown).status === 'pending'
    ).length;
    if (pending >= input.maxPending) return { status: 'capacity-exhausted' };
    const request: BiographicalRebuildRequest = {
      id,
      claimId: input.claim.id,
      subject: input.claim.subject,
      kind: input.claim.kind,
      reason: input.reason,
      ...(input.sourceRef !== undefined ? { sourceRef: input.sourceRef } : {}),
      priorSourceSetDigest: input.claim.sourceSetDigest,
      ...(input.currentSourceSetDigest !== undefined
        ? { currentSourceSetDigest: input.currentSourceSetDigest }
        : {}),
      ...(input.targetSubject !== undefined ? { targetSubject: input.targetSubject } : {}),
      status: 'pending',
      queuedAt: input.now.toISOString(),
    };
    this.rebuilds.set(id, { rebuildJson: JSON.stringify(request) });
    return { status: 'queued', request };
  }

  async listRebuilds(options: BiographicalRebuildListOptions): Promise<BiographicalRebuildRequest[]> {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1) {
      throw new Error('biographical rebuild list limit must be a positive integer');
    }
    return [...this.rebuilds.values()]
      .map(row => deserializeBiographicalRebuildRequest(JSON.parse(row.rebuildJson) as unknown))
      .filter(request => options.status === undefined || request.status === options.status)
      .sort((left, right) => {
        const queuedOrder = left.queuedAt.localeCompare(right.queuedAt);
        return queuedOrder !== 0 ? queuedOrder : left.id.localeCompare(right.id);
      })
      .slice(0, options.limit);
  }

  async completeRebuild(
    id: string,
    completion: NonNullable<BiographicalRebuildRequest['completion']>,
    now: Date,
  ): Promise<BiographicalRebuildRequest> {
    const row = this.rebuilds.get(id);
    if (row === undefined) throw new Error(`biographical rebuild not found: ${id}`);
    const request = deserializeBiographicalRebuildRequest(JSON.parse(row.rebuildJson) as unknown);
    if (request.status !== 'pending') {
      throw new Error(`biographical rebuild ${id} is already completed`);
    }
    const completed: BiographicalRebuildRequest = {
      ...request,
      status: 'completed',
      completion,
      completedAt: now.toISOString(),
    };
    this.rebuilds.set(id, { rebuildJson: JSON.stringify(completed) });
    return completed;
  }

  private async runTransaction<T>(
    operation: (store: BiographicalProfileStorePort) => Promise<T>,
  ): Promise<T> {
    const previous = this.transactionTail;
    let release!: () => void;
    this.transactionTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    const claimSnapshot = new Map(this.claims);
    const grantSnapshot = new Map(this.grants);
    const rebuildSnapshot = new Map(this.rebuilds);
    try {
      return await operation(this);
    } catch (error) {
      this.claims.clear();
      this.grants.clear();
      this.rebuilds.clear();
      for (const [id, row] of claimSnapshot) this.claims.set(id, row);
      for (const [id, row] of grantSnapshot) this.grants.set(id, row);
      for (const [id, row] of rebuildSnapshot) this.rebuilds.set(id, row);
      throw error;
    } finally {
      release();
    }
  }

  async runClaimTransaction<T>(
    _subject: BiographicalSubjectRef,
    _kind: BiographicalClaim['kind'],
    operation: (store: BiographicalProfileStorePort) => Promise<T>,
  ): Promise<T> {
    return await this.runTransaction(operation);
  }

  async runSubjectTransaction<T>(
    _subject: BiographicalSubjectRef,
    operation: (store: BiographicalProfileStorePort) => Promise<T>,
  ): Promise<T> {
    return await this.runTransaction(operation);
  }
}
