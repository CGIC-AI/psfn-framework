import type { IcpConversationCorrelation } from "../../../shared/contracts/icp-autonomy.js";
import type {
  FatigueBudgetDecision,
  FatigueEnforcementMetadata,
} from "../../../shared/contracts/runtime.js";

export type IcpFatigueReservationOutcome =
  "pending" | "delivered" | "no_reply" | "failed";

export interface IcpFatigueReservationInput {
  correlation: IcpConversationCorrelation;
  timestampMs: number;
  decision: Extract<FatigueBudgetDecision, "charged" | "overcharge">;
  amount: number;
  hardLimit: number;
  overchargeLimit: number;
  relationshipPressureHalfLifeMs: number;
  relationshipPressureWindowMs: number;
  reservationTtlMs: number;
  declinedPressureUnits: number;
  deferredPressureUnits: number;
  unansweredPressureUnits: number;
}

export interface IcpFatigueReservationResult {
  outcome: "reserved" | "replayed" | "exhausted";
  normalSpentBefore: number;
  overchargeSpentBefore: number;
  relationshipPressure: number;
  rootNormalSpent: number;
}

export interface IcpInitiationPressureInput {
  localCompanionId: string;
  peerCompanionId: string;
  timestampMs: number;
  relationshipPressureHalfLifeMs: number;
  relationshipPressureWindowMs: number;
  unansweredAfterMs: number;
  declinedPressureUnits: number;
  deferredPressureUnits: number;
  unansweredPressureUnits: number;
}

export interface IcpInitiationPressureSnapshot {
  relationshipPressure: number;
  chargedPressure: number;
  declinedPressure: number;
  deferredPressure: number;
  unansweredPressure: number;
  contributingReservationCount: number;
  contributingEpisodeCount: number;
}

/** Durable concurrency fence used by the existing fatigue decision engine. */
export interface IcpFatigueRegulationReservationPort {
  reserve(
    input: IcpFatigueReservationInput,
  ): Promise<IcpFatigueReservationResult>;
  readInitiationPressure(
    input: IcpInitiationPressureInput,
  ): Promise<IcpInitiationPressureSnapshot>;
  finalize(input: {
    correlation: IcpConversationCorrelation;
    outcome: Exclude<IcpFatigueReservationOutcome, "pending">;
    finalizedAtMs: number;
    fatigue: FatigueEnforcementMetadata;
  }): Promise<void>;
  close(): Promise<void>;
}
