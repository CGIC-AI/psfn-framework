import { backfillLegacyTurnId } from '../../core/turns/id.js';
import {
  assertIcpRecoveryStatusBinding,
  parseIcpRecoveryResponse,
  type IcpDeliveryObservation,
} from '../../core/session/icp-delivery-recovery.js';
import {
  parseIcpConversationCorrelation,
  type IcpConversationCorrelation,
  type IcpInitiationPermit,
} from '../../shared/contracts/icp-autonomy.js';
import { parseCompanionChannelId } from '../../shared/contracts/companion-channels.js';
import type { AgentResponse } from '../../shared/contracts/runtime.js';

export interface RecordedIcpInitiationTurn {
  content: string;
  correlation: IcpConversationCorrelation;
  recoveryResponse: AgentResponse;
}

export interface IcpTargetRecoveryBinding {
  permit: IcpInitiationPermit;
  localCompanionId: string;
  peerContactId: string;
  rootInitiationId: string;
  sourceMessageId: string;
}

export function deriveStableIcpTargetTurnId(
  binding: IcpTargetRecoveryBinding,
): ReturnType<typeof backfillLegacyTurnId> {
  const { permit } = binding;
  return backfillLegacyTurnId(JSON.stringify({
    kind: 'icp-target-initiation',
    sourceMessageId: binding.sourceMessageId,
    permitId: permit.permitId,
    candidateId: permit.candidateId,
    conversationId: permit.conversationId,
    rootInitiationId: binding.rootInitiationId,
    provenanceRef: permit.provenanceRef,
    senderCompanionId: permit.senderCompanionId,
    localCompanionId: binding.localCompanionId,
    recipientCompanionId: permit.recipientCompanionId,
    channelId: permit.channelId,
  }));
}

export function validateIcpTargetCorrelationBinding(
  value: IcpConversationCorrelation,
  binding: IcpTargetRecoveryBinding,
): IcpConversationCorrelation {
  const parsed = parseIcpConversationCorrelation(value);
  const { permit } = binding;
  const parsedChannel = parseCompanionChannelId(permit.channelId);
  if (!parsedChannel) {
    throw new Error('Recorded ICP initiation permit channel is not canonical');
  }
  const expectedSurface = parsedChannel.kind === 'dm'
    ? 'companion_dm'
    : 'companion_room';
  const expectedTurnId = deriveStableIcpTargetTurnId(binding);
  if (parsed.localCompanionId !== binding.localCompanionId
    || parsed.initiatedByCompanionId !== binding.localCompanionId
    || parsed.peerCompanionId !== permit.recipientCompanionId
    || parsed.peerContactId !== binding.peerContactId
    || parsed.channelId !== permit.channelId
    || parsed.conversationId !== permit.conversationId
    || parsed.rootInitiationId !== binding.rootInitiationId
    || parsed.messageId !== binding.sourceMessageId
    || parsed.requestId !== binding.sourceMessageId
    || parsed.turnId !== expectedTurnId
    || parsed.chargeLane !== 'companion_social'
    || parsed.surface !== expectedSurface
    || parsed.costPurpose !== 'conversation_turn'
    || parsed.costOriginStage !== 'initiation') {
    throw new Error('Recorded ICP initiation turn does not match the permit binding');
  }
  return parsed;
}

function validateRecoveryResponse(
  response: AgentResponse,
  correlation: IcpConversationCorrelation,
  binding: IcpTargetRecoveryBinding,
  label: string,
): AgentResponse {
  return parseIcpRecoveryResponse(response, {
    label,
    expectedCorrelation: correlation,
    expectedChannelId: binding.permit.channelId,
    expectedSourceMessageId: binding.sourceMessageId,
  });
}

export function validateObservedIcpTargetRecovery(input: {
  observation: IcpDeliveryObservation;
  binding: IcpTargetRecoveryBinding;
}): {
  correlation: IcpConversationCorrelation;
  recoveryResponse: AgentResponse;
} {
  if (input.observation.channelId !== input.binding.permit.channelId
    || input.observation.sourceMessageId !== input.binding.sourceMessageId) {
    throw new Error('Durable ICP delivery observation does not match the permit source binding');
  }
  if (!input.observation.recoveryResponse) {
    throw new Error('Durable ICP observation is missing recovery evidence');
  }
  assertIcpRecoveryStatusBinding(
    input.observation.status,
    input.observation.recoveryResponse,
    'ICP target-channel recovery',
  );
  const correlation = validateIcpTargetCorrelationBinding(
    input.observation.recoveryResponse.metadata.icpCorrelation,
    input.binding,
  );
  const recoveryResponse = validateRecoveryResponse(
    input.observation.recoveryResponse,
    correlation,
    input.binding,
    'Durable ICP delivery observation recovery response',
  );
  return { correlation, recoveryResponse };
}

export function validateRecordedIcpTargetRecovery(input: {
  recorded: RecordedIcpInitiationTurn;
  observation: IcpDeliveryObservation | null;
  binding: IcpTargetRecoveryBinding;
}): {
  correlation: IcpConversationCorrelation;
  recoveryResponse: AgentResponse;
} {
  const correlation = validateIcpTargetCorrelationBinding(
    input.recorded.correlation,
    input.binding,
  );
  const recordedResponse = validateRecoveryResponse(
    input.recorded.recoveryResponse,
    correlation,
    input.binding,
    'Durable ICP assistant recovery response',
  );
  if (recordedResponse.content !== input.recorded.content) {
    throw new Error('Durable ICP assistant content does not match its recovery response');
  }
  if (!input.observation?.recoveryResponse) {
    return { correlation, recoveryResponse: recordedResponse };
  }
  const observationResponse = validateRecoveryResponse(
    input.observation.recoveryResponse,
    correlation,
    input.binding,
    'Durable ICP delivery observation recovery response',
  );
  if (observationResponse.content !== recordedResponse.content
    || JSON.stringify(observationResponse.attachments ?? [])
      !== JSON.stringify(recordedResponse.attachments ?? [])) {
    throw new Error('Durable assistant and delivery observation do not match');
  }
  return { correlation, recoveryResponse: observationResponse };
}
