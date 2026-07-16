import type {
  IcpInitiationCapacityPolicyAuthority,
  IcpInitiationCapacityPolicyDecision,
  IcpInitiationCapacityPolicyInput,
} from "../../../boundary/gateway/icp-initiation-policy-authority.js";
import type { ChargePolicyConfig } from "../../../shared/contracts/charge-policy.js";
import type { IcpFatigueRegulationReservationPort } from "./regulation-reservation.js";
import { evaluateFatiguePolicy } from "./policy.js";
import type { RunChargeRollingWindowSnapshot } from "../../../shared/telemetry/run-charge.js";

export interface IcpSocialChargeBalanceReader {
  read(input: {
    senderCompanionId: string;
    nowMs: number;
  }): Promise<RunChargeRollingWindowSnapshot> | RunChargeRollingWindowSnapshot;
}

export interface IcpChargePolicyReader {
  read(input: {
    senderCompanionId: string;
  }): Promise<ChargePolicyConfig> | ChargePolicyConfig;
}

/**
 * Content-free deterministic initiation pressure. Conversation cost is
 * enforced separately at the gateway's canonical model-usage reservation
 * boundary. A new candidate has no conversation spend to inspect yet, so this
 * gate admits it and lets the first attributable model call reserve (or fail
 * closed) under the owner-file cost policy.
 */
export class IcpFatigueInitiationCapacityAuthority implements IcpInitiationCapacityPolicyAuthority {
  constructor(
    private readonly pressure: Pick<
      IcpFatigueRegulationReservationPort,
      "readInitiationPressure"
    >,
    private readonly chargePolicies: IcpChargePolicyReader,
    private readonly chargeBalance: IcpSocialChargeBalanceReader,
  ) {}

  async resolve(
    input: IcpInitiationCapacityPolicyInput,
  ): Promise<IcpInitiationCapacityPolicyDecision> {
    const chargePolicy = await this.chargePolicies.read({
      senderCompanionId: input.senderCompanionId,
    });
    const regulation = chargePolicy.fatigue.socialRegulation;
    const snapshot = await this.pressure.readInitiationPressure({
      localCompanionId: input.senderCompanionId,
      peerCompanionId: input.candidate.peerCompanionId,
      timestampMs: input.nowMs,
      relationshipPressureHalfLifeMs: regulation.relationshipPressureHalfLifeMs,
      relationshipPressureWindowMs: regulation.relationshipPressureWindowMs,
      unansweredAfterMs: regulation.unansweredInitiationAfterMs,
      declinedPressureUnits: regulation.declinedPressureUnits,
      deferredPressureUnits: regulation.deferredPressureUnits,
      unansweredPressureUnits: regulation.unansweredPressureUnits,
    });
    const spent = Math.ceil(snapshot.relationshipPressure);
    const policy = evaluateFatiguePolicy({
      config: chargePolicy.fatigue,
      peer: {
        // Private sender-local contact IDs are intentionally absent from the
        // shared candidate projection. The authenticated peer companion UUID
        // is the stable content-free relationship-pressure identity here.
        contactId: input.candidate.peerCompanionId,
        isMachineIntelligence: true,
        relationshipType: input.senderRelationship.relationshipType,
        trustLevel: input.senderRelationship.trustLevel,
      },
      channel: {
        channelId: input.channelId,
        type: input.channelId.startsWith("companion-dm:")
          ? "dm"
          : "companion_room",
        companionFocused: true,
        companionHosted: true,
        humanParticipantCount: 0,
        machineIntelligenceParticipantCount: 2,
        recentMessageCount: 0,
        recentHumanMessageCount: 0,
      },
      recentHumanParticipation: { messageCount: 0, participantCount: 0 },
      // Private candidate content is not visible at the gateway. Do not infer
      // a privileged work/research allowance from source labels.
      intent: "social",
      spent,
      triggerAuthorKind: "machine_intelligence",
    });
    const socialChargeCost =
      chargePolicy.surfaceCosts.companionSocialContinuation;
    const rollingCharge = await this.chargeBalance.read({
      senderCompanionId: input.senderCompanionId,
      nowMs: input.nowMs,
    });
    const rollingSocialSpent = rollingCharge.spentByLane.companion_social ?? 0;
    return {
      socialPressureAllows: spent < policy.softTarget,
      chargeAllows:
        rollingSocialSpent + socialChargeCost <=
        chargePolicy.runChargeQuotaByLane.companion_social,
      fatigueAllows: spent < policy.hardCap,
      costAllows: true,
    };
  }
}
