import type {
  IcpAutonomyReasonCode,
  IcpAvailabilityLease,
  IcpAvailabilitySource,
  IcpAvailabilityState,
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
  /**
   * Content-free target delivery result, written when a candidate reaches the
   * terminal `consumed` status. 'delivered' means an initiation message was
   * actually sent; 'suppressed' means it was resolved without sending. The
   * private reason summary that explains the disposition stays companion-local.
   */
  deliveryDisposition?: AdminIcpDeliveryDisposition;
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

export interface AdminIcpDeliveryTelemetry {
  /**
   * Current coarse availability for this companion, or null when no current
   * lease exists (the stable empty/degraded state). Reuses the already-loaded
   * availability projection; no second telemetry store.
   */
  currentAvailability: AdminIcpCurrentAvailabilitySummary | null;
  /** Bounded content-free initiation lifecycle counts. */
  initiation: AdminIcpInitiationLifecycleCounts;
  /** Bounded content-free message (turn) lifecycle counts. */
  messages: AdminIcpMessageLifecycleCounts;
  /**
   * Most recent resolved delivery event and its wall-clock timestamp, or null
   * when no resolved event is recorded. Never carries message body, channel
   * identity, contact identity, provenance text, or reason summaries.
   */
  recentOutcome: AdminIcpRecentDeliveryEvent | null;
}

export interface AdminIcpCurrentAvailabilitySummary {
  state: IcpAvailabilityState;
  source: IcpAvailabilitySource;
  issuedAtMs: number;
  expiresAtMs: number;
  current: boolean;
}

export interface AdminIcpInitiationLifecycleCounts {
  /** Outstanding unresolved invites: pending + permitted candidates. */
  invited: number;
  /** Consumed candidates resolved with a delivered initiation message. */
  delivered: number;
  /** Consumed candidates resolved without sending (e.g. fatigue-suppressed). */
  suppressed: number;
  /** Candidates deferred into a bounded retry window. */
  deferred: number;
  /** Candidates declined by policy. */
  declined: number;
  /** Candidates rejected by policy (for example delivery_failed). */
  failed: number;
  /** Candidates expired before resolution (stale). */
  expired: number;
  /** Candidates cancelled by the operator. */
  cancelled: number;
}

export interface AdminIcpMessageLifecycleCounts {
  /** Turn reservations finalized as delivered (a message reached the peer). */
  delivered: number;
  /** Turn reservations pending or in-flight (not yet finalized). */
  pending: number;
  /** Turn reservations finalized as failed. */
  failed: number;
  /** Total bounded turn reservations observed for this companion. */
  observed: number;
}

export interface AdminIcpRecentDeliveryEvent {
  /** Which lifecycle produced this most recent resolved outcome. */
  kind: 'initiation' | 'message';
  /** Content-free outcome; never a reason summary or message text. */
  outcome: AdminIcpDeliveryOutcome;
  /** Wall-clock timestamp of the resolved event. */
  timestampMs: number;
}

type AdminIcpDeliveryOutcome =
  | 'delivered'
  | 'suppressed'
  | 'deferred'
  | 'declined'
  | 'failed'
  | 'expired';

/** Content-free initiation target result; the private reason summary is withheld. */
type AdminIcpDeliveryDisposition = 'delivered' | 'suppressed';

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
  /**
   * Trustworthy content-free delivery telemetry: current availability plus
   * initiation/message lifecycle counts and the most recent resolved outcome.
   * Computed from the already-loaded bounded projection — no second telemetry
   * store and no routing changes — and never exposes message body, private
   * channel id, contact identity, provenance text, or reason summaries.
   */
  delivery: AdminIcpDeliveryTelemetry;
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

export interface AdminIcpTestInitiationInput {
  peerCompanionId: string;
  requestId: string;
}

export interface AdminIcpTestInitiationResult {
  outcome: 'accepted';
  candidateId: string;
  status: IcpInitiationCandidateStatus;
  deliveryDisposition: 'pending' | 'delivered' | 'suppressed';
}

export interface AdminIcpTestInitiationPort {
  trigger(input: AdminIcpTestInitiationInput): Promise<AdminIcpTestInitiationResult>;
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
  triggerTestInitiation(input: AdminIcpTestInitiationInput): Promise<AdminIcpTestInitiationResult>;
  close?(): Promise<void>;
}
