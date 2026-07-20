import type {
  SatelliteResponseLeasePolicy,
  SatelliteSharedDevicePolicy,
} from '../../shared/contracts/satellite-registry.js';
import type { CompanionId } from '../../shared/routing/companion-id.js';

export type SharedSatelliteLeasePriority =
  | 'explicit_address'
  | 'active_conversation'
  | 'primary'
  | 'emanation_member';

export interface SharedSatelliteEligibility {
  companionId: CompanionId;
  availabilityAllows: boolean;
  fatigueAllows: boolean;
  quietHoursAllows: boolean;
  restAllows: boolean;
  taskAllows: boolean;
  deviceAllows: boolean;
}

export interface SharedSatelliteResponseLease {
  leaseId: string;
  satelliteId: string;
  companionId: CompanionId;
  priority: SharedSatelliteLeasePriority;
  acquiredAtMs: number;
  expiresAtMs: number;
}

export type SharedSatelliteLeaseAuditAction =
  | 'acquired'
  | 'declined'
  | 'no_op'
  | 'timed_out'
  | 'released'
  | 'speech';

export interface SharedSatelliteLeaseAuditEvent {
  action: SharedSatelliteLeaseAuditAction;
  satelliteId: string;
  companionId: CompanionId;
  leaseId: string;
  priority: SharedSatelliteLeasePriority;
  timestamp: number;
  reason?: string;
}

export type SharedSatelliteLeaseAcquisition =
  | { acquired: true; lease: SharedSatelliteResponseLease }
  | {
      acquired: false;
      reason:
        | 'lease_held'
        | 'addressed_member_ineligible'
        | 'active_member_ineligible'
        | 'no_eligible_member';
    };

export interface SharedSatelliteResponseArbiterOptions {
  now?: () => number;
  audit?: (event: SharedSatelliteLeaseAuditEvent) => void;
}

function isEligible(candidate: SharedSatelliteEligibility): boolean {
  return candidate.availabilityAllows
    && candidate.fatigueAllows
    && candidate.quietHoursAllows
    && candidate.restAllows
    && candidate.taskAllows
    && candidate.deviceAllows;
}

/**
 * Same-process speech authority for shared physical devices.
 *
 * Acquisition is synchronous: JavaScript cannot interleave another acquire
 * between holder inspection and assignment. The model is called only after a
 * caller receives a lease. Expiry is deterministic and processed lazily at
 * every transition, so fake timers and production clocks behave identically.
 */
export class SharedSatelliteResponseArbiter {
  private readonly now: () => number;
  private readonly audit: (event: SharedSatelliteLeaseAuditEvent) => void;
  private readonly holders = new Map<string, SharedSatelliteResponseLease>();
  private readonly activeConversations = new Map<string, {
    companionId: CompanionId;
    expiresAtMs: number;
  }>();
  private readonly leaseConversationKeys = new Map<string, string>();
  private sequence = 0;

  constructor(options: SharedSatelliteResponseArbiterOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.audit = options.audit ?? (() => undefined);
  }

  resolveActiveConversation(conversationKey: string): CompanionId | undefined {
    const active = this.activeConversations.get(conversationKey);
    if (!active) return undefined;
    if (active.expiresAtMs <= this.now()) {
      this.activeConversations.delete(conversationKey);
      return undefined;
    }
    return active.companionId;
  }

  acquire(input: {
    satelliteId: string;
    /** Exact partner + authenticated conversation lineage; never prose-derived. */
    conversationKey: string;
    policy: SatelliteSharedDevicePolicy;
    eligibility: readonly SharedSatelliteEligibility[];
    explicitAddressedCompanionId?: CompanionId;
    excludedCompanionIds?: ReadonlySet<CompanionId>;
  }): SharedSatelliteLeaseAcquisition {
    this.expireHolder(input.satelliteId);
    if (this.holders.has(input.satelliteId)) {
      return { acquired: false, reason: 'lease_held' };
    }

    const eligibility = new Map(input.eligibility.map(candidate => [
      candidate.companionId,
      candidate,
    ]));
    const excluded = input.excludedCompanionIds ?? new Set<CompanionId>();
    const acquireExact = (
      companionId: CompanionId,
      priority: SharedSatelliteLeasePriority,
      ineligibleReason: 'addressed_member_ineligible' | 'active_member_ineligible',
    ): SharedSatelliteLeaseAcquisition => {
      const candidate = eligibility.get(companionId);
      if (!input.policy.emanationMemberIds.includes(companionId)
        || excluded.has(companionId)
        || !candidate
        || !isEligible(candidate)) {
        return { acquired: false, reason: ineligibleReason };
      }
      return this.assign(
        input.satelliteId,
        input.conversationKey,
        companionId,
        priority,
        input.policy.responseLease,
      );
    };

    if (input.explicitAddressedCompanionId) {
      return acquireExact(
        input.explicitAddressedCompanionId,
        'explicit_address',
        'addressed_member_ineligible',
      );
    }
    const activeCompanionId = this.resolveActiveConversation(input.conversationKey);
    if (activeCompanionId) {
      return acquireExact(activeCompanionId, 'active_conversation', 'active_member_ineligible');
    }

    for (const companionId of input.policy.emanationMemberIds) {
      if (excluded.has(companionId)) continue;
      const candidate = eligibility.get(companionId);
      if (!candidate || !isEligible(candidate)) continue;
      return this.assign(
        input.satelliteId,
        input.conversationKey,
        companionId,
        companionId === input.policy.primaryCompanionId ? 'primary' : 'emanation_member',
        input.policy.responseLease,
      );
    }
    return { acquired: false, reason: 'no_eligible_member' };
  }

