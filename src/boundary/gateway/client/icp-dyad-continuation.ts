import type { IcpConversationCorrelation, IcpDyadDelivery } from '../../../shared/contracts/icp-autonomy.js';
import { deriveIcpTransportMessageId } from '../../../shared/contracts/icp-autonomy.js';
import type { IcpDyadContinuationAuthorization, IcpDyadContinuationPrepareResult, IcpOpenDyadProjection } from '../icp-autonomy-contract.js';
import type { CompanionMessageSendResult, GatewayMethods } from '../protocol.js';
import type { GatewayClientTransportRuntime } from './transport-runtime.js';

export async function companionSendContinuation(
  transportRuntime: GatewayClientTransportRuntime,
  companionId: string | undefined,
  input: {
    authorization: IcpDyadContinuationAuthorization;
    peerContactId: string;
    content: string;
    authorName?: string;
    correlation: IcpConversationCorrelation;
  },
): Promise<{ messageId: string; deliveredTo: string[]; duplicate: boolean }> {
  const messageId = deriveIcpTransportMessageId(input.correlation);
  const result = await transportRuntime.request('companion.message.send', {
    channelId: input.authorization.channelId,
    content: input.content,
    ...(input.authorName ? { authorName: input.authorName } : {}),
    continuation: {
      dyadId: input.authorization.dyadId,
      deliveryId: input.authorization.deliveryId,
      recipientCompanionId: input.authorization.peerCompanionId,
      peerContactId: input.peerContactId,
      correlation: input.correlation,
    },
    messageId,
    ...(companionId ? { companionId } : {}),
  }) as CompanionMessageSendResult;
  return {
    messageId: result.messageId,
    deliveredTo: result.deliveredTo,
    duplicate: false,
  };
}

export async function companionListOpenDyads(
  transportRuntime: GatewayClientTransportRuntime,
  companionId: string | undefined,
): Promise<IcpOpenDyadProjection[]> {
  return await transportRuntime.request('companion.dyad.list_open', {
    ...(companionId ? { companionId } : {}),
  }) as IcpOpenDyadProjection[];
}

export async function companionPrepareDyadContinuation(
  transportRuntime: GatewayClientTransportRuntime,
  companionId: string | undefined,
  params: Omit<GatewayMethods['companion.dyad.prepare_continuation'][0], 'companionId'>,
): Promise<IcpDyadContinuationPrepareResult> {
  return await transportRuntime.request('companion.dyad.prepare_continuation', {
    ...params,
    ...(companionId ? { companionId } : {}),
  }) as IcpDyadContinuationPrepareResult;
}

export async function companionRecordDyadContinuationOutcome(
  transportRuntime: GatewayClientTransportRuntime,
  companionId: string | undefined,
  params: Omit<GatewayMethods['companion.dyad.record_outcome'][0], 'companionId'>,
): Promise<IcpDyadDelivery> {
  return await transportRuntime.request('companion.dyad.record_outcome', {
    ...params,
    ...(companionId ? { companionId } : {}),
  }) as IcpDyadDelivery;
}
