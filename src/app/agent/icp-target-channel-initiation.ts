import { createTurnId } from '../../core/turns/id.js';
import { parseCompanionChannelId } from '../../shared/contracts/companion-channels.js';
import {
  parseIcpConversationCorrelation,
  parseIcpInitiationPermit,
  type IcpConversationCorrelation,
  type IcpInitiationPermit,
} from '../../shared/contracts/icp-autonomy.js';
import type { AgentResponse, SubstrateMessage } from '../../shared/contracts/runtime.js';
import { toErrorMessage } from '../../shared/utils/errors.js';

export const ICP_TARGET_TURN_PROMPT =
  'Initiate one natural message to the peer in this channel, using the ordinary channel context.';

export interface RecordedIcpInitiationTurn {
  content: string;
  correlation: IcpConversationCorrelation;
}

export interface IcpDeliveryObservation {
  channelId: string;
  sourceMessageId: string;
  status: 'delivered' | 'failed' | 'suppressed';
  gatewayMessageId?: string;
  deliveredTo?: readonly string[];
  permitOutcome?: 'consumed' | 'replayed';
  error?: string;
}

export interface IcpTargetChannelAgentPort {
  /** The one ordinary SubstrateAgent channel-turn entrypoint. */
  handleMessage(message: SubstrateMessage): Promise<AgentResponse>;
  /** Restart-safe lookup in the canonical channel journal. */
  findRecordedIcpInitiation(
    channelId: string,
    sourceMessageId: string,
  ): Promise<RecordedIcpInitiationTurn | null> | RecordedIcpInitiationTurn | null;
  /** Durable local delivery fact; never asserted as peer-shared transcript speech. */
  recordIcpDeliveryObservation(observation: IcpDeliveryObservation): Promise<void> | void;
}

export interface IcpInitiationSendResult {
  channelId: string;
  messageId: string;
  deliveredTo: string[];
  skippedOffline: string[];
  permitOutcome: 'consumed' | 'replayed';
}

export interface IcpTargetChannelGatewayPort {
  /** Existing companion.message.send lane with an initiation permit binding. */
  sendInitiation(input: {
    channelId: string;
    content: string;
    authorName?: string;
    permitId: string;
    conversationId: string;
    recipientCompanionId: string;
    correlation: IcpConversationCorrelation;
  }): Promise<IcpInitiationSendResult>;
}

export interface IcpTargetChannelInitiationRequest {
  permit: IcpInitiationPermit;
  /** Independent-root lineage from the private candidate that obtained this permit. */
  rootInitiationId: string;
  /** Sender-local canonical contact for the recipient companion. */
  peerContactId: string;
}

export type IcpTargetChannelInitiationResult =
  | {
      disposition: 'delivered';
      recoveredTurn: boolean;
      correlation: IcpConversationCorrelation;
      gatewayMessageId: string;
      deliveredTo: string[];
    }
  | {
      disposition: 'suppressed';
      recoveredTurn: boolean;
      correlation: IcpConversationCorrelation;
    };

export interface IcpTargetChannelInitiator {
  initiate(request: IcpTargetChannelInitiationRequest): Promise<IcpTargetChannelInitiationResult>;
}

function requirePeerContactId(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error('ICP target-channel initiation requires peerContactId');
  return normalized;
}

function buildCorrelation(input: {
  permit: IcpInitiationPermit;
  localCompanionId: string;
  peerContactId: string;
  rootInitiationId: string;
}): IcpConversationCorrelation {
  const { permit } = input;
  const parsedChannel = parseCompanionChannelId(permit.channelId);
  if (!parsedChannel) {
    throw new Error('ICP target-channel initiation requires a canonical companion channel');
  }
  const requestId = `icp-initiation:${permit.candidateId}`;
  return parseIcpConversationCorrelation({
    conversationId: permit.conversationId,
    rootInitiationId: input.rootInitiationId,
    initiatedByCompanionId: input.localCompanionId,
    localCompanionId: input.localCompanionId,
    peerCompanionId: permit.recipientCompanionId,
    peerContactId: input.peerContactId,
    channelId: permit.channelId,
    turnId: createTurnId(),
    messageId: requestId,
    requestId,
    chargeLane: 'companion_social',
    surface: parsedChannel.kind === 'dm' ? 'companion_dm' : 'companion_room',
    costPurpose: 'conversation_turn',
    costOriginStage: 'initiation',
    fatigueDecision: 'not_evaluated',
  });
}