  complete(
    leaseId: string,
    outcome: 'speech' | 'decline' | 'no_op' | 'release',
    reason?: string,
  ): boolean {
    const lease = this.findLease(leaseId);
    if (!lease) return false;
    if (lease.expiresAtMs <= this.now()) {
      this.expireHolder(lease.satelliteId);
      return false;
    }
    if (outcome === 'speech') {
      this.emit(lease, 'speech', reason);
      const conversationKey = this.leaseConversationKeys.get(lease.leaseId);
      if (!conversationKey) {
        throw new Error(`Missing conversation lineage for response lease "${lease.leaseId}"`);
      }
      this.activeConversations.set(conversationKey, {
        companionId: lease.companionId,
        expiresAtMs: this.now() + this.resolvePolicyTtl(lease.satelliteId),
      });
    } else if (outcome === 'decline') {
      this.emit(lease, 'declined', reason);
    } else if (outcome === 'no_op') {
      this.emit(lease, 'no_op', reason);
    }
    this.emit(lease, 'released', reason ?? outcome);
    this.holders.delete(lease.satelliteId);
    this.leaseConversationKeys.delete(lease.leaseId);
    return true;
  }

  /** Atomically mark an RPC/model timeout even when its deadline precedes lease expiry. */
  timeout(leaseId: string, reason = 'model_timeout'): boolean {
    const lease = this.findLease(leaseId);
    if (!lease) return false;
    this.emit(lease, 'timed_out', reason);
    this.emit(lease, 'released', 'timeout');
    this.holders.delete(lease.satelliteId);
    this.leaseConversationKeys.delete(lease.leaseId);
    return true;
  }

  currentHolder(satelliteId: string): SharedSatelliteResponseLease | undefined {
    this.expireHolder(satelliteId);
    return this.holders.get(satelliteId);
  }

  private readonly policyTtls = new Map<string, number>();

  private assign(
    satelliteId: string,
    conversationKey: string,
    companionId: CompanionId,
    priority: SharedSatelliteLeasePriority,
    policy: SatelliteResponseLeasePolicy,
  ): SharedSatelliteLeaseAcquisition {
    const acquiredAtMs = this.now();
    const lease: SharedSatelliteResponseLease = {
      leaseId: `${satelliteId}:${++this.sequence}`,
      satelliteId,
      companionId,
      priority,
      acquiredAtMs,
      expiresAtMs: acquiredAtMs + policy.durationMs,
    };
    this.policyTtls.set(satelliteId, policy.activeConversationTtlMs);
    this.holders.set(satelliteId, lease);
    this.leaseConversationKeys.set(lease.leaseId, conversationKey);
    this.emit(lease, 'acquired');
    return { acquired: true, lease };
  }

  private resolvePolicyTtl(satelliteId: string): number {
    const ttlMs = this.policyTtls.get(satelliteId);
    if (ttlMs === undefined) {
      throw new Error(`Missing response lease policy for satellite "${satelliteId}"`);
    }
    return ttlMs;
  }

  private findLease(leaseId: string): SharedSatelliteResponseLease | undefined {
    for (const lease of this.holders.values()) {
      if (lease.leaseId === leaseId) return lease;
    }
    return undefined;
  }

  private expireHolder(satelliteId: string): void {
    const lease = this.holders.get(satelliteId);
    if (!lease || lease.expiresAtMs > this.now()) return;
    this.emit(lease, 'timed_out', 'response_lease_expired');
    this.emit(lease, 'released', 'timeout');
    this.holders.delete(satelliteId);
    this.leaseConversationKeys.delete(lease.leaseId);
  }

  private emit(
    lease: SharedSatelliteResponseLease,
    action: SharedSatelliteLeaseAuditAction,
    reason?: string,
  ): void {
    this.audit({
      action,
      satelliteId: lease.satelliteId,
      companionId: lease.companionId,
      leaseId: lease.leaseId,
      priority: lease.priority,
      timestamp: this.now(),
      ...(reason ? { reason } : {}),
    });
  }
}
