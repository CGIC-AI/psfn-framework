import { randomUUID } from 'node:crypto';
import type { ConfirmationExecutionContext, ConfirmationResolverIdentity } from './confirmation-queue.js';
import { readConfirmedApprovalExecution } from './confirmation-queue.js';
import type { ShardCapabilityAccess, ShardDenialMaskToken } from './shard-derivation.js';
import { SHARD_CAPABILITY_DENIAL_MASK } from './shard-derivation.js';
import type { CapabilityToken } from './tokens.js';
import type {
  AuthenticatedShardWorkloadHandle,
  AuthenticatedShardWorkloadIdentity,
  AuthenticatedShardWorkloadRegistry,
  PreparedShardRequestGrant,
  ShardApprovalGrantAuditEvent,
  ShardApprovalGrantAuditOutcome,
  ShardApprovalGrantAuthorityOptions,
  ShardApprovalGrantSnapshot,
  ShardApprovalGrantStatus,
  ShardApprovalGrantTuple,
  ShardApprovalGrantUse,
} from './shard-approval-grant-contracts.js';
import {
  assertShardTemporaryGrantDisposition,
  normalizeShardGrantScope,
  requiredShardGrantText,
  resolveShardExceptionalAction,
  shardGrantDigest,
  shardGrantParamsDigest,
} from './shard-approval-grant-policy.js';

export type {
  AuthenticatedShardWorkloadHandle,
  AuthenticatedShardWorkloadIdentity,
  AuthenticatedShardWorkloadRegistration,
  AuthenticatedShardWorkloadRegistry,
  PreparedShardRequestGrant,
  ShardApprovalGrantAuditEvent,
  ShardApprovalGrantAuditOutcome,
  ShardApprovalGrantAuthorityOptions,
  ShardApprovalGrantSnapshot,
  ShardApprovalGrantStatus,
  ShardApprovalGrantTuple,
  ShardApprovalGrantUse,
  ShardApprovalWorkloadRegistryPort,
  ShardWorkloadLifecyclePort,
  ShardWorkloadLifecycleRegistryPort,
  ShardWorkloadRegistrationInput,
} from './shard-approval-grant-contracts.js';
export {
  assertShardTemporaryGrantDisposition,
  isShardExceptionalAction,
} from './shard-approval-grant-policy.js';

interface WorkloadRecord extends AuthenticatedShardWorkloadIdentity {
  readonly access: ShardCapabilityAccess;
}

interface NormalizedGrantTuple {
  readonly workload: AuthenticatedShardWorkloadHandle;
  readonly workloadRecord: WorkloadRecord;
  readonly token: ShardDenialMaskToken;
  readonly method: 'home_assistant.call_service';
  readonly action: 'home_assistant.control';
  readonly scope: string;
  readonly scopeDigest: string;
  readonly paramsDigest: string;
}

interface PreparedRequestRecord {
  readonly tuple: NormalizedGrantTuple;
  approvalId?: string;
  expiresAt?: number;
}

interface GrantRecord {
  readonly grantId: string;
  readonly approvalId: string;
  readonly tuple: NormalizedGrantTuple;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly decision: 'approve' | 'modify';
  readonly resolver: ConfirmationResolverIdentity;
  status: ShardApprovalGrantStatus;
  consumedAt?: number;
  revokedAt?: number;
}

function sameWorkload(left: WorkloadRecord, right: WorkloadRecord): boolean {
  return left.parentCompanionId === right.parentCompanionId
    && left.shardId === right.shardId
    && left.workloadGeneration === right.workloadGeneration
    && left.ownerVersion === right.ownerVersion
    && left.grantDigest === right.grantDigest
    && left.access === right.access;
}

/**
 * Request-scoped exceptional authority. Standing shard access is only read and
 * verified; every temporary grant is a separate exact-use dispatch record.
 */
export class ShardApprovalGrantAuthority {
  private readonly workloadRegistry: AuthenticatedShardWorkloadRegistry;
  private readonly now: () => number;
  private readonly grantIdFactory: () => string;
  private readonly audit: ((event: ShardApprovalGrantAuditEvent) => void) | undefined;
  private readonly revokedWorkloads = new WeakSet<AuthenticatedShardWorkloadHandle>();
  private readonly preparedRequests = new WeakMap<PreparedShardRequestGrant, PreparedRequestRecord>();
  private readonly preparedByApprovalId = new Map<string, PreparedShardRequestGrant>();
  private readonly grants = new Map<string, GrantRecord>();
  private readonly allocatedGrantIds = new Set<string>();
  private readonly allocatedApprovalIds = new Set<string>();
  private lastObservedNow: number | undefined;
  private clockUncertain = false;

