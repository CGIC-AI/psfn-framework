import { randomUUID } from 'node:crypto';

import {
  IcpAutonomyInvalidationConflictError,
  IcpOutstandingInvitationConflictError,
  type IcpSharedAutonomyStorePort,
} from '../../core/icp/autonomy-store-ports.js';
import {
  parseIcpAvailabilityLease,
  type IcpAutonomyReasonCode,
  type IcpAvailabilityLease,
  type IcpAvailabilityState,
  type IcpInitiationPermit,
} from '../../shared/contracts/icp-autonomy.js';
import { parseCompanionChannelId } from '../../shared/contracts/companion-channels.js';
import type { EventBus } from '../../shared/event-bus.js';
import type {
  IcpGateReasonClass,
  IcpInitiationGateDecision,
  IcpInitiationPermitIssueInput,
  IcpInitiationPermitIssueResult,
  IcpInitiationPreflightInput,
  IcpPeerAvailabilityResult,
} from './icp-autonomy-contract.js';
import type { GatewayIcpInitiationPolicyAuthority } from './icp-initiation-policy-authority.js';

export interface IcpInitiationChannelResolution {
  ok: boolean;
  reasonCode?: Extract<IcpAutonomyReasonCode, 'malformed_channel' | 'channel_mismatch' | 'unknown_participant'>;
}

export interface GatewayIcpAutonomyBrokerOptions {
  store: IcpSharedAutonomyStorePort;
  fleetCompanionIds: ReadonlySet<string>;
  isCompanionReady(companionId: string): boolean;
  resolveInitiationChannel(
    senderCompanionId: string,
    peerCompanionId: string,
    channelId: string,
  ): Promise<IcpInitiationChannelResolution>;
  policyAuthority: Pick<GatewayIcpInitiationPolicyAuthority, 'resolve'>;
  eventBus: EventBus;
  alarm(event: string, message: string, details: Record<string, unknown>): void;
  now?: () => number;
  randomUuid?: () => string;
}

export class GatewayIcpAutonomyBroker {
  private readonly now: () => number;
  private readonly randomUuid: () => string;

  constructor(private readonly options: GatewayIcpAutonomyBrokerOptions) {
    this.now = options.now ?? (() => Date.now());
    this.randomUuid = options.randomUuid ?? randomUUID;
  }

  async publishAvailability(
    companionId: string,
    input: { state: IcpAvailabilityState; expiresAtMs: number; revision: number },
  ): Promise<IcpAvailabilityLease> {
    this.requireFleetCompanion(companionId, 'availability publisher');
    const nowMs = this.now();
    const lease = parseIcpAvailabilityLease({
      companionId,
      state: input.state,
      issuedAtMs: nowMs,
      expiresAtMs: input.expiresAtMs,
      source: 'companion',
      revision: input.revision,
    }, { nowMs, requireCurrent: true });
    const reasonCode = availabilityReason(lease.state);
    const published = reasonCode
      ? await this.options.store.publishAvailabilityAndInvalidate(lease, reasonCode)
      : { lease: await this.options.store.publishAvailability(lease), revokedPermits: [] };
    if (reasonCode) {
      for (const permit of published.revokedPermits) {
        await this.emitPermitRevoked(permit, reasonCode);
      }
    }
    await this.options.eventBus.emit('icp.availability.changed', {
      companionId,
      action: 'published',
      state: published.lease.state,
      source: published.lease.source,
      revision: published.lease.revision,
      expiresAtMs: published.lease.expiresAtMs,
      timestamp: nowMs,
    });
    return published.lease;
  }

  async clearAvailability(companionId: string, expectedRevision: number): Promise<boolean> {
    this.requireFleetCompanion(companionId, 'availability publisher');
    const nowMs = this.now();
    const result = await this.options.store.clearAvailabilityAndInvalidate(
      companionId,
      expectedRevision,
      { source: 'companion', nowMs },
      'availability_missing',
    );
    if (result.cleared) {
      for (const permit of result.revokedPermits) {
        await this.emitPermitRevoked(permit, 'availability_missing');
      }
      await this.options.eventBus.emit('icp.availability.changed', {
        companionId,
        action: 'cleared',
        revision: expectedRevision,
        timestamp: nowMs,
      });
    }
    return result.cleared;
  }

