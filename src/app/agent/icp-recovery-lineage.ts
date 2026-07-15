import type { IcpConversationCorrelation } from '../../shared/contracts/icp-autonomy.js';

export function assertCompanionRecoveryLineage(
  inbound: IcpConversationCorrelation,
  recovery: IcpConversationCorrelation,
  sourceMessageId: string,
): void {
  if (recovery.conversationId !== inbound.conversationId
    || recovery.rootInitiationId !== inbound.rootInitiationId
    || recovery.initiatedByCompanionId !== inbound.initiatedByCompanionId
    || recovery.localCompanionId !== inbound.peerCompanionId
    || recovery.peerCompanionId !== inbound.localCompanionId
    || recovery.channelId !== inbound.channelId
    || recovery.messageId !== sourceMessageId
    || recovery.requestId !== sourceMessageId
    || recovery.chargeLane !== inbound.chargeLane
    || recovery.surface !== inbound.surface
    || recovery.costPurpose !== inbound.costPurpose
    || recovery.costOriginStage !== 'reply') {
    throw new Error('Durable ICP recovery does not match its durable inbound episode lineage');
  }
}
