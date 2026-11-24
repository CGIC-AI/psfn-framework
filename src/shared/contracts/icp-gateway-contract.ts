// ── ICP gateway broker contract types (psfn-framework-kbdvl.1) ──
//
// Core-owned type contracts for inter-companion (ICP) dyad lifecycle,
// availability, initiation preflight/permits, and continuation authorization.
// Concrete gateway wire parsers and RPC brokers live in
// `boundary/gateway/icp-autonomy-contract.ts`.

import type { IcpPermitConsumptionOutcome } from '../../core/icp/autonomy-store-ports.js';
import type { IcpInitiationCandidateSharedMetadata } from '../../core/icp/initiation-candidate.js';
import type {
  IcpAutonomyReasonCode,
  IcpAvailabilityLease,
  IcpAvailabilityState,
  IcpConversationEpisode,
  IcpDyadDeliveryOutcome,
  IcpDyadParticipantState,
  IcpDyadStatus,
  IcpInitiationPermit,
  IcpPermitStatus,
} from './icp-autonomy.js';

export type IcpGateReasonClass = 'deferrable' | 'terminal';

export interface IcpOpenDyadProjection {
  dyadId: string;
  peerCompanionId: string;
  channelId: string;
  status: 'open';
  lifecycleRevision: number;
  availability: IcpPeerAvailabilityResult;
  lastDeliveryOutcome?: IcpDyadDeliveryOutcome;
  lastDeliveryAtMs?: number;
}

export interface IcpDyadLifecycleProjection {
  dyadId: string;
  peerCompanionId: string;
  channelId: string;
  status: IcpDyadStatus;
  ownState: IcpDyadParticipantState;
  peerState: IcpDyadParticipantState;
  lifecycleRevision: number;
}

export interface IcpDyadContinuationAuthorization {
  dyadId: string;
  deliveryId: string;
  peerCompanionId: string;
  channelId: string;
  dyadLifecycleRevision: number;
  episode: IcpConversationEpisode;
}

export type IcpDyadContinuationPrepareResult =
  | { status: 'authorized'; authorization: IcpDyadContinuationAuthorization }
  | {
      status: 'need_initiation';
      reasonCode: Extract<IcpAutonomyReasonCode,
        'dyad_not_found' | 'dyad_closed' | 'stale_provenance'>;
    }
  | {
      status: 'unavailable';
      reasonCode: IcpAutonomyReasonCode;
    };

interface IcpDyadLifecycleUpdatedResult {
  outcome: 'updated';
  dyadId: string;
  status: IcpDyadStatus;
  ownState: IcpDyadParticipantState;
  peerState: IcpDyadParticipantState;
  lifecycleRevision: number;
  revokedPermitCount: number;
  fencedDeliveryCount: number;
}

export type IcpDyadLifecycleResult = IcpDyadLifecycleUpdatedResult | {
  outcome: 'unavailable';
  reasonCode: Extract<IcpAutonomyReasonCode,
    'dyad_not_found' | 'dyad_paused' | 'dyad_closed' | 'dyad_blocked' | 'dyad_stale_revision'>;
};

/** Strict content-free deterministic facts owned by the initiating runtime. */
export interface IcpInitiationPolicySnapshot {
  canonicalPeerContact: boolean;
  trustAllows: boolean;
  senderBlocksPeer: boolean;
  peerBlocksSender: boolean;
  provenanceFresh: boolean;
  recursiveMiOnlyRoot: boolean;
  socialPressureAllows: boolean;
  chargeAllows: boolean;
  fatigueAllows: boolean;
  costAllows: boolean;
}

export interface IcpInitiationPreflightInput {
  candidate: IcpInitiationCandidateSharedMetadata;
  channelId: string;
}

export interface IcpInitiationPermitIssueInput extends IcpInitiationPreflightInput {
  permitExpiresAtMs: number;
}

export interface IcpInitiationGateDecision {
  eligible: boolean;
  reasonCode?: IcpAutonomyReasonCode;
  reasonClass?: IcpGateReasonClass;
}

export interface IcpInitiationPermitIssueResult {
  decision: IcpInitiationGateDecision;
  permit?: IcpInitiationPermit;
}

export interface IcpPeerAvailabilityResult {
  peerCompanionId: string;
  connectionState: 'online' | 'offline';
  eligible: boolean;
  reasonCode?: IcpAutonomyReasonCode;
  lease?: IcpAvailabilityLease;
}

export interface IcpOwnAvailabilityResult {
  eligible: boolean;
  reasonCode?: IcpAutonomyReasonCode;
  lease?: IcpAvailabilityLease;
  control: 'missing' | 'expired' | 'companion' | 'runtime' | 'operator_override';
  mutableByCompanion: boolean;
}

export interface IcpOwnAvailabilityReadParams {
  companionId?: string;
}

export interface IcpRuntimeAvailabilityRefreshParams {
  state: Extract<IcpAvailabilityState, 'available' | 'resting'>;
  expiresAtMs: number;
  companionId?: string;
}

export interface IcpRuntimeAvailabilityClearParams {
  companionId?: string;
}

export type IcpInitiationHandoffPrepareResult =
  | {
      authorized: true;
      permit: IcpInitiationPermit;
      rootInitiationId: string;
    }
  | {
      authorized: false;
      reasonCode: IcpAutonomyReasonCode;
    };

export interface IcpPermitConsumeResult {
  outcome: IcpPermitConsumptionOutcome;
  reasonCode?: IcpAutonomyReasonCode;
  status?: IcpPermitStatus;
  revision?: number;
}