  async readPeerAvailability(
    senderCompanionId: string,
    peerCompanionId: string,
  ): Promise<IcpPeerAvailabilityResult> {
    this.requireDistinctFleetPair(senderCompanionId, peerCompanionId);
    if (!this.options.isCompanionReady(peerCompanionId)) {
      return {
        peerCompanionId,
        connectionState: 'offline',
        eligible: false,
        reasonCode: 'peer_offline',
      };
    }
    const lease = await this.options.store.getAvailability(peerCompanionId);
    if (!lease) {
      return {
        peerCompanionId,
        connectionState: 'online',
        eligible: false,
        reasonCode: 'availability_missing',
      };
    }
    const nowMs = this.now();
    if (lease.expiresAtMs <= nowMs) {
      return {
        peerCompanionId,
        connectionState: 'online',
        eligible: false,
        reasonCode: 'availability_expired',
        lease,
      };
    }
    const reasonCode = availabilityReason(lease.state);
    return {
      peerCompanionId,
      connectionState: 'online',
      eligible: reasonCode === undefined,
      ...(reasonCode ? { reasonCode } : {}),
      lease,
    };
  }

  async preflight(
    senderCompanionId: string,
    input: IcpInitiationPreflightInput,
  ): Promise<IcpInitiationGateDecision> {
    const decision = await this.evaluate(senderCompanionId, input);
    await this.emitGate(input, senderCompanionId, decision);
    return decision;
  }

  async issuePermit(
    senderCompanionId: string,
    input: IcpInitiationPermitIssueInput,
  ): Promise<IcpInitiationPermitIssueResult> {
    const canCaptureFence = input.candidate.localCompanionId === senderCompanionId
      && input.candidate.peerCompanionId !== senderCompanionId
      && this.options.fleetCompanionIds.has(senderCompanionId)
      && this.options.fleetCompanionIds.has(input.candidate.peerCompanionId);
    const expectedInvalidationFence = canCaptureFence
      ? await this.options.store.captureInvalidationFence(
          senderCompanionId,
          input.candidate.peerCompanionId,
        )
      : undefined;
    const decision = await this.evaluate(senderCompanionId, input);
    if (!decision.eligible) {
      await this.emitGate(input, senderCompanionId, decision);
      return { decision };
    }
    if (!expectedInvalidationFence) {
      throw new Error('Eligible ICP initiation is missing a participant invalidation fence');
    }

    const nowMs = this.now();
    const conversationId = this.randomUuid();
    const permitId = this.randomUuid();
    const participantCompanionIds = [senderCompanionId, input.candidate.peerCompanionId].sort();
    const episode = {
      conversationId,
      channelId: input.channelId,
      participantCompanionIds,
      rootInitiationId: input.candidate.rootInitiationId,
      initiatedByCompanionId: senderCompanionId,
      initiationSource: input.candidate.source,
      provenanceRef: input.candidate.provenanceRef,
      openedAtMs: nowMs,
      lastActivityAtMs: nowMs,
      status: 'invited',
      revision: 1,
    } as const;
    const pendingPermit = {
      permitId,
      candidateId: input.candidate.candidateId,
      conversationId,
      senderCompanionId,
      recipientCompanionId: input.candidate.peerCompanionId,
      channelId: input.channelId,
      provenanceRef: input.candidate.provenanceRef,
      issuedAtMs: nowMs,
      expiresAtMs: input.permitExpiresAtMs,
      status: 'issued',
      revision: 1,
    } as const;
    let permit: IcpInitiationPermit;
    try {
      ({ permit } = await this.options.store.createEpisodeAndIssuePermit({
        episode,
        permit: pendingPermit,
        expectedInvalidationFence,
      }));
    } catch (error) {
      if (error instanceof IcpAutonomyInvalidationConflictError) {
        const closed = closedDecision(error.reasonCode, invalidationReasonClass(error.reasonCode));
        await this.emitGate(input, senderCompanionId, closed);
        return { decision: closed };
      }
      if (!(error instanceof IcpOutstandingInvitationConflictError)) throw error;
      const closed = closedDecision('invitation_outstanding', 'deferrable');
      await this.emitGate(input, senderCompanionId, closed);
      return { decision: closed };
    }
    await this.emitGate(input, senderCompanionId, { eligible: true });
    await this.options.eventBus.emit('icp.permit.lifecycle', {
      candidateId: permit.candidateId,
      conversationId: permit.conversationId,
      senderCompanionId: permit.senderCompanionId,
      recipientCompanionId: permit.recipientCompanionId,
      channelId: permit.channelId,
      action: 'issued',
      timestamp: nowMs,
    });
    return { decision: { eligible: true }, permit };
  }

