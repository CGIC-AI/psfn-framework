import type {
  DiscordSendParams,
  DiscordSendMediaParams,
  DiscordTypingParams,
  DiscordAvailabilityParams,
} from '../protocol.js';
import type { AuditedMethodDescriptor, GatewayMethodRuntime } from './types.js';
import { registerAuditedDescriptors } from './register.js';
import { materializeGatewayAttachment } from '../attachment-materialization.js';

const discordDescriptors: Array<AuditedMethodDescriptor<any, unknown>> = [
  {
    name: 'discord.send',
    handler: async (params: DiscordSendParams, runtime) => {
      await runtime.discordAdapter.outbound.sendText(
        { channelId: params.channelId },
        params.content,
      );
      return { success: true };
    },
    summary: (p: DiscordSendParams) => ({ channelId: p.channelId }),
  },
  {
    name: 'discord.sendMedia',
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
  },
  {
    name: 'discord.typing',
    handler: async (_params: DiscordTypingParams) => ({ success: true }),
  },
  {
    name: 'discord.availability',
    handler: async (params: DiscordAvailabilityParams, runtime) => {
      const state: unknown = params.state;
      if (state !== 'available'
        && state !== 'idle'
        && state !== 'do_not_disturb') {
        throw new Error('discord.availability state must be available, idle, or do_not_disturb');
      }
      return {
        status: runtime.discordAdapter.availability
          ? await runtime.discordAdapter.availability.setAvailability(state)
          : 'unsupported',
      };
    },
    summary: (params: DiscordAvailabilityParams) => ({ state: params.state }),
  },
];

export function registerDiscordMethods(runtime: GatewayMethodRuntime): void {
  registerAuditedDescriptors(runtime, discordDescriptors);
}
