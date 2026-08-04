import type {
  IcpAutonomyReasonCode,
  IcpAvailabilityLease,
  IcpConversationEpisode,
  IcpInitiationCandidateStatus,
  IcpInitiationPermit,
  IcpInitiationSource,
} from '../../../../shared/contracts/icp-autonomy.js';
import type { IcpConversationCostBreakerDecisionReason } from '../../../../shared/telemetry/model-usage.js';
import type { EffectiveIcpAutonomySettingsState } from './settings.js';

export interface AdminIcpCandidateView {
  candidateId: string;
  rootInitiationId: string;
  localCompanionId: string;
  peerCompanionId: string;
  preferredChannel: 'dm' | 'current_room';
  source: IcpInitiationSource;
  provenanceRef: string;
  createdAtMs: number;
  expiresAtMs: number;
  status: IcpInitiationCandidateStatus;
  reasonCode?: IcpAutonomyReasonCode;
  revision: number;
}

export type AdminIcpAvailabilityView = IcpAvailabilityLease & {
  local: boolean;
  current: boolean;
};

export type AdminIcpEpisodeView = IcpConversationEpisode & {
  links: {
    sessions: '/sessions';
    charges: '/charge-budget';
    modelUsage: '/models';
  };
};

/** Permit bearer identity is intentionally absent from the Garden contract. */
export type AdminIcpPermitView = Omit<IcpInitiationPermit, 'permitId'>;

export interface AdminIcpFatigueView {
  conversationId: string;
  rootInitiationId: string;
  localCompanionId: string;
  peerCompanionId: string;
  channelId: string;
  chargedUnits: number;
  overchargeUnits: number;
  turnCount: number;
  pendingCount: number;
  deliveredCount: number;
  failedCount: number;
  latestReservedAtMs: number;
}

export interface AdminIcpCostView {
  conversationId: string;
  rootInitiationId: string;
  recordedAtMs: number;
  actualCostUsd: number;
  pendingProjectedCostUsd: number;
  projectedTotalCostUsd: number;
  warningThresholdUsd: number;
  hardLimitUsd: number;
  unknownCostAttemptCount: number;
  allowed: boolean;
  reason: IcpConversationCostBreakerDecisionReason;
}

export type AdminIcpCostProjectionStatus =
  | { available: true; unavailableReason: null }
  | {
    available: false;
    unavailableReason:
      | 'control_plane_unavailable'
      | 'relation_contract_unavailable'
      | 'row_contract_invalid'
      | 'read_failed';
  };

export interface AdminIcpReasonCount {
  reasonCode: IcpAutonomyReasonCode;
  count: number;
}

export interface AdminIcpAutonomyData {
  available: boolean;
  localCompanionId: string | null;
  runtimeEnabled: boolean;
  /**
   * Count of ICP-eligible sibling contacts (channel='companion' identity +
   * machine-intelligence) in this companion's own contact store, or null when
   * no probe is wired. 0 means peer selection can never succeed until
   * `npm run seed:sibling-contacts -- --apply` runs (hrmrq.34).
   */
  companionPeerContactCount: number | null;
  settings: EffectiveIcpAutonomySettingsState;
  availability: AdminIcpAvailabilityView[];
  candidates: AdminIcpCandidateView[];
  episodes: AdminIcpEpisodeView[];
  permits: AdminIcpPermitView[];
  fatigue: AdminIcpFatigueView[];
  costs: AdminIcpCostView[];
  /** Optional cost analytics never decide availability of the ICP control plane. */
  costProjection: AdminIcpCostProjectionStatus;
  reasonCounts: AdminIcpReasonCount[];
  failureCount: number;
  quietState: 'disabled' | 'unavailable_topology' | 'no_candidates' | 'active' | 'failures_observed';
  quietExplanation: string;
  redaction: {
    privateMotivation: 'withheld';
    peerContactIds: 'withheld';
    permitBearerIds: 'withheld';
    transcripts: 'not_collected';
  };
}

export interface AdminIcpCandidateCancelInput {
  candidateId: string;
  expectedRevision: number;
}

export interface AdminIcpMutationResult {
  ok: true;
  revokedPermitCount: number;
  message: string;
}

export interface AdminIcpAutonomyService {
  getData(): Promise<AdminIcpAutonomyData>;
  cancelCandidate(input: AdminIcpCandidateCancelInput): Promise<AdminIcpMutationResult>;
  setDoNotDisturb(): Promise<AdminIcpMutationResult>;
  emergencyDisable(): Promise<AdminIcpMutationResult>;
  close?(): Promise<void>;
}