  constructor(options: ShardApprovalGrantAuthorityOptions) {
    this.workloadRegistry = options.workloadRegistry;
    this.now = options.now ?? Date.now;
    this.grantIdFactory = options.grantIdFactory ?? randomUUID;
    this.audit = options.audit;
  }

  resolveAuthenticatedWorkload(
    handle: AuthenticatedShardWorkloadHandle,
  ): AuthenticatedShardWorkloadIdentity {
    const workload = this.requireActiveWorkload(handle);
    return Object.freeze({
      parentCompanionId: workload.parentCompanionId,
      shardId: workload.shardId,
      workloadGeneration: workload.workloadGeneration,
      ...(workload.shardLabel ? { shardLabel: workload.shardLabel } : {}),
      ownerVersion: workload.ownerVersion,
      grantDigest: workload.grantDigest,
    });
  }

  prepareRequestGrant(input: ShardApprovalGrantTuple): PreparedShardRequestGrant {
    const preparedAt = this.readNow();
    const tuple = this.normalizeGrantTuple(input);
    const prepared = Object.freeze({
      kind: 'prepared-shard-request-grant' as const,
    }) as PreparedShardRequestGrant;
    this.preparedRequests.set(prepared, { tuple });
    try {
      this.emitAudit(tuple, {
        outcome: 'prepared',
        timestamp: preparedAt,
      });
    } catch (error) {
      this.preparedRequests.delete(prepared);
      throw error;
    }
    return prepared;
  }

