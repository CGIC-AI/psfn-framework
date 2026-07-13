import type {
  IcpAutonomyReasonCode,
  IcpAvailabilitySource,
  IcpAvailabilityLease,
  IcpConversationEpisode,
  IcpConversationStatus,
  IcpInitiationPermit,
} from '../../shared/contracts/icp-autonomy.js';
import type {
  IcpInitiationCandidate,
  IcpInitiationCandidateStatus,
} from './initiation-candidate.js';

export interface IcpAvailabilityStorePort {
  publishAvailability(lease: IcpAvailabilityLease): Promise<IcpAvailabilityLease>;
  getAvailability(companionId: string): Promise<IcpAvailabilityLease | null>;
  clearAvailability(
    companionId: string,
    expectedRevision: number,
    request: { source: IcpAvailabilitySource; nowMs: number },
  ): Promise<boolean>;
}

export interface IcpConversationTransitionInput {
  conversationId: string;
  expectedStatus: IcpConversationStatus;
  expectedRevision: number;
  expectedLastActivityAtMs: number;
  status: IcpConversationStatus;
  lastActivityAtMs: number;
  closeReasonCode?: IcpAutonomyReasonCode;
}

export interface IcpConversationEpisodeStorePort {
  createEpisode(episode: IcpConversationEpisode): Promise<IcpConversationEpisode>;
  getEpisode(conversationId: string): Promise<IcpConversationEpisode | null>;
  transitionEpisode(input: IcpConversationTransitionInput): Promise<IcpConversationEpisode>;
}

export interface IcpPermitConsumptionInput {
  permitId: string;
  conversationId: string;
  senderCompanionId: string;
  recipientCompanionId: string;
  channelId: string;
  consumedAtMs: number;
}

export type IcpPermitConsumptionOutcome =
  | 'consumed'
  | 'not_found'
  | 'expired'
  | 'revoked'
  | 'replayed'
  | 'mismatch';

export interface IcpPermitConsumptionResult {
  outcome: IcpPermitConsumptionOutcome;
  permit: IcpInitiationPermit | null;
  reasonCode?: IcpAutonomyReasonCode;
}

export interface IcpInitiationPermitStorePort {
  issuePermit(permit: IcpInitiationPermit): Promise<IcpInitiationPermit>;
  getPermit(permitId: string): Promise<IcpInitiationPermit | null>;
  consumePermit(input: IcpPermitConsumptionInput): Promise<IcpPermitConsumptionResult>;
  revokePermit(
    permitId: string,
    expectedRevision: number,
    revokedAtMs: number,
    reasonCode: IcpAutonomyReasonCode,
  ): Promise<IcpInitiationPermit>;
  findOutstandingPermitBetween(
    firstCompanionId: string,
    secondCompanionId: string,
    nowMs: number,
  ): Promise<IcpInitiationPermit | null>;
  revokeOutstandingPermitsForCompanion(
    companionId: string,
    revokedAtMs: number,
    reasonCode: IcpAutonomyReasonCode,
  ): Promise<IcpInitiationPermit[]>;
  revokeOutstandingPermitsOutsideFleet(
    knownCompanionIds: readonly string[],
    revokedAtMs: number,
  ): Promise<IcpInitiationPermit[]>;
}

export interface IcpSharedAutonomyStorePort extends
  IcpAvailabilityStorePort,
  IcpConversationEpisodeStorePort,
  IcpInitiationPermitStorePort {
  createEpisodeAndIssuePermit(input: {
    episode: IcpConversationEpisode;
    permit: IcpInitiationPermit;
  }): Promise<{ episode: IcpConversationEpisode; permit: IcpInitiationPermit }>;
  close(): Promise<void>;
}

export interface IcpInitiationCandidateListOptions {
  statuses?: readonly IcpInitiationCandidateStatus[];
  limit?: number;
}

export interface IcpInitiationCandidateTransitionInput {
  candidateId: string;
  expectedStatus: IcpInitiationCandidateStatus;
  expectedRevision: number;
  status: IcpInitiationCandidateStatus;
  reasonCode?: IcpAutonomyReasonCode;
}

export interface IcpInitiationCandidateStorePort {
  createCandidate(candidate: IcpInitiationCandidate): Promise<IcpInitiationCandidate>;
  getCandidate(candidateId: string): Promise<IcpInitiationCandidate | null>;
  listCandidates(options?: IcpInitiationCandidateListOptions): Promise<IcpInitiationCandidate[]>;
  transitionCandidate(
    input: IcpInitiationCandidateTransitionInput,
  ): Promise<IcpInitiationCandidate>;
  close(): Promise<void>;
}
