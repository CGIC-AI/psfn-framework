import { randomUUID } from 'node:crypto';

import {
  IcpAutonomyInvalidationConflictError,
  IcpOutstandingInvitationConflictError,
  type IcpSharedAutonomyStorePort,
} from '../../core/icp/autonomy-store-ports.js';
import {
  parseIcpConversationCorrelation,
  parseIcpAvailabilityLease,
  type IcpAutonomyReasonCode,
  type IcpAvailabilityLease,
  type IcpAvailabilityState,
  type IcpInitiationPermit,
  type IcpConversationCorrelation,
} from '../../shared/contracts/icp-autonomy.js';
import { parseCompanionChannelId } from '../../shared/contracts/companion-channels.js';
import type { EventBus } from '../../shared/event-bus.js';
import type { FleetFatiguePosture } from '../../shared/telemetry/fleet-posture.js';
import type {
  IcpGateReasonClass,
  IcpInitiationGateDecision,
  IcpInitiationPermitIssueInput,
  IcpInitiationPermitIssueResult,
  IcpInitiationPreflightInput,
  IcpInitiationHandoffPrepareResult,
  IcpOwnAvailabilityResult,
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
  readCompanionFatiguePosture(companionId: string): FleetFatiguePosture | null;
  hasRuntimeAvailabilityCapability(companionId: string): boolean;
  resolveInitiationChannel(
    senderCompanionId: string,
    peerCompanionId: string,
    channelId: string,
  ): Promise<IcpInitiationChannelResolution>;
  policyAuthority: Pick<
    GatewayIcpInitiationPolicyAuthority,
    'resolve' | 'authorizeHandoff' | 'runAuthorizedHandoff'
  >;
  eventBus: EventBus;
  alarm(event: string, message: string, details: Record<string, unknown>): void;
  now?: () => number;
  randomUuid?: () => string;
}

export class GatewayIcpAutonomyBroker {
  private readonly now: () => number;
  private readonly randomUuid: () => string;
  private readonly runtimeAvailabilityActiveCompanionIds = new Set<string>();
  private readonly runtimeAvailabilityOperationTails = new Map<string, Promise<void>>();

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

  async refreshRuntimeAvailability(
    companionId: string,
    input: {
      state: Extract<IcpAvailabilityState, 'available' | 'resting'>;
      expiresAtMs: number;
    },
  ): Promise<IcpOwnAvailabilityResult> {
    this.requireFleetCompanion(companionId, 'runtime availability publisher');
    return await this.runRuntimeAvailabilityOperation(
      companionId,
      async () => await this.refreshRuntimeAvailabilityNow(companionId, input),
    );
  }