  async consumePermit(
    senderCompanionId: string,
    input: {
      permitId: string;
      conversationId: string;
      recipientCompanionId: string;
      channelId: string;
    },
  ) {
    this.requireDistinctFleetPair(senderCompanionId, input.recipientCompanionId);
    const expectedInvalidationFence = await this.options.store.captureInvalidationFence(
      senderCompanionId,
      input.recipientCompanionId,
    );
    const senderReady = this.options.isCompanionReady(senderCompanionId);
    const recipientReady = this.options.isCompanionReady(input.recipientCompanionId);
    if (!senderReady || !recipientReady) {
      const unavailableCompanionId = senderReady
        ? input.recipientCompanionId
        : senderCompanionId;
      await this.invalidateForCompanion(unavailableCompanionId, 'peer_offline');
    }
    const result = await this.options.store.consumePermit({
      ...input,
      senderCompanionId,
      consumedAtMs: this.now(),
      expectedInvalidationFence,
    });
    await this.options.eventBus.emit('icp.permit.lifecycle', {
      candidateId: result.permit?.candidateId ?? '[unknown]',
      conversationId: input.conversationId,
      senderCompanionId,
      recipientCompanionId: input.recipientCompanionId,
      channelId: input.channelId,
      action: result.outcome,
      ...(result.reasonCode ? { reasonCode: result.reasonCode } : {}),
      timestamp: this.now(),
    });
    if (result.outcome === 'mismatch') {
      this.options.alarm('icp_permit_binding_mismatch', 'ICP permit consumption binding mismatch', {
        conversationId: input.conversationId,
        senderCompanionId,
        recipientCompanionId: input.recipientCompanionId,
        channelId: input.channelId,
      });
    }
    return result;
  }

  async revokePermit(
    senderCompanionId: string,
    permitId: string,
    expectedRevision: number,
  ): Promise<IcpInitiationPermit> {
    const existing = await this.options.store.getPermit(permitId);
    if (!existing || existing.senderCompanionId !== senderCompanionId) {
      this.options.alarm('icp_permit_revoke_denied', 'ICP permit revocation sender mismatch', {
        senderCompanionId,
      });
      throw new Error('ICP permit is not owned by the authenticated sender');
    }
    const revoked = await this.options.store.revokePermit(
      permitId,
      expectedRevision,
      this.now(),
      'candidate_cancelled',
    );
    await this.emitPermitRevoked(revoked, 'candidate_cancelled');
    return revoked;
  }

  async invalidateForCompanion(
    companionId: string,
    reasonCode: IcpAutonomyReasonCode,
  ): Promise<IcpInitiationPermit[]> {
    const revoked = await this.options.store.revokeOutstandingPermitsForCompanion(
      companionId,
      this.now(),
      reasonCode,
    );
    for (const permit of revoked) await this.emitPermitRevoked(permit, reasonCode);
    return revoked;
  }

  private async evaluate(
    senderCompanionId: string,
    input: IcpInitiationPreflightInput,
  ): Promise<IcpInitiationGateDecision> {
    const { candidate } = input;
    if (candidate.localCompanionId !== senderCompanionId) {
      this.options.alarm('icp_candidate_sender_mismatch', 'ICP candidate sender identity mismatch', {
        authenticatedCompanionId: senderCompanionId,
        candidateCompanionId: candidate.localCompanionId,
      });
      return closedDecision('invalid_identity', 'terminal');
    }
    if (!this.options.fleetCompanionIds.has(senderCompanionId)
      || !this.options.fleetCompanionIds.has(candidate.peerCompanionId)) {
      this.options.alarm('icp_unknown_participant', 'ICP initiation addressed an unknown fleet participant', {
        senderCompanionId,
        peerCompanionId: candidate.peerCompanionId,
      });
      return closedDecision('unknown_participant', 'terminal');
    }
    if (candidate.peerCompanionId === senderCompanionId) {
      return closedDecision('invalid_identity', 'terminal');
    }
    if (candidate.status !== 'pending') return closedDecision('candidate_cancelled', 'terminal');
    if (candidate.expiresAtMs <= this.now()) return closedDecision('candidate_expired', 'terminal');
    const policy = await this.options.policyAuthority.resolve({
      senderCompanionId,
      candidate,
      channelId: input.channelId,
      nowMs: this.now(),
    });
    if (!policy.canonicalPeerContact) return closedDecision('invalid_identity', 'terminal');
    if (policy.senderBlocksPeer || policy.peerBlocksSender) return closedDecision('peer_blocked', 'terminal');
    if (!policy.trustAllows) return closedDecision('policy_denied', 'terminal');
    if (!policy.provenanceFresh) return closedDecision('stale_provenance', 'terminal');
    if (policy.recursiveMiOnlyRoot) return closedDecision('recursive_trigger', 'terminal');
    if (policy.quietHours) return closedDecision('quiet_hours', 'deferrable');
    if (!policy.socialPressureAllows || !policy.chargeAllows) {
      return closedDecision('charge_pressure', 'deferrable');
    }
    if (!policy.fatigueAllows) return closedDecision('fatigue_exhausted', 'terminal');
    if (!policy.costAllows) return closedDecision('cost_hard_stop', 'terminal');

    const parsedChannel = parseCompanionChannelId(input.channelId);
    if (!parsedChannel) {
      this.options.alarm('icp_malformed_channel', 'ICP initiation used a malformed companion channel', {
        senderCompanionId,
        peerCompanionId: candidate.peerCompanionId,
        channelId: input.channelId,
      });
      return closedDecision('malformed_channel', 'terminal');
    }
    if ((candidate.preferredChannel === 'dm' && parsedChannel.kind !== 'dm')
      || (candidate.preferredChannel === 'current_room' && parsedChannel.kind !== 'room')) {
      this.options.alarm('icp_channel_substitution', 'ICP initiation channel kind differs from the candidate binding', {
        senderCompanionId,
        peerCompanionId: candidate.peerCompanionId,
        channelId: input.channelId,
      });
      return closedDecision('channel_mismatch', 'terminal');
    }
    const channel = await this.options.resolveInitiationChannel(
      senderCompanionId,
      candidate.peerCompanionId,
      input.channelId,
    );
    if (!channel.ok) {
      this.options.alarm('icp_channel_substitution', 'ICP initiation channel membership/binding mismatch', {
        senderCompanionId,
        peerCompanionId: candidate.peerCompanionId,
        channelId: input.channelId,
      });
      return closedDecision(channel.reasonCode ?? 'channel_mismatch', 'terminal');
    }

    const availability = await this.readPeerAvailability(senderCompanionId, candidate.peerCompanionId);
    if (!availability.eligible) {
      return closedDecision(
        availability.reasonCode ?? 'availability_missing',
        availability.reasonCode === 'peer_do_not_disturb' ? 'terminal' : 'deferrable',
      );
    }
    const outstanding = await this.options.store.findOutstandingPermitBetween(
      senderCompanionId,
      candidate.peerCompanionId,
      this.now(),
    );
    if (outstanding) return closedDecision('invitation_outstanding', 'deferrable');
    return { eligible: true };
  }

