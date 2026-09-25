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
  chargeSurfaceDurably,
  getRunChargeContext,
  runWithChargeContext,
  type DurableRunChargeProbe,
  type DurableRunChargeRecorder,
} from '../../../../shared/telemetry/run-charge.js';
import type { IcpFatigueRegulationReservationPort } from '../../fatigue/regulation-reservation.js';
import type { IcpFatigueReservationOutcome } from '../../fatigue/regulation-reservation.js';
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

/**
 * Keep the write-ahead fatigue payload inside its strict recovery schema.
 * Turn correlation carries additional live observability fields that are not
 * part of the durable replay contract and must not leak into recovery state.
 */
export function projectFatiguePendingSpendCorrelation(
  correlation: CorrelationMetadata,
): Partial<CorrelationMetadata> {
  return {
    ...(correlation.turnId ? { turnId: correlation.turnId } : {}),
    ...(correlation.requestId ? { requestId: correlation.requestId } : {}),
    ...(correlation.channelId ? { channelId: correlation.channelId } : {}),
    ...(correlation.toolName ? { toolName: correlation.toolName } : {}),
    ...(correlation.toolCallId ? { toolCallId: correlation.toolCallId } : {}),
    ...(correlation.originType ? { originType: correlation.originType } : {}),
    ...(correlation.originStage ? { originStage: correlation.originStage } : {}),
    callType: correlation.callType,
    ...(correlation.purpose ? { purpose: correlation.purpose } : {}),
    ...(correlation.viewerTrustLevel
      ? { viewerTrustLevel: correlation.viewerTrustLevel }
      : {}),
    ...(correlation.requesterProvenance
      ? { requesterProvenance: correlation.requesterProvenance }
      : {}),
    ...(correlation.viewerChannelPrivacy
      ? { viewerChannelPrivacy: correlation.viewerChannelPrivacy }
      : {}),
    ...(correlation.viewerIsDirectMessage !== undefined
      ? { viewerIsDirectMessage: correlation.viewerIsDirectMessage }
      : {}),
    ...(correlation.embodimentContext
      ? { embodimentContext: structuredClone(correlation.embodimentContext) }
      : {}),
    ...(correlation.icpCorrelation
      ? { icpCorrelation: { ...correlation.icpCorrelation } }
      : {}),
  };
}

/** Reacquire the stable turn's pending lease before replaying a durable response. */
export async function resumeIcpFatigueRegulation(input: {
  correlation: IcpConversationCorrelation;
  pendingSpend: FatiguePendingSpendMetadata;
  reservationPort: IcpFatigueRegulationReservationPort;
  fatiguePolicy: FatiguePolicyConfig;
}): Promise<IcpFatigueReservationOutcome> {
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
  if (!reservation.reservationOutcome) {
    throw new Error(`Recovered ICP fatigue reservation ${input.correlation.turnId} has no durable state`);
  }
  return reservation.reservationOutcome;
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
  const localDecision: 'charged' | 'overcharge' = evaluation.decision === 'overcharge' ? 'overcharge' : 'charged';
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
    let fatigueDecision: FatigueTurnDecision;
    try {
      fatigueDecision = reconcileFatigueWithReservationSnapshot({
        fatigueDecision: input.fatigueDecision,
        reservation,
        fatiguePolicy: input.fatiguePolicy,
        decision: reservedDecision,
      });
    } catch (error) {
      // kfu2s: the durable slot is already reserved here, but the caller only
      // learns about it from this function's result. Fail and release it
      // before rethrowing, so it never stays pending with no owner.
      await releaseUnreconciledReservation(input, reservedDecision, error);
      throw error;
    }
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

async function releaseUnreconciledReservation(
  input: {
    correlation: IcpConversationCorrelation;
    fatigueDecision: FatigueTurnDecision;
    reservationPort: IcpFatigueRegulationReservationPort | null | undefined;
  },
  reservedDecision: 'charged' | 'overcharge',
  cause: unknown,
): Promise<void> {
  const port = input.reservationPort;
  if (!port) return;
  const failures: unknown[] = [];
  try {
    await port.finalize({
      correlation: input.correlation,
      outcome: 'failed',
      finalizedAtMs: Date.now(),
      // The row records the decision that was reserved, which can be an
      // overcharge the pre-reservation metadata did not carry.
      fatigue: { ...input.fatigueDecision.metadata, spendDecision: reservedDecision },
    });
  } catch (error) {
    failures.push(error);
  }
  try {
    await port.handoff(input.correlation);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new AggregateError(
      [cause, ...failures],
      `ICP fatigue reservation ${input.correlation.turnId} could not be released after a reconciliation failure`,
    );
  }
}

/** Apply the marginal social charge in its own folded run-charge lane. */
export async function invokeWithCompanionSocialCharge<T>(input: {
  chargePolicy: ChargePolicyConfig | null | undefined;
  correlation: CorrelationMetadata;
  fatigue: FatigueEnforcementMetadata | null | undefined;
  invoke: () => Promise<T>;
  recordChargeEvent: DurableRunChargeRecorder | null | undefined;
  probeChargeEvent: DurableRunChargeProbe | null | undefined;
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
  if (!input.recordChargeEvent) {
    throw new Error('Companion social continuation requires durable charge-ledger persistence');
  }
  if (!input.probeChargeEvent) {
    throw new Error('Companion social continuation requires durable charge-ledger identity lookup');
  }
  return await runWithChargeContext({
    lane: 'companion_social',
    runId: `${input.turnId}:companion-social`,
    correlation: input.withCorrelationPurpose(
      input.correlation,
      'agent.fatigue.social_charge',
    ),
  }, async () => {
    await chargeSurfaceDurably('companionSocialContinuation', {
      eventId: `${input.turnId}:companion-social`,
      probeChargeEvent: input.probeChargeEvent!,
      recordChargeEvent: input.recordChargeEvent!,
      details: {
        regulationState: regulation.state,
        rootInitiationId: regulation.rootInitiationId,
        continuationEvidence: regulation.continuationEvidence,
      },
    });
    return await input.invoke();
  });
}
