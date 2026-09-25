// `channel.sendRoomReply` (psfn-framework-ze2fx): delivery of an appraised,
// egress-leased autonomous room reply on Telegram or an external channel. The
// audit summary is content-free (channel type and id only).

import { JSONRPCErrorException } from 'json-rpc-2.0';
import { GatewayErrors, type ChannelSendRoomReplyParams } from '../protocol.js';
import { RoomReplyOutboundRefusedError } from '../room-reply-outbound.js';
import { gatewayMethodParamDecoders } from './params.js';
import { registerAuditedDescriptors } from './register.js';
import { defineAuditedMethod, type GatewayMethodRuntime } from './types.js';

export function registerChannelRoomReplyMethod(runtime: GatewayMethodRuntime): void {
  registerAuditedDescriptors(runtime, [
    defineAuditedMethod({
      name: 'channel.sendRoomReply',
      decode: gatewayMethodParamDecoders['channel.sendRoomReply'],
      handler: async (params: ChannelSendRoomReplyParams, methodRuntime) => {
        const outbound = methodRuntime.roomReplyOutbound;
        if (!outbound) {
          throw new JSONRPCErrorException('Room reply outbound is not wired', GatewayErrors.POLICY_DENIED);
        }
        try {
          await outbound.send({
            channelType: params.channelType,
            channelId: params.channelId,
            content: params.content,
            companionId: methodRuntime.authenticatedCompanionId(),
          });
        } catch (error) {
          if (error instanceof RoomReplyOutboundRefusedError) {
            throw new JSONRPCErrorException(error.message, GatewayErrors.POLICY_DENIED);
          }
          throw error;
        }
        return { success: true };
      },
      summary: (p: ChannelSendRoomReplyParams) => ({ channelType: p.channelType, channelId: p.channelId }),
    }),
  ]);
}