  private requireFleetCompanion(companionId: string, label: string): void {
    if (!this.options.fleetCompanionIds.has(companionId)) {
      throw new Error(`Unknown ${label} ${companionId}`);
    }
  }

  private requireDistinctFleetPair(senderCompanionId: string, peerCompanionId: string): void {
    this.requireFleetCompanion(senderCompanionId, 'sender');
    this.requireFleetCompanion(peerCompanionId, 'peer');
    if (senderCompanionId === peerCompanionId) throw new Error('ICP peer must differ from sender');
  }

  private async emitGate(
    input: IcpInitiationPreflightInput,
    senderCompanionId: string,
    decision: IcpInitiationGateDecision,
  ): Promise<void> {
    await this.options.eventBus.emit('icp.initiation.gate', {
      candidateId: input.candidate.candidateId,
      senderCompanionId,
      recipientCompanionId: input.candidate.peerCompanionId,
      channelId: input.channelId,
      outcome: decision.eligible ? 'open' : 'closed',
      ...(decision.reasonCode ? { reasonCode: decision.reasonCode } : {}),
      ...(decision.reasonClass ? { reasonClass: decision.reasonClass } : {}),
      timestamp: this.now(),
    });
  }

  private async emitPermitRevoked(
    permit: IcpInitiationPermit,
    reasonCode: IcpAutonomyReasonCode,
  ): Promise<void> {
    await this.options.eventBus.emit('icp.permit.lifecycle', {
      candidateId: permit.candidateId,
      conversationId: permit.conversationId,
      senderCompanionId: permit.senderCompanionId,
      recipientCompanionId: permit.recipientCompanionId,
      channelId: permit.channelId,
      action: 'revoked',
      reasonCode,
      timestamp: this.now(),
    });
  }
}

function closedDecision(
  reasonCode: IcpAutonomyReasonCode,
  reasonClass: IcpGateReasonClass,
): IcpInitiationGateDecision {
  return { eligible: false, reasonCode, reasonClass };
}

function invalidationReasonClass(reasonCode: IcpAutonomyReasonCode): IcpGateReasonClass {
  switch (reasonCode) {
    case 'peer_do_not_disturb':
    case 'peer_blocked':
    case 'operator_cancelled':
    case 'unknown_participant':
      return 'terminal';
    default:
      return 'deferrable';
  }
}

function availabilityReason(state: IcpAvailabilityState): IcpAutonomyReasonCode | undefined {
  switch (state) {
    case 'available':
    case 'open_to_chat':
      return undefined;
    case 'busy':
      return 'peer_busy';
    case 'resting':
      return 'peer_resting';
    case 'do_not_disturb':
      return 'peer_do_not_disturb';
  }
}