  bindRequestGrant(
    prepared: PreparedShardRequestGrant,
    input: { readonly approvalId: string; readonly expiresAt: number },
  ): void {
    const reservation = this.preparedRequests.get(prepared);
    if (!reservation || reservation.approvalId !== undefined) {
      throw new Error('Shard request grant reservation is missing or already bound');
    }
    const approvalId = requiredShardGrantText(input.approvalId, 'approvalId');
    const now = this.readNow();
    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now) {
      throw new Error('Shard request grant expiry must be a future server timestamp');
    }
    if (this.allocatedApprovalIds.has(approvalId) || this.preparedByApprovalId.has(approvalId)) {
      throw new Error('Shard approval id was already bound');
    }
    reservation.approvalId = approvalId;
    reservation.expiresAt = input.expiresAt;
    this.preparedByApprovalId.set(approvalId, prepared);
  }

  activateRequestGrant(
    prepared: PreparedShardRequestGrant,
    context: ConfirmationExecutionContext,
  ): ShardApprovalGrantSnapshot {
    const reservation = this.preparedRequests.get(prepared);
    if (
      !reservation
      || reservation.approvalId === undefined
      || reservation.expiresAt === undefined
    ) {
      throw new Error('Shard request grant reservation is missing, unbound, or already activated');
    }
    const confirmed = readConfirmedApprovalExecution(context, reservation.approvalId);
    if (confirmed.resolver?.kind !== 'operator') {
      throw new Error('Shard request grant requires an authenticated operator resolution');
    }
    const issuedAt = this.readNow();
    if (reservation.expiresAt <= issuedAt) {
      // Terminal transition + security audit are atomic (2h6q.3): the audit is
      // emitted BEFORE the reservation is removed, so an audit failure leaves
      // the reservation intact (retryable) instead of silently completing an
      // unaudited terminal transition.
      this.emitAudit(reservation.tuple, {
        outcome: 'expired',
        approvalId: reservation.approvalId,
        timestamp: issuedAt,
        expiresAt: reservation.expiresAt,
        decision: confirmed.decision,
        resolver: confirmed.resolver,
        reasonCode: 'expired_before_activation',
      });
      this.removePrepared(prepared, reservation);
      throw new Error('Shard request grant is expired');
    }
    this.requireStoredWorkloadLive(reservation.tuple);

    const grant: GrantRecord = {
      grantId: this.nextGrantId(),
      approvalId: reservation.approvalId,
      tuple: reservation.tuple,
      issuedAt,
      expiresAt: reservation.expiresAt,
      decision: confirmed.decision,
      resolver: confirmed.resolver,
      status: 'active',
    };
    this.allocatedApprovalIds.add(grant.approvalId);
    this.removePrepared(prepared, reservation);
    this.grants.set(grant.grantId, grant);
    try {
      this.emitGrantAudit(grant, 'issued', issuedAt);
    } catch (error) {
      this.grants.delete(grant.grantId);
      throw error;
    }
    return this.snapshotGrant(grant);
  }

  consumeRequestGrant(input: ShardApprovalGrantUse): ShardApprovalGrantSnapshot {
    const grantId = requiredShardGrantText(input.grantId, 'grantId');
    const approvalId = requiredShardGrantText(input.approvalId, 'approvalId');
    const grant = this.grants.get(grantId);
    if (!grant) {
      throw new Error('Shard request grant is missing');
    }
    if (grant.status === 'consumed') {
      this.emitGrantAudit(grant, 'replay_denied', this.readNow(), 'already_consumed');
      throw new Error('Shard request grant was already consumed');
    }
    if (grant.status !== 'active') {
      this.emitGrantAudit(grant, 'denied', this.readNow(), `grant_${grant.status}`);
      throw new Error(`Shard request grant is ${grant.status}`);
    }
    const now = this.readNow();
    if (grant.expiresAt <= now) {
      grant.status = 'expired';
      this.emitGrantAudit(grant, 'expired', now, 'expired_before_consumption');
      throw new Error('Shard request grant is expired');
    }

    let candidate: NormalizedGrantTuple;
    try {
      this.requireStoredWorkloadLive(grant.tuple);
      candidate = this.normalizeGrantTuple(input);
    } catch (error) {
      grant.status = 'revoked';
      grant.revokedAt = now;
      this.emitGrantAudit(grant, 'denied', now, 'tuple_authority_unverifiable');
      throw error;
    }
    if (
      grant.approvalId !== approvalId
      || grant.tuple.workload !== candidate.workload
      || !sameWorkload(grant.tuple.workloadRecord, candidate.workloadRecord)
      || grant.tuple.token !== candidate.token
      || grant.tuple.scope !== candidate.scope
      || grant.tuple.paramsDigest !== candidate.paramsDigest
    ) {
      grant.status = 'revoked';
      grant.revokedAt = now;
      this.emitGrantAudit(grant, 'denied', now, 'tuple_mismatch');
      throw new Error('Shard request grant does not match the approved operation');
    }
    grant.status = 'consumed';
    grant.consumedAt = now;
    this.emitGrantAudit(grant, 'consumed', now);
    return this.snapshotGrant(grant);
  }

  recordRequestExecution(
    grantIdInput: string,
    outcome: 'executed' | 'execution_failed',
  ): void {
    const grantId = requiredShardGrantText(grantIdInput, 'grantId');
    const grant = this.grants.get(grantId);
    if (!grant || grant.status !== 'consumed') {
      throw new Error('Shard request execution has no consumed grant');
    }
    this.emitGrantAudit(grant, outcome, this.readNow());
  }

  recordRequestResolution(input: {
    readonly approvalId: string;
    readonly status: 'denied' | 'expired';
    readonly resolver?: ConfirmationResolverIdentity;
  }): void {
    const approvalId = requiredShardGrantText(input.approvalId, 'approvalId');
    const prepared = this.preparedByApprovalId.get(approvalId);
    if (!prepared) {
      return;
    }
    const reservation = this.preparedRequests.get(prepared);
    if (!reservation) {
      this.preparedByApprovalId.delete(approvalId);
      return;
    }
    const timestamp = this.readNow();
    // Terminal denial/expiry resolution + security audit are atomic (2h6q.3):
    // audit-then-remove. If the audit sink throws, the prepared reservation
    // stays bound — it can never activate after a terminal queue outcome, and
    // a retried resolution re-emits the audit — and the failure propagates
    // instead of silently completing the terminal transition.
    this.emitAudit(reservation.tuple, {
      outcome: input.status,
      approvalId,
      timestamp,
      ...(reservation.expiresAt !== undefined ? { expiresAt: reservation.expiresAt } : {}),
      ...(input.resolver ? { resolver: input.resolver } : {}),
      reasonCode: input.status === 'denied' ? 'operator_denied' : 'approval_expired',
    });
    this.removePrepared(prepared, reservation);
    this.allocatedApprovalIds.add(approvalId);
  }

  revokeGrant(grantIdInput: string): ShardApprovalGrantSnapshot {
    const grantId = requiredShardGrantText(grantIdInput, 'grantId');
    const grant = this.grants.get(grantId);
    if (!grant) {
      throw new Error('Shard approval grant is missing');
    }
    if (grant.status !== 'active') {
      throw new Error(`Shard approval grant is ${grant.status}`);
    }
    const now = this.readNow();
    if (grant.expiresAt <= now) {
      grant.status = 'expired';
      this.emitGrantAudit(grant, 'expired', now, 'expired_before_revocation');
      throw new Error('Shard approval grant is expired');
    }
    grant.status = 'revoked';
    grant.revokedAt = now;
    this.emitGrantAudit(grant, 'revoked', now);
    return this.snapshotGrant(grant);
  }

  revokeAuthenticatedWorkload(
    handle: AuthenticatedShardWorkloadHandle,
  ): AuthenticatedShardWorkloadIdentity {
    const identity = this.resolveAuthenticatedWorkload(handle);
    this.revokedWorkloads.add(handle);
    const revokedAt = this.readNow();
    for (const grant of this.grants.values()) {
      if (grant.tuple.workload !== handle || grant.status !== 'active') {
        continue;
      }
      grant.status = 'revoked';
      grant.revokedAt = revokedAt;
      this.emitGrantAudit(grant, 'revoked', revokedAt, 'workload_revoked');
    }
    return identity;
  }

  /**
   * TTL is intentionally non-constructible in this bead. The shared table is
   * still checked so all nondelegable tokens deny for their own reason, while
   * world.control reaches the explicit canonical-owner fail-closed boundary.
   */
  offerTtlGrant(token: CapabilityToken): never {
    assertShardTemporaryGrantDisposition(token, 'ttl');
    throw new Error(
      'Shard canonical TTL policy is unavailable; TTL grants are disabled until its JSON owner is implemented',
    );
  }

  private normalizeGrantTuple(input: ShardApprovalGrantTuple): NormalizedGrantTuple {
    const workloadRecord = this.requireActiveWorkload(input.workload);
    const operation = resolveShardExceptionalAction(input.method, input.action);
    if (workloadRecord.access.has(operation.token)) {
      throw new Error('Shard approval grant cannot widen or replace standing shard access');
    }
    const scope = normalizeShardGrantScope(input.scope);
    return Object.freeze({
      workload: input.workload,
      workloadRecord,
      token: operation.token,
      method: operation.method,
      action: operation.action,
      scope,
      scopeDigest: shardGrantDigest(scope),
      paramsDigest: shardGrantParamsDigest(input.params),
    });
  }

  private requireActiveWorkload(handle: AuthenticatedShardWorkloadHandle): WorkloadRecord {
    if (this.revokedWorkloads.has(handle)) {
      throw new Error('Shard approval workload is missing, replaced, or revoked');
    }
    const registration = this.workloadRegistry.resolveAuthenticatedWorkload(handle);
    if (!registration) {
      throw new Error('Shard approval workload is missing, replaced, or revoked');
    }
    const parentCompanionId = requiredShardGrantText(
      registration.parentCompanionId,
      'parentCompanionId',
    );
    const shardId = requiredShardGrantText(registration.shardId, 'shardId');
    const workloadGeneration = requiredShardGrantText(
      registration.workloadGeneration,
      'workloadGeneration',
    );
    const shardLabel = registration.shardLabel?.trim() || undefined;
    const { capabilityGrant } = registration;
    if (capabilityGrant.parent.companionId !== parentCompanionId) {
      throw new Error('Shard approval workload grant parent does not match its registration');
    }
    if (capabilityGrant.access.getTier() !== 'custom') {
      throw new Error('Shard approval workload access must use the derived custom tier');
    }
    if (
      capabilityGrant.access.ownerVersion !== capabilityGrant.ownerVersion
      || capabilityGrant.access.grantDigest !== capabilityGrant.grantDigest
    ) {
      throw new Error('Shard approval workload access metadata does not match its launch grant');
    }
    const ownerVersion = requiredShardGrantText(
      capabilityGrant.access.ownerVersion,
      'ownerVersion',
    );
    const grantDigest = requiredShardGrantText(
      capabilityGrant.access.grantDigest,
      'grantDigest',
    );
    for (const token of SHARD_CAPABILITY_DENIAL_MASK) {
      if (capabilityGrant.access.has(token)) {
        throw new Error('Shard approval workload standing access contains a masked token');
      }
    }
    return Object.freeze({
      parentCompanionId,
      shardId,
      workloadGeneration,
      ...(shardLabel ? { shardLabel } : {}),
      ownerVersion,
      grantDigest,
      access: capabilityGrant.access,
    });
  }

  private requireStoredWorkloadLive(tuple: NormalizedGrantTuple): void {
    const current = this.requireActiveWorkload(tuple.workload);
    if (!sameWorkload(tuple.workloadRecord, current)) {
      throw new Error('Shard approval workload generation or launch grant was replaced');
    }
  }

  private removePrepared(
    prepared: PreparedShardRequestGrant,
    reservation: PreparedRequestRecord,
  ): void {
    this.preparedRequests.delete(prepared);
    if (reservation.approvalId !== undefined) {
      this.preparedByApprovalId.delete(reservation.approvalId);
    }
  }

  private nextGrantId(): string {
    const grantId = requiredShardGrantText(this.grantIdFactory(), 'grantId');
    if (this.allocatedGrantIds.has(grantId)) {
      throw new Error('Shard approval grant id was already issued');
    }
    this.allocatedGrantIds.add(grantId);
    return grantId;
  }

  private readNow(): number {
    if (this.clockUncertain) {
      throw new Error('Shard approval grant clock is uncertain');
    }
    const now = this.now();
    if (
      !Number.isSafeInteger(now)
      || (this.lastObservedNow !== undefined && now < this.lastObservedNow)
    ) {
      this.clockUncertain = true;
      throw new Error('Shard approval grant clock is uncertain');
    }
    this.lastObservedNow = now;
    return now;
  }

  private snapshotGrant(grant: GrantRecord): ShardApprovalGrantSnapshot {
    const workload = grant.tuple.workloadRecord;
    return Object.freeze({
      grantId: grant.grantId,
      approvalId: grant.approvalId,
      mode: 'request',
      status: grant.status,
      token: grant.tuple.token,
      parentCompanionId: workload.parentCompanionId,
      shardId: workload.shardId,
      workloadGeneration: workload.workloadGeneration,
      method: grant.tuple.method,
      action: grant.tuple.action,
      scopeDigest: grant.tuple.scopeDigest,
      issuedAt: grant.issuedAt,
      expiresAt: grant.expiresAt,
      ...(grant.consumedAt !== undefined ? { consumedAt: grant.consumedAt } : {}),
      ...(grant.revokedAt !== undefined ? { revokedAt: grant.revokedAt } : {}),
    });
  }

  private emitGrantAudit(
    grant: GrantRecord,
    outcome: ShardApprovalGrantAuditOutcome,
    timestamp: number,
    reasonCode?: string,
  ): void {
    this.emitAudit(grant.tuple, {
      outcome,
      grantId: grant.grantId,
      approvalId: grant.approvalId,
      timestamp,
      expiresAt: grant.expiresAt,
      decision: grant.decision,
      resolver: grant.resolver,
      ...(reasonCode ? { reasonCode } : {}),
    });
  }

  private emitAudit(
    tuple: NormalizedGrantTuple,
    input: {
      readonly outcome: ShardApprovalGrantAuditOutcome;
      readonly grantId?: string;
      readonly approvalId?: string;
      readonly timestamp: number;
      readonly expiresAt?: number;
      readonly decision?: 'approve' | 'modify';
      readonly resolver?: ConfirmationResolverIdentity;
      readonly reasonCode?: string;
    },
  ): void {
    if (!this.audit) {
      return;
    }
    this.audit(Object.freeze({
      outcome: input.outcome,
      mode: 'request',
      token: tuple.token,
      parentCompanionId: tuple.workloadRecord.parentCompanionId,
      shardId: tuple.workloadRecord.shardId,
      workloadGeneration: tuple.workloadRecord.workloadGeneration,
      ...(input.grantId ? { grantId: input.grantId } : {}),
      ...(input.approvalId ? { approvalId: input.approvalId } : {}),
      method: tuple.method,
      action: tuple.action,
      scopeDigest: tuple.scopeDigest,
      timestamp: input.timestamp,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      ...(input.decision ? { decision: input.decision } : {}),
      ...(input.resolver
        ? {
            resolverKind: input.resolver.kind,
            resolverIdDigest: shardGrantDigest(input.resolver.id),
          }
        : {}),
      ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
    }));
  }
}