  private async refreshRuntimeAvailabilityNow(
    companionId: string,
    input: {
      state: Extract<IcpAvailabilityState, 'available' | 'resting'>;
      expiresAtMs: number;
    },
  ): Promise<IcpOwnAvailabilityResult> {
    if (!this.runtimeAvailabilityCapabilityGranted(companionId)) {
      return await this.clearRuntimeAvailabilityNow(companionId);
    }
    this.markRuntimeAvailabilityActive(companionId);
    const nowMs = this.now();
    const current = await this.options.store.getAvailability(companionId);
    if (current && current.expiresAtMs > nowMs && current.source !== 'runtime') {
      return await this.readOwnAvailability(companionId);
    }
    const lease = parseIcpAvailabilityLease({
      companionId,
      state: input.state,
      issuedAtMs: nowMs,
      expiresAtMs: input.expiresAtMs,
      source: 'runtime',
      revision: (current?.revision ?? 0) + 1,
    }, { nowMs, requireCurrent: true });
    const reasonCode = availabilityReason(lease.state);
    let published: { lease: IcpAvailabilityLease; revokedPermits: IcpInitiationPermit[] };
    try {
      published = reasonCode
        ? await this.options.store.publishAvailabilityAndInvalidate(lease, reasonCode)
        : { lease: await this.options.store.publishAvailability(lease), revokedPermits: [] };
    } catch (error) {
      const winner = await this.options.store.getAvailability(companionId);
      if (winner && winner.expiresAtMs > nowMs && winner.source !== 'runtime') {
        return await this.readOwnAvailability(companionId);
      }
      throw error;
    }
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
    return await this.readOwnAvailability(companionId);
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

  async clearRuntimeAvailability(companionId: string): Promise<IcpOwnAvailabilityResult> {
    this.requireFleetCompanion(companionId, 'runtime availability publisher');
    return await this.runRuntimeAvailabilityOperation(
      companionId,
      async () => await this.clearRuntimeAvailabilityNow(companionId),
    );
  }

  private async clearRuntimeAvailabilityNow(companionId: string): Promise<IcpOwnAvailabilityResult> {
    this.runtimeAvailabilityActiveCompanionIds.delete(companionId);
    const current = await this.options.store.getAvailability(companionId);
    if (!current || current.source !== 'runtime') {
      await this.invalidateForCompanion(companionId, 'policy_denied');
      return await this.readOwnAvailability(companionId);
    }
    const nowMs = this.now();
    if (current.expiresAtMs <= nowMs) {
      await this.invalidateForCompanion(companionId, 'policy_denied');
      return await this.readOwnAvailability(companionId);
    }
    const lease = parseIcpAvailabilityLease({
      companionId,
      state: 'resting',
      issuedAtMs: nowMs,
      expiresAtMs: current.expiresAtMs,
      source: 'runtime',
      revision: current.revision + 1,
    }, { nowMs, requireCurrent: true });
    let result: { lease: IcpAvailabilityLease; revokedPermits: IcpInitiationPermit[] };
    try {
      result = await this.options.store.publishAvailabilityAndInvalidate(
        lease,
        'policy_denied',
      );
    } catch (error) {
      const winner = await this.options.store.getAvailability(companionId);
      if (winner && winner.expiresAtMs > nowMs && winner.source !== 'runtime') {
        await this.invalidateForCompanion(companionId, 'policy_denied');
        return await this.readOwnAvailability(companionId);
      }
      throw error;
    }
    for (const permit of result.revokedPermits) {
      await this.emitPermitRevoked(permit, 'policy_denied');
    }
    await this.options.eventBus.emit('icp.availability.changed', {
      companionId,
      action: 'published',
      state: result.lease.state,
      source: result.lease.source,
      revision: result.lease.revision,
      expiresAtMs: result.lease.expiresAtMs,
      timestamp: nowMs,
    });
    return await this.readOwnAvailability(companionId);
  }

  markRuntimeAvailabilityInactive(companionId: string): void {
    this.runtimeAvailabilityActiveCompanionIds.delete(companionId);
  }

  markRuntimeAvailabilityActive(companionId: string): void {
    this.requireFleetCompanion(companionId, 'runtime availability publisher');
    if (!this.runtimeAvailabilityCapabilityGranted(companionId)) {
      this.runtimeAvailabilityActiveCompanionIds.delete(companionId);
      return;
    }
    this.runtimeAvailabilityActiveCompanionIds.add(companionId);
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
    const reasonCode = availabilityReason(lease.state)
      ?? this.runtimeParticipationReason(peerCompanionId);
    return {
      peerCompanionId,
      connectionState: 'online',
      eligible: reasonCode === undefined,
      ...(reasonCode ? { reasonCode } : {}),
      lease,
    };
  }

  async readOwnAvailability(companionId: string): Promise<IcpOwnAvailabilityResult> {
    this.requireFleetCompanion(companionId, 'availability owner');
    const lease = await this.options.store.getAvailability(companionId);
    if (!lease) {
      return {
        eligible: false,
        reasonCode: 'availability_missing',
        control: 'missing',
        mutableByCompanion: true,
      };
    }
    if (lease.expiresAtMs <= this.now()) {
      return {
        eligible: false,
        reasonCode: 'availability_expired',
        lease,
        control: 'expired',
        mutableByCompanion: true,
      };
    }
    const reasonCode = availabilityReason(lease.state)
      ?? this.runtimeParticipationReason(companionId);
    return {
      eligible: reasonCode === undefined,
      ...(reasonCode ? { reasonCode } : {}),
      lease,
      control: lease.source === 'operator' ? 'operator_override' : lease.source,
      mutableByCompanion: lease.source !== 'operator',
    };
  }

  async prepareInitiationHandoff(
    senderCompanionId: string,
    input: { permitId: string; peerContactId: string },
  ): Promise<IcpInitiationHandoffPrepareResult> {
    this.requireFleetCompanion(senderCompanionId, 'handoff sender');
    const permit = await this.options.store.getPermit(input.permitId);
    if (!permit || permit.senderCompanionId !== senderCompanionId) {
      this.options.alarm('icp_handoff_permit_denied', 'ICP handoff permit ownership mismatch', {
        senderCompanionId,
      });
      return { authorized: false, reasonCode: 'permit_mismatch' };
    }
    this.requireDistinctFleetPair(senderCompanionId, permit.recipientCompanionId);
    if (permit.status === 'revoked') {
      return { authorized: false, reasonCode: 'permit_revoked' };
    }
    if (permit.status === 'expired'
      || (permit.status === 'issued' && permit.expiresAtMs <= this.now())) {
      return { authorized: false, reasonCode: 'permit_expired' };
    }
    if (permit.status === 'consumed') {
      // A consumed permit is intentionally left to W3's durable recovery path.
      // The exact binding below prevents it from opening a different turn.
    }

    const episode = await this.options.store.getEpisode(permit.conversationId);
    const episodeMatches = episode !== null
      && episode.status === 'invited'
      && episode.channelId === permit.channelId
      && episode.initiatedByCompanionId === senderCompanionId
      && episode.participantCompanionIds.length === 2
      && episode.participantCompanionIds.includes(senderCompanionId)
      && episode.participantCompanionIds.includes(permit.recipientCompanionId)
      && episode.provenanceRef === permit.provenanceRef;
    if (!episodeMatches) {
      this.options.alarm('icp_handoff_episode_denied', 'ICP handoff episode binding mismatch', {
        senderCompanionId,
        conversationId: permit.conversationId,
        channelId: permit.channelId,
      });
      return { authorized: false, reasonCode: 'permit_mismatch' };
    }

    const channel = await this.options.resolveInitiationChannel(
      senderCompanionId,
      permit.recipientCompanionId,
      permit.channelId,
    );
    if (!channel.ok) {
      return {
        authorized: false,
        reasonCode: channel.reasonCode ?? 'channel_mismatch',
      };
    }
    const policy = await this.options.policyAuthority.authorizeHandoff({
      senderCompanionId,
      peerContactId: input.peerContactId,
      permit,
      rootInitiationId: episode.rootInitiationId,
      nowMs: this.now(),
    });
    if (!policy.eligible) {
      return {
        authorized: false,
        reasonCode: policy.reasonCode ?? 'policy_denied',
      };
    }
    if (permit.status === 'consumed') {
      // Only W3 can decide whether this exact durable candidate turn needs
      // recovery. Do not require a now-current lease for a no-op recovery.
      return {
        authorized: true,
        permit,
        rootInitiationId: episode.rootInitiationId,
      };
    }
    if (!this.options.isCompanionReady(senderCompanionId)
      || !this.options.isCompanionReady(permit.recipientCompanionId)) {
      return { authorized: false, reasonCode: 'peer_offline' };
    }
    const senderRuntimeReason = this.runtimeParticipationReason(senderCompanionId);
    if (senderRuntimeReason) {
      return { authorized: false, reasonCode: senderRuntimeReason };
    }
    const availability = await this.readPeerAvailability(
      senderCompanionId,
      permit.recipientCompanionId,
    );
    if (!availability.eligible) {
      return {
        authorized: false,
        reasonCode: availability.reasonCode ?? 'availability_missing',
      };
    }
    return {
      authorized: true,
      permit,
      rootInitiationId: episode.rootInitiationId,
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
    if (canCaptureFence) {
      const existing = await this.reconcilePermitIssue(senderCompanionId, input);
      if (existing) {
        await this.emitGate(input, senderCompanionId, existing.decision);
        return existing;
      }
    }
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
      const existing = await this.reconcilePermitIssue(senderCompanionId, input);
      if (existing) {
        await this.emitGate(input, senderCompanionId, existing.decision);
        return existing;
      }
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

  private async reconcilePermitIssue(
    senderCompanionId: string,
    input: IcpInitiationPermitIssueInput,
  ): Promise<IcpInitiationPermitIssueResult | null> {
    const permit = await this.options.store.getPermitByCandidate(input.candidate.candidateId);
    if (!permit) return null;
    const episode = await this.options.store.getEpisode(permit.conversationId);
    const exactBinding = permit.senderCompanionId === senderCompanionId
      && permit.recipientCompanionId === input.candidate.peerCompanionId
      && permit.channelId === input.channelId
      && permit.provenanceRef === input.candidate.provenanceRef
      && episode !== null
      && episode.conversationId === permit.conversationId
      && episode.channelId === input.channelId
      && episode.rootInitiationId === input.candidate.rootInitiationId
      && episode.initiatedByCompanionId === senderCompanionId
      && episode.initiationSource === input.candidate.source
      && episode.provenanceRef === input.candidate.provenanceRef
      && episode.status === 'invited'
      && episode.participantCompanionIds.length === 2
      && episode.participantCompanionIds.includes(senderCompanionId)
      && episode.participantCompanionIds.includes(input.candidate.peerCompanionId);
    if (!exactBinding) {
      this.options.alarm(
        'icp_permit_reconciliation_mismatch',
        'ICP candidate permit reconciliation binding mismatch',
        {
          senderCompanionId,
          candidateId: input.candidate.candidateId,
          permitId: permit.permitId,
        },
      );
      return { decision: closedDecision('permit_mismatch', 'terminal') };
    }
    if (permit.status === 'revoked') {
      return { decision: closedDecision('permit_revoked', 'terminal') };
    }
    if (permit.status === 'expired'
      || (permit.status === 'issued' && permit.expiresAtMs <= this.now())) {
      return { decision: closedDecision('permit_expired', 'terminal') };
    }
    return { decision: { eligible: true }, permit };
  }

  async consumePermit(
    senderCompanionId: string,
    input: {
      permitId: string;
      conversationId: string;
      recipientCompanionId: string;
      channelId: string;
      rootInitiationId: string;
      peerContactId: string;
    },
  ) {
    this.requireDistinctFleetPair(senderCompanionId, input.recipientCompanionId);
    const episode = await this.options.store.getEpisode(input.conversationId);
    const episodeBindingMatches = episode !== null
      && episode.channelId === input.channelId
      && episode.initiatedByCompanionId === senderCompanionId
      && episode.rootInitiationId === input.rootInitiationId
      && episode.participantCompanionIds.length === 2
      && episode.participantCompanionIds.includes(senderCompanionId)
      && episode.participantCompanionIds.includes(input.recipientCompanionId);
    if (!episodeBindingMatches) {
      this.options.alarm('icp_permit_binding_mismatch', 'ICP permit episode binding mismatch', {
        conversationId: input.conversationId,
        senderCompanionId,
        recipientCompanionId: input.recipientCompanionId,
        channelId: input.channelId,
      });
      return {
        outcome: 'mismatch' as const,
        permit: null,
        reasonCode: 'permit_mismatch' as const,
        episode,
      };
    }
    const permit = await this.options.store.getPermit(input.permitId);
    if (!permit
      || permit.senderCompanionId !== senderCompanionId
      || permit.recipientCompanionId !== input.recipientCompanionId
      || permit.conversationId !== input.conversationId
      || permit.channelId !== input.channelId) {
      return {
        outcome: 'mismatch' as const,
        permit,
        reasonCode: 'permit_mismatch' as const,
        episode,
      };
    }
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
    } else {
      const senderRuntimeReason = this.runtimeParticipationReason(senderCompanionId);
      const recipientRuntimeReason = this.runtimeParticipationReason(input.recipientCompanionId);
      const runtimeReason = senderRuntimeReason ?? recipientRuntimeReason;
      if (runtimeReason) {
        await this.invalidateForCompanion(
          senderRuntimeReason ? senderCompanionId : input.recipientCompanionId,
          runtimeReason,
        );
      }
    }
    const consumedAtMs = this.now();
    const guarded = await this.options.policyAuthority.runAuthorizedHandoff({
      senderCompanionId,
      peerContactId: input.peerContactId,
      permit,
      rootInitiationId: input.rootInitiationId,
      nowMs: consumedAtMs,
    }, async () => await this.options.store.consumePermit({
      permitId: input.permitId,
      conversationId: input.conversationId,
      recipientCompanionId: input.recipientCompanionId,
      channelId: input.channelId,
      senderCompanionId,
      consumedAtMs,
      expectedInvalidationFence,
    }));
    if (!guarded.decision.eligible) {
      return {
        outcome: 'mismatch' as const,
        permit,
        reasonCode: guarded.decision.reasonCode ?? 'policy_denied',
        episode,
      };
    }
    const result = guarded.result;
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
    return { ...result, episode };
  }

  /** Rebind any charged model work to gateway-owned episode identity and participants. */
  async bindConversationCostCorrelation(
    senderCompanionId: string,
    value: IcpConversationCorrelation,
  ): Promise<IcpConversationCorrelation> {
    const correlation = parseIcpConversationCorrelation(value);
    this.requireDistinctFleetPair(senderCompanionId, correlation.peerCompanionId);
    const episode = await this.options.store.getEpisode(correlation.conversationId);
    const matches = episode !== null
      && episode.channelId === correlation.channelId
      && episode.rootInitiationId === correlation.rootInitiationId
      && episode.initiatedByCompanionId === correlation.initiatedByCompanionId
      && episode.participantCompanionIds.length === 2
      && episode.participantCompanionIds.includes(senderCompanionId)
      && episode.participantCompanionIds.includes(correlation.peerCompanionId)
      && correlation.localCompanionId === senderCompanionId;
    if (!matches) {
      this.options.alarm(
        'icp_cost_binding_mismatch',
        'ICP cost correlation does not match the gateway-owned conversation episode',
        {
          senderCompanionId,
          peerCompanionId: correlation.peerCompanionId,
          channelId: correlation.channelId,
          conversationId: correlation.conversationId,
        },
      );
      throw new Error('ICP cost correlation episode binding mismatch');
    }
    return parseIcpConversationCorrelation({
      ...correlation,
      rootInitiationId: episode.rootInitiationId,
      initiatedByCompanionId: episode.initiatedByCompanionId,
    });
  }

  /** Rebind an ordinary transported reply and additionally require reply-stage provenance. */
  async bindConversationReplyCorrelation(
    senderCompanionId: string,
    value: IcpConversationCorrelation,
  ): Promise<IcpConversationCorrelation> {
    const correlation = await this.bindConversationCostCorrelation(senderCompanionId, value);
    if (correlation.costOriginStage !== 'reply') {
      throw new Error('ICP reply correlation requires reply cost origin');
    }
    return correlation;
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
    const senderRuntimeReason = this.runtimeParticipationReason(senderCompanionId);
    if (senderRuntimeReason) return closedDecision(senderRuntimeReason, 'terminal');
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

  private runtimeParticipationReason(companionId: string): IcpAutonomyReasonCode | undefined {
    if (!this.runtimeAvailabilityCapabilityGranted(companionId)) {
      this.runtimeAvailabilityActiveCompanionIds.delete(companionId);
      return 'policy_denied';
    }
    if (!this.runtimeAvailabilityActiveCompanionIds.has(companionId)) {
      return 'policy_denied';
    }
    const fatigue = this.options.readCompanionFatiguePosture(companionId);
    if (fatigue === null) return 'policy_denied';
    return fatigue === 'exhausted' ? 'fatigue_exhausted' : undefined;
  }

  private runtimeAvailabilityCapabilityGranted(companionId: string): boolean {
    try {
      return this.options.hasRuntimeAvailabilityCapability(companionId);
    } catch (error) {
      this.options.alarm(
        'icp_capability_authority_unavailable',
        'ICP runtime availability capability authority failed closed',
        {
          companionId,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return false;
    }
  }

  private async runRuntimeAvailabilityOperation<T>(
    companionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.runtimeAvailabilityOperationTails.get(companionId)
      ?? Promise.resolve();
    const result = previous.then(operation);
    // The original caller still receives `result` rejection; only the queue
    // tail settles so a failed refresh cannot prevent a later fail-closed clear.
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.runtimeAvailabilityOperationTails.set(companionId, tail);
    try {
      return await result;
    } finally {
      if (this.runtimeAvailabilityOperationTails.get(companionId) === tail) {
        this.runtimeAvailabilityOperationTails.delete(companionId);
      }
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
