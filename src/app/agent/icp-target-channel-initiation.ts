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
import type { IcpDeliveryObservation } from '../../core/session/icp-delivery-recovery.js';

export type { IcpDeliveryObservation } from '../../core/session/icp-delivery-recovery.js';

export const ICP_TARGET_TURN_PROMPT =
  'Initiate one natural message to the peer in this channel, using the ordinary channel context.';

export interface RecordedIcpInitiationTurn {
  content: string;
  correlation: IcpConversationCorrelation;
  recoveryResponse: AgentResponse;
}

export interface IcpTargetChannelAgentPort {
  /** The one ordinary SubstrateAgent channel-turn entrypoint. */
  handleMessage(
    message: SubstrateMessage,
    deliveryLifecycle: {
      recoveredResponse?: AgentResponse;
      finalizeDelivery(response: AgentResponse): Promise<void>;
    },
  ): Promise<AgentResponse>;
  /** Restart-safe lookup in the canonical channel journal. */
  findRecordedIcpInitiation(
    channelId: string,
    sourceMessageId: string,
  ): Promise<RecordedIcpInitiationTurn | null> | RecordedIcpInitiationTurn | null;
  findIcpDeliveryObservation(
    channelId: string,
    sourceMessageId: string,
  ): Promise<IcpDeliveryObservation | null>
    | IcpDeliveryObservation
    | null;
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
  consumeInitiationPermit(input: {
    permitId: string;
    conversationId: string;
    recipientCompanionId: string;
    channelId: string;
    rootInitiationId: string;
  }): Promise<{ outcome: 'consumed' | 'replayed' | string }>;
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
    const previousObservation = await input.agent.findIcpDeliveryObservation(
      permit.channelId,
      sourceMessageId,
    );
    const recorded = await input.agent.findRecordedIcpInitiation(permit.channelId, sourceMessageId);
    if (!recorded
      && previousObservation?.turnCompleted
      && previousObservation.status === 'suppressed') {
      throw new Error('ICP target-channel initiation was already durably suppressed');
    }
    let recoveredTurn = recorded !== null;
    let content: string;
    let correlation: IcpConversationCorrelation;
    let turnResponse: AgentResponse | undefined;
    let lastDeliveryObservation: IcpDeliveryObservation | null = previousObservation;

    const validateRecordedCorrelation = (value: IcpConversationCorrelation): IcpConversationCorrelation => {
      const parsed = parseIcpConversationCorrelation(value);
      if (parsed.localCompanionId !== localCompanionId
        || parsed.peerCompanionId !== permit.recipientCompanionId
        || parsed.peerContactId !== peerContactId
        || parsed.channelId !== permit.channelId
        || parsed.conversationId !== permit.conversationId
        || parsed.rootInitiationId !== request.rootInitiationId
        || parsed.requestId !== sourceMessageId) {
        throw new Error('Recorded ICP initiation turn does not match the permit binding');
      }
      return parsed;
    };

    const finalizeDelivery = async (): Promise<IcpTargetChannelInitiationResult> => {
      if (lastDeliveryObservation?.status === 'delivered') {
        if (!content.trim()) {
          throw new Error('Delivered ICP observation is missing transport content');
        }
        if (!lastDeliveryObservation.gatewayMessageId || !lastDeliveryObservation.deliveredTo) {
          throw new Error('Delivered ICP observation is missing gateway delivery facts');
        }
        return {
          disposition: 'delivered',
          recoveredTurn,
          correlation,
          gatewayMessageId: lastDeliveryObservation.gatewayMessageId,
          deliveredTo: [...lastDeliveryObservation.deliveredTo],
        };
      }
      if (!content.trim()) {
        if (lastDeliveryObservation?.status !== 'suppressed') {
          if (!turnResponse) {
            throw new Error('ICP suppression finalization requires a durable recovery response');
          }
          if (!(permit.status === 'consumed' && lastDeliveryObservation?.status === 'prepared')) {
            await input.agent.recordIcpDeliveryObservation({
              channelId: permit.channelId,
              sourceMessageId,
              status: 'prepared',
              recoveryResponse: turnResponse,
            });
            const consumption = await input.gateway.consumeInitiationPermit({
              permitId: permit.permitId,
              conversationId: permit.conversationId,
              recipientCompanionId: permit.recipientCompanionId,
              channelId: permit.channelId,
              rootInitiationId: request.rootInitiationId,
            });
            if (consumption.outcome !== 'consumed' && consumption.outcome !== 'replayed') {
              throw new Error(`ICP suppression permit consumption rejected: ${consumption.outcome}`);
            }
          }
          lastDeliveryObservation = {
            channelId: permit.channelId,
            sourceMessageId,
            status: 'suppressed',
            recoveryResponse: turnResponse,
          };
          await input.agent.recordIcpDeliveryObservation(lastDeliveryObservation);
        }
        return { disposition: 'suppressed', recoveredTurn, correlation };
      }

      try {
        if (!turnResponse) {
          throw new Error('ICP delivery finalization requires a durable recovery response');
        }
        if (lastDeliveryObservation?.status !== 'prepared'
          && lastDeliveryObservation?.status !== 'failed') {
          lastDeliveryObservation = {
            channelId: permit.channelId,
            sourceMessageId,
            status: 'prepared',
            recoveryResponse: turnResponse,
          };
          await input.agent.recordIcpDeliveryObservation(lastDeliveryObservation);
        }
        const delivery = await input.gateway.sendInitiation({
          channelId: permit.channelId,
          content,
          ...(input.authorName?.trim() ? { authorName: input.authorName.trim() } : {}),
          permitId: permit.permitId,
          conversationId: permit.conversationId,
          recipientCompanionId: permit.recipientCompanionId,
          correlation,
        });
        lastDeliveryObservation = {
          channelId: permit.channelId,
          sourceMessageId,
          status: 'delivered',
          gatewayMessageId: delivery.messageId,
          deliveredTo: delivery.deliveredTo,
          permitOutcome: delivery.permitOutcome,
          recoveryResponse: turnResponse,
        };
        await input.agent.recordIcpDeliveryObservation(lastDeliveryObservation);
        return {
          disposition: 'delivered',
          recoveredTurn,
          correlation,
          gatewayMessageId: delivery.messageId,
          deliveredTo: delivery.deliveredTo,
        };
      } catch (error) {
        lastDeliveryObservation = {
          channelId: permit.channelId,
          sourceMessageId,
          status: 'failed',
          error: toErrorMessage(error),
          ...(turnResponse ? { recoveryResponse: turnResponse } : {}),
        };
        await input.agent.recordIcpDeliveryObservation(lastDeliveryObservation);
        throw error;
      }
    };

