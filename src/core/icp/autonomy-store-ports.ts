import type {
  IcpAutonomyReasonCode,
  IcpAvailabilitySource,
  IcpAvailabilityLease,
  IcpConversationEpisode,
  IcpConversationStatus,
  IcpInitiationPermit,
} from '../../shared/contracts/icp-autonomy.js';
import type {
  IcpInitiationDeliveryDisposition,
  IcpInitiationCandidate,
  IcpInitiationCandidateStatus,
} from './initiation-candidate.js';
import type { IcpFeltImpulseFunnelRecord } from './felt-impulse-funnel.js';

export class IcpOutstandingInvitationConflictError extends Error {
  constructor() {
    super('ICP outstanding invitation conflict for companion pair');
    this.name = 'IcpOutstandingInvitationConflictError';
  }
}

/** Generic optimistic revocation conflict; never carries the bearer permit id. */
export class IcpPermitRevocationConflictError extends Error {
  constructor() {
    super('ICP permit revocation conflict');
    this.name = 'IcpPermitRevocationConflictError';
  }
}

export interface IcpAutonomyInvalidationFenceEntry {
  companionId: string;
  generation: number;
}

export interface IcpAutonomyInvalidationFence {
  companions: readonly [
    IcpAutonomyInvalidationFenceEntry,
    IcpAutonomyInvalidationFenceEntry,
  ];
}

export class IcpAutonomyInvalidationConflictError extends Error {
  constructor(readonly reasonCode: IcpAutonomyReasonCode) {
    super(`ICP autonomy invalidated during permit operation: ${reasonCode}`);
    this.name = 'IcpAutonomyInvalidationConflictError';
  }
}

export interface IcpAvailabilityStorePort {
  publishAvailability(lease: IcpAvailabilityLease): Promise<IcpAvailabilityLease>;
  getAvailability(companionId: string): Promise<IcpAvailabilityLease | null>;
  clearAvailability(
    companionId: string,
    expectedRevision: number,
    request: { source: IcpAvailabilitySource; nowMs: number },
  ): Promise<boolean>;
}

export interface IcpAvailabilityInvalidationResult {
  lease: IcpAvailabilityLease;
  revokedPermits: IcpInitiationPermit[];
}

export interface IcpAvailabilityClearInvalidationResult {
  cleared: boolean;
  revokedPermits: IcpInitiationPermit[];
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
  expectedInvalidationFence: IcpAutonomyInvalidationFence;
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
  captureInvalidationFence(
    firstCompanionId: string,
    secondCompanionId: string,
  ): Promise<IcpAutonomyInvalidationFence>;
  issuePermit(input: {
    permit: IcpInitiationPermit;
    expectedInvalidationFence: IcpAutonomyInvalidationFence;
  }): Promise<IcpInitiationPermit>;
  getPermit(permitId: string): Promise<IcpInitiationPermit | null>;
  /** Idempotency owner for response-loss reconciliation at permit issue. */
  getPermitByCandidate(candidateId: string): Promise<IcpInitiationPermit | null>;
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
  publishAvailabilityAndInvalidate(
    lease: IcpAvailabilityLease,
    reasonCode: IcpAutonomyReasonCode,
  ): Promise<IcpAvailabilityInvalidationResult>;
  clearAvailabilityAndInvalidate(
    companionId: string,
    expectedRevision: number,
    request: { source: IcpAvailabilitySource; nowMs: number },
    reasonCode: IcpAutonomyReasonCode,
  ): Promise<IcpAvailabilityClearInvalidationResult>;
  createEpisodeAndIssuePermit(input: {
    episode: IcpConversationEpisode;
    permit: IcpInitiationPermit;
    expectedInvalidationFence: IcpAutonomyInvalidationFence;
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
  /** Bound only when the broker has issued the recovery-safe permit. */
  permitId?: string;
  /** Written atomically with consumed so recovery can distinguish delivery from suppression. */
  deliveryDisposition?: IcpInitiationDeliveryDisposition;
  /** Durable retry counter written with a deferred or exhausted transition. */
  retryAttempt?: number;
  /** Durable cooldown boundary written with a deferred transition. */
  retryEligibleAtMs?: number;
  /** Clears a satisfied cooldown when deferred returns to pending. */
  clearRetryEligibility?: boolean;
}

export interface IcpInitiationCandidateClaim {
  candidate: IcpInitiationCandidate;
  /** Opaque private lease binding. Never project this token outside the companion runtime. */
  claimToken: string;
  /** Operational-clock lease boundary used only for owner renewal. */
  claimExpiresAtMs: number;
}

export interface IcpInitiationCandidateClaimOptions {
  nowMs: number;
  claimLeaseMs: number;
  limit: number;
}

export interface IcpInitiationCandidateProducerClaim {
  /** Opaque private ownership token held only by the active source runtime. */
  claimToken: string;
  /** Bounded crash-recovery boundary after which a supervisor may reclaim the row. */
  claimExpiresAtMs: number;
}

export interface IcpInitiationCandidateStorePort {
  createCandidate(candidate: IcpInitiationCandidate): Promise<IcpInitiationCandidate>;
  /** Atomically creates a candidate with a producer lease so recovery cannot race live delivery. */
  createClaimedCandidate?(
    candidate: IcpInitiationCandidate,
    claim: IcpInitiationCandidateProducerClaim,
  ): Promise<IcpInitiationCandidate>;
  /** Atomically creates a claimed felt-impulse candidate and its content-free funnel link. */
  createClaimedFeltImpulseCandidate?(
    candidate: IcpInitiationCandidate,
    claim: IcpInitiationCandidateProducerClaim,
    outcome: Extract<IcpFeltImpulseFunnelRecord, { outcome: 'candidate_linked' }>,
  ): Promise<IcpInitiationCandidate>;
  /** Atomically takes an unowned nonterminal candidate for exact source replay. */
  claimCandidate?(
    candidateId: string,
    claim: IcpInitiationCandidateProducerClaim,
  ): Promise<IcpInitiationCandidate | null>;
  /** Extends an exact live owner lease without changing candidate business state. */
  renewCandidateClaim?(
    candidateId: string,
    claim: IcpInitiationCandidateProducerClaim,
  ): Promise<void>;
  /** Releases only the caller's exact lease; already-cleared terminal rows are a no-op. */
  releaseCandidateClaim?(candidateId: string, claimToken: string): Promise<void>;
  getCandidate(candidateId: string): Promise<IcpInitiationCandidate | null>;
  getCandidateByPendingFollowUpId(
    pendingFollowUpId: string,
  ): Promise<IcpInitiationCandidate | null>;
  listCandidates(options?: IcpInitiationCandidateListOptions): Promise<IcpInitiationCandidate[]>;
  transitionCandidate(
    input: IcpInitiationCandidateTransitionInput,
  ): Promise<IcpInitiationCandidate>;
  /** Atomically leases source-independent lifecycle work with SKIP LOCKED semantics. */
  claimDueCandidates?(
    options: IcpInitiationCandidateClaimOptions,
  ): Promise<IcpInitiationCandidateClaim[]>;
  /** Applies a transition only while the caller still owns the exact durable lease. */
  transitionClaimedCandidate?(
    claimToken: string,
    input: IcpInitiationCandidateTransitionInput,
  ): Promise<IcpInitiationCandidate>;
  close(): Promise<void>;
}
