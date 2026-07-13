import type {
  ChargePolicyConfig,
  FatigueSocialRegulationConfig,
} from '../../../../shared/contracts/charge-policy.js';
import type { IcpConversationCorrelation } from '../../../../shared/contracts/icp-autonomy.js';
import type {
  CorrelationMetadata,
  FatigueEnforcementMetadata,
} from '../../../../shared/contracts/runtime.js';
import {
  chargeSurface,
  getRunChargeContext,
  runWithChargeContext,
} from '../../../../shared/telemetry/run-charge.js';
import type { IcpFatigueRegulationReservationPort } from '../../fatigue/regulation-reservation.js';
import {
  suppressFatigueAfterReservationExhaustion,
  type FatigueTurnDecision,
} from '../../fatigue/runtime-enforcement.js';

export interface IcpFatigueReservationReconciliation {
  correlation: IcpConversationCorrelation;
  fatigueDecision: FatigueTurnDecision;
  durableReservation: IcpConversationCorrelation | null;
}

/**
 * Serialize an ICP fatigue spend before model execution. The shared store is a
 * concurrency fence around the existing local policy engine, not a second
 * decision authority.
 */
export async function reserveIcpFatigueRegulation(input: {
  correlation: IcpConversationCorrelation;
  fatigueDecision: FatigueTurnDecision;
  multiCompanion: boolean;
  reservationPort: IcpFatigueRegulationReservationPort | null | undefined;
  regulationConfig: FatigueSocialRegulationConfig;
}): Promise<IcpFatigueReservationReconciliation> {
  if (!input.fatigueDecision.shouldRecordSpend) {
    return {
      correlation: input.correlation,
      fatigueDecision: input.fatigueDecision,
      durableReservation: null,
    };
  }
  if (!input.reservationPort) {
    if (input.multiCompanion) {
      throw new Error('ICP fatigue enforcement requires durable regulation reservations');
    }
    return {
      correlation: input.correlation,
      fatigueDecision: input.fatigueDecision,
      durableReservation: null,
    };
  }

  const evaluation = input.fatigueDecision.evaluation;
  const regulation = input.regulationConfig;
  const reservation = await input.reservationPort.reserve({
    correlation: input.correlation,
    timestampMs: evaluation.timestampMs,
    decision: evaluation.decision === 'overcharge' ? 'overcharge' : 'charged',
    amount: evaluation.amount,
    hardLimit: evaluation.stateBefore.allowance,
    overchargeLimit: evaluation.stateBefore.overchargeAllowance,
    relationshipPressureHalfLifeMs: regulation.relationshipPressureHalfLifeMs,
    relationshipPressureWindowMs: regulation.relationshipPressureWindowMs,
    reservationTtlMs: regulation.reservationTtlMs,
    declinedPressureUnits: regulation.declinedPressureUnits,
    deferredPressureUnits: regulation.deferredPressureUnits,
    unansweredPressureUnits: regulation.unansweredPressureUnits,
  });
  if (reservation.outcome !== 'exhausted') {
    return {
      correlation: input.correlation,
      fatigueDecision: input.fatigueDecision,
      durableReservation: input.correlation,
    };
  }

  const metadata = suppressFatigueAfterReservationExhaustion(
    input.fatigueDecision.metadata,
    reservation,
  );
  return {
    correlation: {
      ...input.correlation,
      fatigueDecision: 'suppress',
      fatigueReasonCode: 'fatigue_exhausted',
      chargeLane: metadata.socialRegulation.chargeLane,
    },
    fatigueDecision: {
      ...input.fatigueDecision,
      metadata,
      suppressModel: true,
      shouldRecordSpend: false,
    },
    durableReservation: null,
  };
}

/** Apply the marginal social charge in its own folded run-charge lane. */
export async function invokeWithCompanionSocialCharge<T>(input: {
  chargePolicy: ChargePolicyConfig | null | undefined;
  correlation: CorrelationMetadata;
  fatigue: FatigueEnforcementMetadata | null | undefined;
  invoke: () => Promise<T>;
  turnId: string;
  withCorrelationPurpose: (
    correlation: CorrelationMetadata,
    purpose: string,
  ) => CorrelationMetadata;
}): Promise<T> {
  const regulation = input.fatigue?.socialRegulation;
  if (!regulation || regulation.marginalChargeUnits === 0) {
    return await input.invoke();
  }
  if (!getRunChargeContext() || !input.chargePolicy) {
    throw new Error('Companion social continuation requires an active charge-policy context');
  }
  return await runWithChargeContext({
    lane: 'companion_social',
    runId: `${input.turnId}:companion-social`,
    correlation: input.withCorrelationPurpose(
      input.correlation,
      'agent.fatigue.social_charge',
    ),
  }, async () => {
    chargeSurface('companionSocialContinuation', {
      amount: regulation.marginalChargeUnits,
      details: {
        regulationState: regulation.state,
        rootInitiationId: regulation.rootInitiationId,
        continuationEvidence: regulation.continuationEvidence,
      },
    });
    return await input.invoke();
  });
}
