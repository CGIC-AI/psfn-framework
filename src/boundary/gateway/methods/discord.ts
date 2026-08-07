import type {
  DiscordSendParams,
  DiscordSendMediaParams,
  DiscordTypingParams,
  DiscordAvailabilityParams,
} from '../protocol.js';
import { defineAuditedMethod, type GatewayMethodRuntime } from './types.js';
import { registerAuditedDescriptors } from './register.js';
import { materializeGatewayAttachment } from '../attachment-materialization.js';
import { gatewayMethodParamDecoders } from './params.js';
import { enumSchema, gatewayDecoder, strictObject } from './params/schema.js';

const discordDescriptors = [
  defineAuditedMethod({
    name: 'discord.send',
    decode: gatewayMethodParamDecoders['discord.send'],
    handler: async (params: DiscordSendParams, runtime) => {
      await runtime.discordAdapter.outbound.sendText(
        { channelId: params.channelId },
        params.content,
      );
      return { success: true };
    },
    summary: (p: DiscordSendParams) => ({ channelId: p.channelId }),
  }),
  defineAuditedMethod({
    name: 'discord.sendMedia',
    decode: gatewayMethodParamDecoders['discord.sendMedia'],
    handler: async (params: DiscordSendMediaParams, runtime) => {
      const media = materializeGatewayAttachment(params.media, runtime.workspacePath);
      await runtime.discordAdapter.outbound.sendMedia?.(
        { channelId: params.channelId },
        media,
      );
      return { success: true };
    },
    summary: (p: DiscordSendMediaParams) => ({
      channelId: p.channelId,
      mediaName: p.media.name,
    }),
  }),
  defineAuditedMethod({
    name: 'discord.typing',
    decode: gatewayMethodParamDecoders['discord.typing'],
    handler: async (_params: DiscordTypingParams) => ({ success: true }),
  }),
  defineAuditedMethod({
    name: 'discord.availability',
    decode: gatewayDecoder('discord.availability', strictObject({
      state: enumSchema(['available', 'idle', 'do_not_disturb']),
    })),
    handler: async (params: DiscordAvailabilityParams, runtime) => ({
      status: runtime.discordAdapter.availability
        ? await runtime.discordAdapter.availability.setAvailability(params.state)
        : 'unsupported',
    }),
    summary: (p: DiscordAvailabilityParams) => ({ state: p.state }),
  }),
];

export function registerDiscordMethods(runtime: GatewayMethodRuntime): void {
  registerAuditedDescriptors(runtime, discordDescriptors);
}