    const markTurnCompleted = async (
      result: IcpTargetChannelInitiationResult,
    ): Promise<IcpTargetChannelInitiationResult> => {
      if (!turnResponse) throw new Error('Completed ICP turn is missing its durable response');
      const completionObservation: IcpDeliveryObservation = result.disposition === 'delivered'
        ? {
            channelId: permit.channelId,
            sourceMessageId,
            status: 'delivered',
            gatewayMessageId: result.gatewayMessageId,
            deliveredTo: result.deliveredTo,
            permitOutcome: lastDeliveryObservation?.permitOutcome,
            recoveryResponse: turnResponse,
            turnCompleted: true,
          }
        : {
            channelId: permit.channelId,
            sourceMessageId,
            status: 'suppressed',
            recoveryResponse: turnResponse,
            turnCompleted: true,
          };
      await input.agent.recordIcpDeliveryObservation(completionObservation);
      lastDeliveryObservation = completionObservation;
      return result;
    };

    const resumeOrdinaryTurn = async (): Promise<IcpTargetChannelInitiationResult> => {
      if (!turnResponse) throw new Error('ICP recovery requires a durable response');
      const finalization: { result?: IcpTargetChannelInitiationResult } = {};
      await input.agent.handleMessage(buildPrivateTurnMessage(correlation), {
        recoveredResponse: turnResponse,
        finalizeDelivery: async (response) => {
          turnResponse = response;
          content = response.content;
          finalization.result = await finalizeDelivery();
        },
      });
      if (!finalization.result) {
        throw new Error('Recovered ICP target turn completed without delivery finalization');
      }
      return await markTurnCompleted(finalization.result);
    };

    if (recorded) {
      correlation = validateRecordedCorrelation(recorded.correlation);
      content = recorded.content;
      const recoveryResponse = previousObservation?.recoveryResponse ?? recorded.recoveryResponse;
      turnResponse = {
          ...recoveryResponse,
          content,
          channelId: permit.channelId,
          metadata: {
            ...recoveryResponse.metadata,
            turnId: correlation.turnId,
            requestId: correlation.requestId,
            icpCorrelation: correlation,
          },
      };
      if (previousObservation?.turnCompleted) {
        if (previousObservation.status === 'suppressed') {
          throw new Error('ICP target-channel initiation was already durably suppressed');
        }
        if (previousObservation.status === 'delivered') {
          return await finalizeDelivery();
        }
      }
      return await resumeOrdinaryTurn();
    }

    if (permit.status === 'consumed') {
      if (!previousObservation?.recoveryResponse
        || (previousObservation.status !== 'prepared'
          && previousObservation.status !== 'suppressed')) {
        throw new Error(
          'Consumed ICP permit is missing durable prepared suppression recovery evidence',
        );
      }
      recoveredTurn = true;
      correlation = validateRecordedCorrelation(
        previousObservation.recoveryResponse.metadata.icpCorrelation,
      );
      turnResponse = previousObservation.recoveryResponse;
      content = turnResponse.content;
      return await resumeOrdinaryTurn();
    }

    {
      recoveredTurn = false;
      correlation = buildCorrelation({
        permit,
        localCompanionId,
        peerContactId,
        rootInitiationId: request.rootInitiationId,
      });
      content = '';
      const finalization: { result?: IcpTargetChannelInitiationResult } = {};
      await input.agent.handleMessage(buildPrivateTurnMessage(correlation), {
        finalizeDelivery: async (response) => {
          turnResponse = response;
          content = response.content;
          if (response.metadata.icpCorrelation) {
            correlation = parseIcpConversationCorrelation(response.metadata.icpCorrelation);
          }
          finalization.result = await finalizeDelivery();
        },
      });
      if (!finalization.result) {
        throw new Error('ICP target-channel turn completed without delivery finalization');
      }
      return await markTurnCompleted(finalization.result);
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