function buildPrivateTurnMessage(correlation: IcpConversationCorrelation): SubstrateMessage {
  return {
    id: correlation.requestId,
    channelId: correlation.channelId,
    channelType: 'companion',
    authorId: 'system:icp-initiation',
    authorName: 'ICP Initiation',
    content: ICP_TARGET_TURN_PROMPT,
    timestamp: new Date(),
    isDirectMessage: correlation.surface === 'companion_dm',
    routing: {
      source: 'companion',
      canonicalContactId: correlation.peerContactId,
      authorIsMachineIntelligence: true,
      privateTurnTrigger: true,
      icpCorrelation: correlation,
    },
  };
}

export function createIcpTargetChannelInitiator(input: {
  localCompanionId: string;
  agent: IcpTargetChannelAgentPort;
  gateway: IcpTargetChannelGatewayPort;
  authorName?: string;
}): IcpTargetChannelInitiator {
  const localCompanionId = input.localCompanionId.trim();
  if (!localCompanionId) throw new Error('ICP target-channel initiator requires localCompanionId');

  const inFlight = new Map<string, Promise<IcpTargetChannelInitiationResult>>();

  const execute = async (
    request: IcpTargetChannelInitiationRequest,
    permit: IcpInitiationPermit,
  ): Promise<IcpTargetChannelInitiationResult> => {
    const peerContactId = requirePeerContactId(request.peerContactId);
    const sourceMessageId = `icp-initiation:${permit.candidateId}`;
    const recorded = await input.agent.findRecordedIcpInitiation(permit.channelId, sourceMessageId);
    let recoveredTurn = recorded !== null;
    let content: string;
    let correlation: IcpConversationCorrelation;

    if (recorded) {
      correlation = parseIcpConversationCorrelation(recorded.correlation);
      if (correlation.localCompanionId !== localCompanionId
        || correlation.peerCompanionId !== permit.recipientCompanionId
        || correlation.peerContactId !== peerContactId
        || correlation.channelId !== permit.channelId
        || correlation.conversationId !== permit.conversationId
        || correlation.rootInitiationId !== request.rootInitiationId
        || correlation.requestId !== sourceMessageId) {
        throw new Error('Recorded ICP initiation turn does not match the permit binding');
      }
      content = recorded.content;
    } else {
      recoveredTurn = false;
      correlation = buildCorrelation({
        permit,
        localCompanionId,
        peerContactId,
        rootInitiationId: request.rootInitiationId,
      });
      const response = await input.agent.handleMessage(buildPrivateTurnMessage(correlation));
      content = response.content;
      if (response.metadata.icpCorrelation) {
        correlation = parseIcpConversationCorrelation(response.metadata.icpCorrelation);
      }
    }

    if (!content.trim()) {
      await input.agent.recordIcpDeliveryObservation({
        channelId: permit.channelId,
        sourceMessageId,
        status: 'suppressed',
      });
      return { disposition: 'suppressed', recoveredTurn, correlation };
    }

    try {
      const delivery = await input.gateway.sendInitiation({
        channelId: permit.channelId,
        content,
        ...(input.authorName?.trim() ? { authorName: input.authorName.trim() } : {}),
        permitId: permit.permitId,
        conversationId: permit.conversationId,
        recipientCompanionId: permit.recipientCompanionId,
        correlation,
      });
      await input.agent.recordIcpDeliveryObservation({
        channelId: permit.channelId,
        sourceMessageId,
        status: 'delivered',
        gatewayMessageId: delivery.messageId,
        deliveredTo: delivery.deliveredTo,
        permitOutcome: delivery.permitOutcome,
      });
      return {
        disposition: 'delivered',
        recoveredTurn,
        correlation,
        gatewayMessageId: delivery.messageId,
        deliveredTo: delivery.deliveredTo,
      };
    } catch (error) {
      await input.agent.recordIcpDeliveryObservation({
        channelId: permit.channelId,
        sourceMessageId,
        status: 'failed',
        error: toErrorMessage(error),
      });
      throw error;
    }
  };

  return {
    async initiate(request): Promise<IcpTargetChannelInitiationResult> {
      const permit = parseIcpInitiationPermit(request.permit);
      if (permit.senderCompanionId !== localCompanionId) {
        throw new Error('ICP permit sender does not match the authenticated local companion');
      }
      if (permit.status !== 'issued' && permit.status !== 'consumed') {
        throw new Error(`ICP target-channel initiation cannot use a ${permit.status} permit`);
      }
      if (Date.now() >= permit.expiresAtMs) {
        throw new Error('ICP target-channel initiation retry window has expired');
      }
      const key = `${permit.channelId}\0${permit.candidateId}`;
      const current = inFlight.get(key);
      if (current) return await current;
      const pending = execute(request, permit).finally(() => {
        if (inFlight.get(key) === pending) inFlight.delete(key);
      });
      inFlight.set(key, pending);
      return await pending;
    },
  };
}
