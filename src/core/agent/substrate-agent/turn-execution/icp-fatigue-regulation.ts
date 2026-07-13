import type {
  ChargePolicyConfig,
  FatiguePolicyConfig,
} from '../../../../shared/contracts/charge-policy.js';
import type { IcpConversationCorrelation } from '../../../../shared/contracts/icp-autonomy.js';
import type {
  CorrelationMetadata,
  FatigueEnforcementMetadata,
  FatiguePendingSpendMetadata,
} from '../../../../shared/contracts/runtime.js';
import {
  chargeSurface,
  getRunChargeContext,
  runWithChargeContext,
} from '../../../../shared/telemetry/run-charge.js';
import type { IcpFatigueRegulationReservationPort } from '../../fatigue/regulation-reservation.js';
import {
  reconcileFatigueWithReservationSnapshot,
  suppressFatigueAfterReservationExhaustion,
  type FatigueTurnDecision,
} from '../../fatigue/runtime-enforcement.js';

export interface IcpFatigueReservationReconciliation {
  correlation: IcpConversationCorrelation;
  fatigueDecision: FatigueTurnDecision;
  durableReservation: IcpConversationCorrelation | null;
}

/** Reacquire the stable turn's pending lease before replaying a durable response. */
export async function resumeIcpFatigueRegulation(input: {
  correlation: IcpConversationCorrelation;
  pendingSpend: FatiguePendingSpendMetadata;
  reservationPort: IcpFatigueRegulationReservationPort;
  fatiguePolicy: FatiguePolicyConfig;
}): Promise<void> {
  if (input.pendingSpend.decision !== 'charged'
    && input.pendingSpend.decision !== 'overcharge') {
    throw new Error('Recovered ICP fatigue reservation must describe a charged spend');
  }
  const regulation = input.fatiguePolicy.socialRegulation;
  const reservation = await input.reservationPort.reserve({
    correlation: input.correlation,
    timestampMs: input.pendingSpend.timestampMs,
    decision: input.pendingSpend.decision,
    amount: input.pendingSpend.amount,
    hardLimit: input.pendingSpend.limits.hardLimit,
    overchargeLimit: input.pendingSpend.limits.overchargeLimit,
    relationshipPressureHalfLifeMs: regulation.relationshipPressureHalfLifeMs,
    relationshipPressureWindowMs: regulation.relationshipPressureWindowMs,
    unansweredInitiationAfterMs: regulation.unansweredInitiationAfterMs,
    declinedPressureUnits: regulation.declinedPressureUnits,
    deferredPressureUnits: regulation.deferredPressureUnits,
    unansweredPressureUnits: regulation.unansweredPressureUnits,
  });
  if (reservation.outcome === 'exhausted') {
    throw new Error(
      `Recovered ICP fatigue reservation ${input.correlation.turnId} no longer owns capacity`,
    );
  }
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
  fatiguePolicy: FatiguePolicyConfig;
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
  const regulation = input.fatiguePolicy.socialRegulation;
  const reserve = async (decision: 'charged' | 'overcharge') =>
    await input.reservationPort!.reserve({
    correlation: input.correlation,
    timestampMs: evaluation.timestampMs,
    decision,
    amount: evaluation.amount,
    hardLimit: evaluation.stateBefore.allowance,
    overchargeLimit: evaluation.stateBefore.overchargeAllowance,
    relationshipPressureHalfLifeMs: regulation.relationshipPressureHalfLifeMs,
    relationshipPressureWindowMs: regulation.relationshipPressureWindowMs,
    unansweredInitiationAfterMs: regulation.unansweredInitiationAfterMs,
    declinedPressureUnits: regulation.declinedPressureUnits,
    deferredPressureUnits: regulation.deferredPressureUnits,
    unansweredPressureUnits: regulation.unansweredPressureUnits,
  });
  const localDecision = evaluation.decision === 'overcharge' ? 'overcharge' : 'charged';
  let reservation = await reserve(localDecision);
  let reservedDecision = localDecision;
  if (reservation.outcome === 'exhausted'
    && localDecision === 'charged'
    && input.fatiguePolicy.overcharge.enabled
    && input.fatigueDecision.metadata.socialRegulation.continuationEvidence.length > 0
    && reservation.overchargeSpentBefore < evaluation.stateBefore.overchargeAllowance) {
    reservation = await reserve('overcharge');
    reservedDecision = 'overcharge';
  }
  if (reservation.outcome !== 'exhausted') {
    const fatigueDecision = reconcileFatigueWithReservationSnapshot({
      fatigueDecision: input.fatigueDecision,
      reservation,
      fatiguePolicy: input.fatiguePolicy,
      decision: reservedDecision,
    });
    const correlationDecision = fatigueDecision.metadata.decision === 'overcharge_charged'
      ? 'allow_overcharge' as const
      : 'allow' as const;
    return {
      correlation: {
        ...input.correlation,
        fatigueDecision: correlationDecision,
        chargeLane: fatigueDecision.metadata.socialRegulation.chargeLane,
      },
      fatigueDecision,
      durableReservation: {
        ...input.correlation,
        fatigueDecision: correlationDecision,
        chargeLane: fatigueDecision.metadata.socialRegulation.chargeLane,
      },
    };
  }

  const metadata = suppressFatigueAfterReservationExhaustion(
    input.fatigueDecision.metadata,
    reservation,
    input.fatiguePolicy,
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
      details: {
        regulationState: regulation.state,
        rootInitiationId: regulation.rootInitiationId,
        continuationEvidence: regulation.continuationEvidence,
      },
    });
    return await input.invoke();
  });
}
