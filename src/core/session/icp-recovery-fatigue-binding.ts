import type { IcpConversationCorrelation } from '../../shared/contracts/icp-autonomy.js';
import type {
  FatigueEnforcementMetadata,
  FatiguePendingSpendMetadata,
} from '../../shared/contracts/runtime.js';
import { assertFatigueEnforcementMetadataInvariants } from '../agent/fatigue/enforcement-invariants.js';

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function assertFatigueRecoveryBinding(input: {
  fatigue: FatigueEnforcementMetadata | undefined;
  pendingSpend: FatiguePendingSpendMetadata | undefined;
  correlation: IcpConversationCorrelation;
  turnId: string;
  requestId: string;
  label: string;
}): void {
  const { fatigue, pendingSpend, correlation, turnId, requestId, label } = input;
  if (!fatigue) {
    if (pendingSpend) throw new Error(`${label}.fatigue binding requires enforcement metadata`);
    if (correlation.fatigueDecision !== 'not_evaluated') {
      throw new Error(`${label}.fatigue must be not_evaluated without enforcement metadata`);
    }
    return;
  }
  if (fatigue.scope.localCompanionId !== correlation.localCompanionId
    || fatigue.scope.peerContactId !== correlation.peerContactId
    || fatigue.scope.channelId !== correlation.channelId
    || fatigue.peer.contactId !== correlation.peerContactId) {
    throw new Error(`${label}.fatigue binding does not match its ICP correlation`);
  }
  if (!pendingSpend && fatigue.recordedEvent) {
    throw new Error(`${label}.fatigue recorded event binding requires pending spend`);
  }
  const expected = assertFatigueEnforcementMetadataInvariants(fatigue);
  const expectsPendingSpend = expected.pendingSpend === 'required';
  if (correlation.fatigueDecision !== expected.correlationDecision
    || (pendingSpend !== undefined) !== expectsPendingSpend
    || fatigue.shouldRecordSpend !== expectsPendingSpend) {
    throw new Error(`${label}.fatigue production invariant binding is inconsistent`);
  }
  if (!pendingSpend) {
    return;
  }

  const pendingCorrelation = pendingSpend.correlation;
  if (pendingSpend.scope.localCompanionId !== correlation.localCompanionId
    || pendingSpend.scope.peerContactId !== correlation.peerContactId
    || pendingSpend.scope.channelId !== correlation.channelId
    || pendingSpend.scope.dayKey !== fatigue.scope.dayKey
    || pendingSpend.peer.contactId !== correlation.peerContactId
    || pendingCorrelation.turnId !== turnId
    || pendingCorrelation.requestId !== requestId
    || pendingCorrelation.channelId !== correlation.channelId
    || !sameJson(pendingCorrelation.icpCorrelation, correlation)
    || pendingSpend.decision !== fatigue.spendDecision
    || pendingSpend.reason !== fatigue.spendReason
    || pendingSpend.amount !== fatigue.budget.amount
    || !sameJson(pendingSpend.scope, fatigue.scope)
    || !sameJson(pendingSpend.peer, fatigue.peer)
    || !sameJson(pendingSpend.triggeringAuthor, fatigue.triggeringAuthor)
    || pendingSpend.limits.softLimit !== fatigue.budget.softLimit
    || pendingSpend.limits.hardLimit !== fatigue.budget.hardLimit
    || pendingSpend.limits.overchargeLimit !== fatigue.budget.overchargeAllowance) {
    throw new Error(`${label}.fatigue binding does not match its executable pending spend`);
  }
  const recordedEvent = fatigue.recordedEvent;
  if (recordedEvent
    && (recordedEvent.timestampMs !== pendingSpend.timestampMs
      || recordedEvent.amount !== pendingSpend.amount
      || recordedEvent.amount !== fatigue.budget.amount
      || recordedEvent.decision !== pendingSpend.decision
      || recordedEvent.decision !== fatigue.spendDecision
      || recordedEvent.reason !== pendingSpend.reason
      || recordedEvent.reason !== fatigue.spendReason)) {
    throw new Error(`${label}.fatigue recorded event binding is inconsistent`);
  }
}
