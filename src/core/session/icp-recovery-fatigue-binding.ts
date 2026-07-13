import type { IcpConversationCorrelation } from '../../shared/contracts/icp-autonomy.js';
import type {
  FatigueEnforcementMetadata,
  FatiguePendingSpendMetadata,
} from '../../shared/contracts/runtime.js';
import { assertFatigueEnforcementMetadataInvariants } from '../agent/fatigue/enforcement-invariants.js';

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

const ICP_ROOM_FATIGUE_CHANNEL_SETTINGS = new Set([
  'busy_human_group',
  'one_human_companion_hosted',
  'quiet_companion_room',
]);

function assertRecordedEventBinding(input: {
  recordedEvent: NonNullable<FatigueEnforcementMetadata['recordedEvent']>;
  pendingSpend: FatiguePendingSpendMetadata;
  label: string;
}): void {
  const { recordedEvent, pendingSpend, label } = input;
  const normalSpentAfter = recordedEvent.normalSpentAfter;
  const overchargeSpentAfter = recordedEvent.overchargeSpentAfter;
  const overchargeAllowance = recordedEvent.overchargeAllowance;
  const remainingOvercharge = recordedEvent.remainingOvercharge;
  const responseCounts = [
    recordedEvent.spentAfter,
    recordedEvent.remainingAllowance,
    normalSpentAfter,
    overchargeSpentAfter,
    overchargeAllowance,
    remainingOvercharge,
  ];
  if (responseCounts.some(value => value === undefined
      || !Number.isInteger(value)
      || value < 0)
    || normalSpentAfter === undefined
    || overchargeSpentAfter === undefined
    || overchargeAllowance === undefined
    || remainingOvercharge === undefined
    || recordedEvent.spentAfter !== normalSpentAfter + overchargeSpentAfter
    || recordedEvent.remainingAllowance
      !== Math.max(0, pendingSpend.limits.hardLimit - normalSpentAfter)
    || overchargeAllowance !== pendingSpend.limits.overchargeLimit
    || remainingOvercharge !== Math.max(0, overchargeAllowance - overchargeSpentAfter)
    || recordedEvent.softState
      !== (normalSpentAfter >= pendingSpend.limits.softLimit
        ? 'soft_limit_reached'
        : 'clear')
    || recordedEvent.hardState
      !== (normalSpentAfter >= pendingSpend.limits.hardLimit ? 'exhausted' : 'available')) {
    throw new Error(`${label}.fatigue recorded event derived state is inconsistent`);
  }
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
  if ((correlation.surface === 'companion_dm' && fatigue.channelSetting !== 'dm')
    || (correlation.surface === 'companion_room'
      && !ICP_ROOM_FATIGUE_CHANNEL_SETTINGS.has(fatigue.channelSetting))) {
    throw new Error(`${label}.fatigue channel setting binding does not match its ICP surface`);
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
  if (recordedEvent) {
    assertRecordedEventBinding({ recordedEvent, pendingSpend, label });
  }
}
