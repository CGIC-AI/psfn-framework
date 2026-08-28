import type { AgentResponse, SubstrateMessage } from '../../shared/contracts/runtime.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import {
  assertIcpRecoveryStatusBinding,
  type IcpDeliveryObservation,
} from '../../core/session/icp-delivery-recovery.js';
import type { DisclosureLineage } from '../../core/cogsec/disclosure/index.js';
import {
  createTargetHumanRelayReturn,
  type HumanRelayTransportCustody,
} from './human-relay-response-path.js';

interface CompanionReplyDeliveryGatewayPort {
  companionSend(
    channelId: string,
    content: string,
    authorName: string | undefined,
    correlation: NonNullable<AgentResponse['metadata']['icpCorrelation']>,
    humanRelay?: HumanRelayTransportCustody,
  ): Promise<{ messageId: string; deliveredTo: string[] }>;
  companionEndIcpEpisodeActivity(input: {
    conversationId: string;
    reasonCode: 'fatigue_exhausted' | 'charge_pressure' | 'cost_hard_stop'
      | 'inactivity_timeout' | 'conversation_ended';
  }): Promise<unknown>;
}

interface CompanionReplyDeliveryJournalPort {
  recordIcpDeliveryObservation(observation: IcpDeliveryObservation): Promise<void> | void;
}

interface CompanionReplyDeliveryLogger {
  error(message: string, meta?: Record<string, unknown>): void;
}

export class CompanionReplyDeliveryError extends Error {
  constructor(cause: unknown) {
    super(`Companion reply delivery failed: ${toErrorMessage(cause)}`, { cause });
    this.name = 'CompanionReplyDeliveryError';
  }
}

export interface CompanionReplyDeliveryLifecycle {
  recoveredResponse?: AgentResponse;
  sourceAlreadyPersisted?: true;
  finalizeDelivery(response: AgentResponse): Promise<void>;
  markTurnCompleted(): Promise<void>;
}

/**
 * Owns the durable write-ahead/delivery/completion protocol for one correlated
 * companion reply. Transport is at-least-once under a lost acknowledgement;
 * the deterministic gateway message id plus the recipient's durable source
 * envelope binding are the cross-process idempotency boundary.
 */
export function createCompanionReplyDeliveryLifecycle(input: {
  message: SubstrateMessage;
  recoveredResponse?: AgentResponse;
  previousObservation?: IcpDeliveryObservation | null;
  sourceAlreadyPersisted?: boolean;
  agent: CompanionReplyDeliveryJournalPort;
  gateway: CompanionReplyDeliveryGatewayPort;
  authorName?: string;
  log: CompanionReplyDeliveryLogger;
  localCompanionId: string;
  getDisclosureLineage(): DisclosureLineage | undefined;
  now?: () => number;
}): CompanionReplyDeliveryLifecycle {
  let deliveryObservation = input.previousObservation ?? null;
  let recoveryResponse = input.recoveredResponse;
  return {
    ...(input.recoveredResponse ? { recoveredResponse: input.recoveredResponse } : {}),
    ...(input.sourceAlreadyPersisted ? { sourceAlreadyPersisted: true as const } : {}),
    async finalizeDelivery(response: AgentResponse): Promise<void> {
      recoveryResponse = response;
      const correlation = response.metadata.icpCorrelation;
      if (!correlation) {
        throw new Error('Correlated companion reply is missing response ICP correlation');
      }
      assertIcpRecoveryStatusBinding(
        deliveryObservation?.status,
        response,
        'Companion reply delivery',
      );
      if (deliveryObservation?.status === 'delivered') {
        return;
      }
      if (!response.content.trim()) {
        if (deliveryObservation?.status !== 'suppressed') {
          deliveryObservation = {
            channelId: input.message.channelId,
            sourceMessageId: input.message.id,
            status: 'suppressed',
            recoveryResponse: response,
          };
          await input.agent.recordIcpDeliveryObservation(deliveryObservation);
        }
        const terminalReason = response.metadata.noReply
          ? 'conversation_ended'
          : correlation.fatigueReasonCode;
        if (terminalReason === 'fatigue_exhausted'
          || terminalReason === 'charge_pressure'
          || terminalReason === 'cost_hard_stop'
          || terminalReason === 'inactivity_timeout'
          || terminalReason === 'conversation_ended') {
          await input.gateway.companionEndIcpEpisodeActivity({
            conversationId: correlation.conversationId,
            reasonCode: terminalReason,
          });
        }
        return;
      }

      let humanRelay: HumanRelayTransportCustody | undefined;
      if (input.message.routing?.humanRelay) {
        const relay = await createTargetHumanRelayReturn({
          message: input.message,
          response,
          localCompanionId: input.localCompanionId,
          lineage: input.getDisclosureLineage(),
          nowMs: input.now?.() ?? Date.now(),
        });
        if (relay.delivery === 'withheld') {
          deliveryObservation = {
            channelId: input.message.channelId,
            sourceMessageId: input.message.id,
            status: 'suppressed',
            recoveryResponse: response,
          };
          await input.agent.recordIcpDeliveryObservation(deliveryObservation);
          return;
        }
        humanRelay = relay.custody;
      }

      let delivery: Awaited<ReturnType<CompanionReplyDeliveryGatewayPort['companionSend']>>;
      try {
        if (deliveryObservation?.status !== 'prepared'
          && deliveryObservation?.status !== 'failed') {
          deliveryObservation = {
            channelId: input.message.channelId,
            sourceMessageId: input.message.id,
            status: 'prepared',
            recoveryResponse: response,
          };
          await input.agent.recordIcpDeliveryObservation(deliveryObservation);
        }
        delivery = humanRelay
          ? await input.gateway.companionSend(
            input.message.channelId, response.content, input.authorName, correlation, humanRelay,
          )
          : await input.gateway.companionSend(
            input.message.channelId, response.content, input.authorName, correlation,
          );
      } catch (error) {
        try {
          deliveryObservation = {
            channelId: input.message.channelId,
            sourceMessageId: input.message.id,
            status: 'failed',
            error: toErrorMessage(error),
            recoveryResponse: response,
          };
          await input.agent.recordIcpDeliveryObservation(deliveryObservation);
        } catch (observationError) {
          input.log.error('Failed to persist companion reply delivery failure', {
            channelId: input.message.channelId,
            messageId: input.message.id,
            deliveryError: toErrorMessage(error),
            observationError: toErrorMessage(observationError),
          });
        }
        throw new CompanionReplyDeliveryError(error);
      }
      deliveryObservation = {
        channelId: input.message.channelId,
        sourceMessageId: input.message.id,
        status: 'delivered',
        gatewayMessageId: delivery.messageId,
        deliveredTo: delivery.deliveredTo,
        recoveryResponse: response,
      };
      await input.agent.recordIcpDeliveryObservation(deliveryObservation);
    },
    async markTurnCompleted(): Promise<void> {
      if (!deliveryObservation || !recoveryResponse) {
        throw new Error('Companion reply turn completed without durable delivery state');
      }
      const completedObservation: IcpDeliveryObservation = {
        ...deliveryObservation,
        recoveryResponse,
        turnCompleted: true,
      };
      await input.agent.recordIcpDeliveryObservation(completedObservation);
      deliveryObservation = completedObservation;
    },
  };
}
