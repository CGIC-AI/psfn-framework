import type { ChannelSendParams } from '../protocol.js';
import { gatewayMethodParamDecoders } from './params.js';
import { registerAuditedDescriptors } from './register.js';
import { defineAuditedMethod, type GatewayMethodRuntime } from './types.js';

const channelDescriptors = [
  defineAuditedMethod({
    name: 'channel.send',
    decode: gatewayMethodParamDecoders['channel.send'],
    handler: async (params: ChannelSendParams, runtime) => {
      await runtime.resolveChannelOutboundDock(params.channelType).outbound.sendText(
        { channelId: params.channelId },
        params.content,
      );
      return { success: true };
    },
    summary: (params: ChannelSendParams) => ({
      channelType: params.channelType,
      channelId: params.channelId,
    }),
  }),
];

export function registerChannelMethods(runtime: GatewayMethodRuntime): void {
  registerAuditedDescriptors(runtime, channelDescriptors);
}
